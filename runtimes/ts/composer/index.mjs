#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { tmError, analyzeProviders } from '../../../scripts/lib/provider-analysis.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = new Map(
  process.argv.slice(2).reduce((acc, value, idx, arr) => {
    if (!value.startsWith('--')) return acc;
    return acc.concat([[value.slice(2), arr[idx + 1]]]);
  }, [])
);

const composePath = path.resolve(args.get('compose') || './compose.json');
const modulesRoot = path.resolve(args.get('modules-root') || './modules');
const glueRoot = path.resolve(args.get('glue-root') || './glue-catalog');
const outDir = path.resolve(args.get('out') || './winner');

async function readJSON(p) {
  const txt = await fs.readFile(p, 'utf8');
  return JSON.parse(txt);
}

function manifestPath(root, id) {
  return path.join(root, id, 'module.json');
}

async function listDirEntries(root, prefix = '') {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    const relNormalized = rel.replace(/\\/g, '/');
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push({ type: 'dir', rel: relNormalized });
      const nested = await listDirEntries(abs, rel);
      result.push(...nested);
    } else if (entry.isSymbolicLink && entry.isSymbolicLink()) {
      let target = '';
      try {
        target = await fs.readlink(abs);
      } catch {}
      result.push({ type: 'symlink', rel: relNormalized, target });
    } else if (entry.isFile()) {
      result.push({ type: 'file', rel: relNormalized, abs });
    }
  }
  return result;
}

async function hashDir(root) {
  const hash = crypto.createHash('sha256');
  let entries = [];
  try {
    entries = await listDirEntries(root);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  for (const entry of entries) {
    hash.update(`${entry.type}:${entry.rel}`);
    if (entry.type === 'file') {
      const buf = await fs.readFile(entry.abs);
      hash.update(buf);
    } else if (entry.type === 'symlink') {
      hash.update(String(entry.target || ''));
    }
  }
  return hash.digest('hex');
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  if (fs.cp) {
    await fs.cp(src, dst, { recursive: true });
  } else {
    const { execSync } = await import('child_process');
    execSync(`cp -R "${src}/." "${dst}"`);
  }
}

async function loadCopyCache(outDir) {
  const cacheDir = path.join(outDir, '.tm');
  const cachePath = path.join(cacheDir, 'copy-hashes.json');
  try {
    const txt = await fs.readFile(cachePath, 'utf8');
    return { path: cachePath, dir: cacheDir, data: JSON.parse(txt) || {}, dirty: false };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { path: cachePath, dir: cacheDir, data: {}, dirty: false };
    }
    throw err;
  }
}

async function saveCopyCache(cache) {
  if (!cache?.dirty) return;
  await fs.mkdir(cache.dir, { recursive: true });
  await fs.writeFile(cache.path, JSON.stringify(cache.data, null, 2));
}

