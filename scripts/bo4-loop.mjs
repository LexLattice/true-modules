#!/usr/bin/env node
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  ensureDir,
  updateManifest,
  manifestPath,
  relativize,
  nowIso
} from './lib/headless-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function usage() {
  console.error('Usage: node scripts/bo4-loop.mjs --task <id> --coverage <file> [--run-dir <dir>] [--profile <name>] [--weights <file>] [--variant <n>]');
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

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function defaultRunDir(taskId) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(taskId);
  return path.join(repoRoot, 'runs', `${date}-${slug || 'task'}`);
}

function runStep(cmd, args, { env = {}, label }) {
  return new Promise((resolve, reject) => {
    if (label) {
      console.log(`\n::group::${label}`);
    }
    const child = spawn(cmd, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, ...env }
    });
    child.on('error', err => {
      if (label) console.log('::endgroup::');
      reject(err);
    });
    child.on('exit', code => {
      if (label) console.log('::endgroup::');
      if (code === 0) resolve();
      else reject(new Error(`${label || cmd} exited with code ${code}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const task = args.task || args.positional[0];
  const coverage = args.coverage;
  const profile = args.profile;
  const weights = args.weights;
  const runDir = path.resolve(args['run-dir'] || args.runDir || defaultRunDir(task || 'task'));
  const variant = args.variant;
  const intervalMs = args['interval-ms'];
  const watchTimeout = args['watch-timeout-ms'];

  if (!task || !coverage) usage();

  await ensureDir(runDir);
  await updateManifest(runDir, manifest => ({
    ...manifest,
    task_id: task,
    run_id: manifest.run_id || `watch:${task}`,
    created_at: manifest.created_at || nowIso(),
    artifacts: manifest.artifacts || {}
  }));

  const watchArgs = [
    path.join(repoRoot, 'scripts', 'codex-watch.mjs'),
    task,
    '--run-dir', runDir
  ];
  if (intervalMs) {
    watchArgs.push('--interval-ms', intervalMs);
  }
  if (watchTimeout) {
    watchArgs.push('--timeout-ms', watchTimeout);
  }

  const harvestArgs = [
    path.join(repoRoot, 'scripts', 'bo4-harvest.mjs'),
    task,
    '--run-dir', runDir
  ];

  const metaArgs = [
    path.join(repoRoot, 'scripts', 'bo4-meta-run.mjs'),
    '--run-dir', runDir,
    '--coverage', path.resolve(coverage)
  ];
  if (variant) {
    metaArgs.push('--variant', variant);
  }
  if (profile) {
    metaArgs.push('--profile', profile);
  }
  if (weights) {
    metaArgs.push('--weights', path.resolve(weights));
  }

  const composeArgs = [
    path.join(repoRoot, 'scripts', 'bo4-compose.mjs'),
    '--run-dir', runDir
  ];
  if (variant) {
    composeArgs.push('--variant', variant);
  }

  const env = { CODEX_BIN: process.env.CODEX_BIN || 'codex' };

  await runStep(process.execPath, watchArgs, { env, label: 'codex watch' });
  await runStep(process.execPath, harvestArgs, { env, label: 'harvest variants' });
  await runStep(process.execPath, metaArgs, { env, label: 'meta compose' });
  await runStep(process.execPath, composeArgs, { env, label: 'compose + gates' });

  const manifestRel = relativize(manifestPath(runDir));
  console.log(`\nHeadless run complete → ${manifestRel}`);
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
