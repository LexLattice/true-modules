#!/usr/bin/env node
import fsp from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  ensureDir,
  updateManifest,
  loadManifest,
  eventsPath,
  readNdjson,
  writeNdjson,
  sha256File,
  nowIso,
  relativize
} from './lib/headless-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function usage() {
  console.error('Usage: node scripts/bo4-meta-run.mjs --run-dir <dir> --coverage <file> [--profile <name>] [--weights <file>]');
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
        error.exitCode = code;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function loadJson(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function copyCoverage(src, dest) {
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(src, dest);
}

function metaEventsPath(runDir) {
  return path.join(runDir, 'meta', 'meta.events.ndjson');
}

function metaCoveragePath(runDir) {
  return path.join(runDir, 'meta', 'coverage.json');
}

function metaComposePath(runDir) {
  return path.join(runDir, 'meta', 'compose.json');
}

function metaReportPath(runDir) {
  return path.join(runDir, 'meta', 'report.json');
}

async function extractPicks(events) {
  const picks = [];
  for (const event of events) {
    if (event?.event !== 'META_PICK') continue;
    if (event.detail) {
      picks.push({
        module: event.detail.module,
        gain: event.detail.gain,
        drivers: event.detail.drivers,
        profile: event.detail.profile
      });
    }
  }
  return picks;
}

function normalizeVariantId(value) {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  return Number.isNaN(num) ? String(value) : num;
}

function matchVariantFromCompose(manifest, compose) {
  const variants = manifest?.variants || [];
  if (!variants.length) return null;

  const composeIds = (compose?.modules || [])
    .map(mod => mod?.id)
    .filter(Boolean);
  if (!composeIds.length) return null;
  const composeSet = new Set(composeIds);

  const candidates = variants
    .map(entry => {
      const ids = entry?.modules?.ids || [];
      if (!ids.length) return null;
      const idSet = new Set(ids);
      const missing = composeIds.filter(id => !idSet.has(id));
      if (missing.length) return null;
      const extras = ids.filter(id => !composeSet.has(id));
      return { entry, extras: extras.length };
    })
    .filter(Boolean);

  if (!candidates.length) return null;

  candidates.sort((a, b) => a.extras - b.extras);
  const best = candidates.filter(c => c.extras === candidates[0].extras);
  if (best.length === 1) {
    const chosen = best[0].entry;
    const extraNote = best[0].extras
      ? ` (ignored ${best[0].extras} extra module${best[0].extras === 1 ? '' : 's'})`
      : '';
    return {
      variant: normalizeVariantId(chosen.variant),
      rationale: `auto-selected variant var${chosen.variant} from compose module set${extraNote}`
    };
  }

  return null;
}

function selectVariant(manifest, compose, variantOverride) {
  const variants = manifest?.variants || [];
  if (!variants.length) {
    throw new Error('No harvested variants found in run manifest. Run bo4-harvest before meta.');
  }

  if (variantOverride !== undefined) {
    const entry = variants.find(v => String(v.variant) === String(variantOverride));
    if (!entry) {
      throw new Error(`Requested variant ${variantOverride} not found in manifest`);
    }
    return {
      variant: normalizeVariantId(entry.variant),
      rationale: `cli override (--variant ${variantOverride})`
    };
  }

  const inferred = matchVariantFromCompose(manifest, compose);
  if (!inferred) {
    throw new Error('Unable to determine winning variant from meta output. Provide --variant explicitly.');
  }
  return inferred;
}

async function rewriteWatchEvents(runDir, runId, composeSha) {
  const watchPath = eventsPath(runDir);
  const existing = await readNdjson(watchPath);
  if (!existing.length) return;
  const rewritten = existing.map(evt => ({
    ...evt,
    context: {
      ...(evt.context || {}),
      run_id: runId,
      compose_sha256: composeSha,
      mode: evt.context?.mode || 'shipping'
    }
  }));
  await writeNdjson(watchPath, rewritten);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDirArg = args['run-dir'] || args.runDir;
  const coverageArg = args.coverage;
  const profile = args.profile;
  const weights = args.weights;
  const variantArg = args.variant;

  if (!runDirArg || !coverageArg) usage();

  const runDir = path.resolve(runDirArg);
  const coverageSrc = path.resolve(coverageArg);
  const metaDir = path.join(runDir, 'meta');
  await ensureDir(metaDir);

  const coverageCopy = metaCoveragePath(runDir);
  await copyCoverage(coverageSrc, coverageCopy);

  const composeOut = metaComposePath(runDir);
  const eventsOut = metaEventsPath(runDir);

  const metaArgs = [
    path.join(repoRoot, 'tm.mjs'),
    'meta',
    '--coverage', coverageCopy,
    '--out', composeOut,
    '--emit-events',
    '--events-out', eventsOut,
    '--events-truncate',
    '--strict-events'
  ];
  if (profile) {
    metaArgs.push('--profile', profile);
  }
  if (weights) {
    metaArgs.push('--weights', path.resolve(weights));
  }

  await runCmd(process.execPath, metaArgs, { cwd: repoRoot });

  const compose = await loadJson(composeOut);
  const composeSha = await sha256File(composeOut);
  const metaEvents = await readNdjson(eventsOut);
  const picks = await extractPicks(metaEvents);
  const coverage = await loadJson(coverageCopy);

  const manifest = await loadManifest(runDir);
  const selection = selectVariant(manifest, compose, variantArg);

  const report = {
    task_id: compose.task_id || null,
    run_id: compose.run_id,
    compose_sha256: composeSha,
    generated_at: nowIso(),
    coverage: {
      source: relativize(coverageCopy),
      goals: coverage.goals || []
    },
    picks
  };
  const reportPath = metaReportPath(runDir);
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2));

  await rewriteWatchEvents(runDir, compose.run_id, composeSha);

  await updateManifest(runDir, manifest => {
    const next = { ...manifest };
    next.task_id = next.task_id || manifest.task_id;
    next.run_id = compose.run_id;
    next.compose_sha256 = composeSha;
    next.meta = {
      coverage: relativize(coverageCopy),
      compose: relativize(composeOut),
      report: relativize(reportPath),
      events: relativize(eventsOut)
    };
    if (selection) {
      const existingSelection = manifest.selection || {};
      next.selection = {
        ...existingSelection,
        variant: selection.variant,
        rationale: selection.rationale,
        recorded_at: nowIso()
      };
    }
    next.updated_at = nowIso();
    return next;
  });
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