async function syncDir({ kind, id, src, dst, cache, activeKeys }) {
  const key = `${kind}:${id}`;
  activeKeys.add(key);
  const srcHash = await hashDir(src);
  if (!srcHash) {
    await fs.rm(dst, { recursive: true, force: true }).catch(() => {});
    if (cache.data[key] !== undefined) {
      delete cache.data[key];
      cache.dirty = true;
    }
    return;
  }
  let dstExists = false;
  try {
    const stat = await fs.stat(dst);
    dstExists = stat.isDirectory();
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
  if (dstExists && cache.data[key] === srcHash) {
    return;
  }
  await fs.rm(dst, { recursive: true, force: true }).catch(() => {});
  await copyDir(src, dst);
  cache.data[key] = srcHash;
  cache.dirty = true;
}

function normalizePortName(entry) {
  return (entry || '').split('@')[0];
}

(async () => {
  const compose = await readJSON(composePath);
  await fs.mkdir(outDir, { recursive: true });

  // Load manifests
  const manifById = {};
  for (const mod of compose.modules || []) {
    const mp = manifestPath(modulesRoot, mod.id);
    manifById[mod.id] = await readJSON(mp);
  }

  const { warnings } = analyzeProviders(compose, manifById);
  for (const warning of warnings) {
    console.warn(warning);
  }

  const providers = {};
  for (const [id, man] of Object.entries(manifById)) {
    for (const p of (man.provides || [])) {
      const name = normalizePortName(p);
      if (!providers[name]) providers[name] = [];
      providers[name].push(id);
    }
  }

  // Requires check
  const providedPorts = new Set(Object.keys(providers));
  const reqProblems = [];
  for (const [id, man] of Object.entries(manifById)) {
    for (const req of (man.requires || [])) {
      const name = normalizePortName(req);
      if (!providedPorts.has(name)) {
        reqProblems.push(`${id} requires ${req} but no selected module provides ${name}`);
      }
    }
  }
  if (reqProblems.length) {
    throw tmError('E_REQUIRE_UNSAT', 'Port requires unsatisfied:\n' + reqProblems.join('\n'));
  }

  const copyCache = await loadCopyCache(outDir);
  const activeKeys = new Set();

  const winnerModulesDir = path.join(outDir, 'modules');
  await fs.mkdir(winnerModulesDir, { recursive: true });
  for (const mod of compose.modules || []) {
    await syncDir({
      kind: 'module',
      id: mod.id,
      src: path.join(modulesRoot, mod.id),
      dst: path.join(winnerModulesDir, mod.id),
      cache: copyCache,
      activeKeys
    });
  }

  const winnerGlueDir = path.join(outDir, 'glue');
  await fs.mkdir(winnerGlueDir, { recursive: true });
  for (const glue of compose.glue || []) {
    if (!glue || !glue.id) continue;
    await syncDir({
      kind: 'glue',
      id: glue.id,
      src: path.join(glueRoot, glue.id),
      dst: path.join(winnerGlueDir, glue.id),
      cache: copyCache,
      activeKeys
    });
  }

  for (const key of Object.keys(copyCache.data || {})) {
    if (!activeKeys.has(key)) {
      delete copyCache.data[key];
      copyCache.dirty = true;
    }
  }

  await saveCopyCache(copyCache);

  const portsMap = Object.fromEntries(Object.entries(providers).map(([port, ids]) => [port, ids]));
  await fs.writeFile(path.join(outDir, 'ports.map.json'), JSON.stringify(portsMap, null, 2));

  const report = {
    context: {
      run_id: compose.run_id || new Date().toISOString(),
      composer: 'ts-composer@0.1',
      generated_at: new Date().toISOString()
    },
    bill_of_materials: (compose.modules || []).map(m => ({
      id: m.id,
      version: m.version || '0.0.0'
    })),
    wiring: compose.wiring || [],
    glue: compose.glue || [],
    constraints: compose.constraints || [],
    notes: [
      'MVP composer copied selected modules/glue; link/build remains app responsibility.'
    ]
  };
  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(outDir, 'README.md'), '# Winner workspace (MVP)\n');

  const runIdSlug = String(compose.run_id || 'winner')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'winner';
  const pkgName = `winner-${runIdSlug}`;
  const moduleVersions = (compose.modules || []).map(m => m.version).filter(Boolean);
  let pkgVersion = moduleVersions.length ? moduleVersions[0] : '0.0.0';
  const prereleaseTag = String(compose.run_id || '')
    .replace(/[^0-9A-Za-z]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (prereleaseTag) {
    pkgVersion = pkgVersion.includes('-') ? `${pkgVersion}.${prereleaseTag}` : `${pkgVersion}-${prereleaseTag}`;
  }
  const pkg = {
    name: pkgName,
    private: true,
    version: pkgVersion,
    type: 'module',
    description: 'Materialized workspace generated by True Modules composer (MVP)'
  };
  await fs.writeFile(path.join(outDir, 'package.json'), JSON.stringify(pkg, null, 2));

  const tsconfig = {
    compilerOptions: {
      target: 'ES2020',
      module: 'ES2020',
      moduleResolution: 'node',
      esModuleInterop: true,
      resolveJsonModule: true,
      allowSyntheticDefaultImports: true,
      strict: false
    },
    include: ['modules/**/*', 'glue/**/*']
  };
  await fs.writeFile(path.join(outDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

  console.log('✓ Composer wrote', outDir);
})().catch(err => {
  console.error('composer error:', err.message);
  process.exit(1);
});
