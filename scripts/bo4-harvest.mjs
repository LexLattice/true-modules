#!/usr/bin/env node
import fsp from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  ensureDir,
  updateManifest,
  relativize,
  nowIso
} from './lib/headless-utils.mjs';
import { tmError } from './lib/provider-analysis.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function usage() {
  console.error('Usage: node scripts/bo4-harvest.mjs <task_id> --run-dir <dir>');
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
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => reject(err));
    child.on('exit', code => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error(stderr.trim() || stdout.trim() || `Exit ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.exitCode = code;
        reject(error);
      }
    });
  });
}

function parseJson(data, fallback) {
  try {
    return JSON.parse(data);
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

function listVariants(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.variants)) return payload.variants;
  return [];
}

function variantIndex(entry) {
  return entry?.variant_index ?? entry?.variantIndex ?? entry?.index ?? entry?.id;
}

function isReadyVariant(entry) {
  const status = (entry?.status || entry?.state || '').toLowerCase();
  return status === 'ready' || status === 'completed' || status === 'complete';
}

async function collectModules(modulesDir, variantTag) {
  async function traverse(dirPath, found) {
    let entries;
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        throw tmError('E_VARIANT_NO_MODULES', `Variant ${variantTag} missing modules/ directory (${relativize(modulesDir)})`);
      }
      throw err;
    }

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await traverse(entryPath, found);
      } else if (entry.isFile() && entry.name === 'module.json') {
        try {
          const raw = await fsp.readFile(entryPath, 'utf8');
          const data = JSON.parse(raw);
          const id = data?.id || data?.name || relativize(entryPath);
          found.push({ id, path: entryPath });
        } catch (err) {
          throw tmError('E_VARIANT_NO_MODULES', `Variant ${variantTag} has unreadable module.json (${relativize(entryPath)})`);
        }
      }
    }
  }

  const discovered = [];
  await traverse(modulesDir, discovered);
  if (discovered.length === 0) {
    throw tmError('E_VARIANT_NO_MODULES', `Variant ${variantTag} contains no module.json files (${relativize(modulesDir)})`);
  }
  return discovered;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const taskId = args.positional[0] || args.task;
  const runDirArg = args['run-dir'] || args.runDir;
  if (!taskId || !runDirArg) usage();

  const runDir = path.resolve(runDirArg);
  await ensureDir(runDir);
  const variantsRoot = path.join(runDir, 'variants');
  await ensureDir(variantsRoot);

  const codexBin = process.env.CODEX_BIN || 'codex';
  const { stdout: showOut } = await runCmd(codexBin, ['cloud', 'show', taskId, '--json', '--all']);
  const showPayload = parseJson(showOut, {});
  const variants = listVariants(showPayload).filter(isReadyVariant);

  if (variants.length === 0) {
    console.warn(`No ready variants for task ${taskId}`);
  }

  const harvested = [];

  for (const variant of variants) {
    const index = variantIndex(variant);
    if (index === undefined || index === null) continue;
    const variantDir = path.join(variantsRoot, `var${index}`);
    await fsp.rm(variantDir, { recursive: true, force: true });
    await ensureDir(variantDir);

    console.log(`Exporting variant ${index} → ${relativize(variantDir)}`);
    await runCmd(codexBin, ['cloud', 'export', '--variant', String(index), '--dir', variantDir, taskId]);

    const modulesDir = path.join(variantDir, 'modules');
    const harvestedModules = await collectModules(modulesDir, `var${index}`);

    const metadataPath = path.join(variantDir, 'variant.json');
    await fsp.writeFile(metadataPath, JSON.stringify(variant, null, 2));

    let diffRel = null;
    try {
      const { stdout: diffOut } = await runCmd(codexBin, ['cloud', 'diff', '--variant', String(index), taskId]);
      const diffPath = path.join(variantDir, 'diff.patch');
      await fsp.writeFile(diffPath, diffOut);
      diffRel = relativize(diffPath);
    } catch (err) {
      // diff is optional; log but continue
      console.warn(`codex cloud diff failed for var${index}: ${err.message || err}`);
    }

    harvested.push({
      variant: index,
      status: variant.status || variant.state || 'ready',
      dir: relativize(variantDir),
      modules_dir: relativize(modulesDir),
      metadata: relativize(metadataPath),
      diff: diffRel,
      modules: {
        count: harvestedModules.length,
        ids: harvestedModules.map(mod => mod.id).sort()
      }
    });
  }

  await updateManifest(runDir, manifest => {
    const next = { ...manifest };
    next.task_id = next.task_id || taskId;
    next.variants = harvested;
    next.harvest = {
      completed_at: nowIso(),
      variants: harvested.length,
      modules: harvested.reduce((sum, entry) => sum + (entry.modules?.count || 0), 0)
    };
    return next;
  });
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(err?.code === 'E_VARIANT_NO_MODULES' ? 2 : 1);
});
