#!/usr/bin/env node
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  ensureDir,
  loadManifest,
  updateManifest,
  eventsPath,
  readNdjson,
  writeNdjson,
  resequenceEvents,
  relativize,
  nowIso
} from './lib/headless-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function usage() {
  console.error('Usage: node scripts/bo4-compose.mjs --run-dir <dir> [--variant <n>]');
  process.exit(1);
}

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['inherit', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => reject(err));
    child.on('exit', code => {
      if (code === 0) resolve({ stderr });
      else {
        const error = new Error(stderr.trim() || `Exit ${code}`);
        error.stderr = stderr;
        error.exitCode = code;
        reject(error);
      }
    });
  });
}

function resolveVariant(manifest, requestedVariant) {
  const variants = manifest?.variants || [];
  if (!variants.length) {
    throw new Error('No harvested variants available. Run bo4-harvest first.');
  }

  const selected = manifest?.selection?.variant;
  if (selected === undefined || selected === null) {
    throw new Error('run.json.selection.variant missing. Run bo4-meta-run to record the winning variant.');
  }

  if (requestedVariant !== undefined && String(requestedVariant) !== String(selected)) {
    throw new Error(`Variant mismatch: manifest selection is ${selected} but --variant ${requestedVariant} was provided`);
  }

  const entry = variants.find(v => String(v.variant) === String(selected));
  if (!entry) {
    throw new Error(`Selected variant ${selected} not found in manifest. Re-run bo4-harvest.`);
  }
  return entry;
}

function absoluteFromRelative(p) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  return path.resolve(repoRoot, p);
}

function firstFailure(events) {
  return events.find(evt => typeof evt?.event === 'string' && evt.event.endsWith('_FAIL')) || null;
}

function describeFailure(evt, gatesEventsPath) {
  if (!evt) return `Gates failed. Inspect ${gatesEventsPath}`;
  const detail = evt.detail || {};
  const parts = [evt.event];
  if (detail.code) parts.push(detail.code);
  if (detail.module) parts.push(detail.module);
  if (detail.test) parts.push(detail.test);
  if (detail.message) parts.push(detail.message);
  const artifact = detail.artifact ? detail.artifact : gatesEventsPath;
  parts.push(`See ${artifact}`);
  return parts.filter(Boolean).join(' · ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDirArg = args['run-dir'] || args.runDir;
  const variantArg = args.variant;
  if (!runDirArg) usage();

  const runDir = path.resolve(runDirArg);
  const manifest = await loadManifest(runDir);
  const variantEntry = resolveVariant(manifest, variantArg);
  const composePath = path.join(runDir, 'meta', 'compose.json');
  const winnerDir = path.join(runDir, 'winner');
  await ensureDir(winnerDir);

  const fallbackModules = path.join(runDir, 'variants', `var${variantEntry.variant}`, 'modules');
  const modulesDir = absoluteFromRelative(variantEntry.modules_dir) || fallbackModules;
  if (!modulesDir) {
    throw new Error(`Variant ${variantEntry.variant} missing modules_dir in manifest.`);
  }

  const composeArgs = [
    path.join(repoRoot, 'tm.mjs'),
    'compose',
    '--compose', composePath,
    '--modules-root', modulesDir,
    '--out', winnerDir
  ];

  await runCmd(process.execPath, composeArgs, { cwd: repoRoot });

  const gatesEventsPath = path.join(runDir, 'artifacts', 'events.gates.ndjson');
  const watchBackupPath = path.join(runDir, 'artifacts', 'events.watch.ndjson');
  const existingWatchEvents = await readNdjson(eventsPath(runDir));
  if (existingWatchEvents.length) {
    await writeNdjson(watchBackupPath, existingWatchEvents);
  }

  const gatesArgs = [
    path.join(repoRoot, 'tm.mjs'),
    'gates', 'shipping',
    '--compose', composePath,
    '--modules-root', modulesDir,
    '--emit-events',
    '--events-out', gatesEventsPath,
    '--events-truncate',
    '--strict-events'
  ];

  let gatesFailed = false;
  try {
    await runCmd(process.execPath, gatesArgs, { cwd: repoRoot });
  } catch (err) {
    gatesFailed = true;
    console.error(err?.message || String(err));
  }

  const gatesEvents = await readNdjson(gatesEventsPath);
  const gatingContext = gatesEvents[0]?.context || null;
  const normalizedWatchEvents = existingWatchEvents.map(evt => {
    if (!gatingContext) return evt;
    const updatedContext = {
      ...(evt.context || {}),
      compose_sha256: gatingContext.compose_sha256,
      run_id: gatingContext.run_id
    };
    return { ...evt, context: updatedContext };
  });
  const merged = [
    ...resequenceEvents(normalizedWatchEvents, 0),
    ...resequenceEvents(gatesEvents, normalizedWatchEvents.length)
  ];
  await writeNdjson(eventsPath(runDir), merged);

  await updateManifest(runDir, current => {
    const next = { ...current };
    const selection = current.selection || {};
    next.selection = {
      ...selection,
      variant: variantEntry.variant,
      confirmed_at: nowIso()
    };
    next.winner = {
      dir: relativize(winnerDir),
      generated_at: nowIso()
    };
    next.gates = {
      events: relativize(eventsPath(runDir)),
      raw_events: relativize(gatesEventsPath),
      variant: variantEntry.variant,
      completed_at: nowIso(),
      status: gatesFailed ? 'failed' : 'passed'
    };
    return next;
  });

  if (gatesFailed) {
    const failure = firstFailure(gatesEvents);
    const message = describeFailure(failure, relativize(gatesEventsPath));
    throw new Error(message);
  }
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
