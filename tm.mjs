#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { spawn } from 'child_process';
import crypto from 'crypto';
import { collectCrossImportDiagnostics } from './scripts/eslint-run.mjs';
import { tmError, analyzeProviders } from './scripts/lib/provider-analysis.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLI_VERSION = '0.1.0';
const program = new Command();
program.name('tm').description('True Modules CLI (scaffold)').version(CLI_VERSION);

const specDir = path.join(__dirname, 'spec');
async function loadJSON(p) {
  const txt = await fs.readFile(p, 'utf8');
  try { return JSON.parse(txt); } catch (e) {
    throw new Error(`Failed to parse JSON at ${p}: ${e.message}`);
  }
}

function makeAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

async function validateAgainst(schemaName, data) {
  const ajv = makeAjv();
  const schema = await loadJSON(path.join(specDir, schemaName));
  const validate = ajv.compile(schema);
  const valid = validate(data);
  if (!valid) {
    const errs = (validate.errors || []).map(e => `${e.instancePath} ${e.message}`).join('\n');
    throw new Error(`Validation failed for ${schemaName}:\n${errs}`);
  }
}

async function validateFile(schemaName, filePath) {
  const data = await loadJSON(filePath);
  await validateAgainst(schemaName, data);
  return data;
}

const cloneJson = (value) => {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
};

const wiringKey = (segment) => `${segment.from}->${segment.to}`;

function ensureOverrideEntry(section, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw tmError('E_COMPOSE_OVERRIDES', `Overrides for ${section} must be objects.`);
  }
}

function ensureOverrideString(section, value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw tmError('E_COMPOSE_OVERRIDES', `Override entries in ${section} must be non-empty strings.`);
  }
}

function mergeComposeOverrides(baseCompose, overridesInput) {
  if (!overridesInput || typeof overridesInput !== 'object' || Array.isArray(overridesInput)) {
    throw tmError('E_COMPOSE_OVERRIDES', 'Overrides file must be a JSON object.');
  }

  const overrides = cloneJson(overridesInput);
  const merged = cloneJson(baseCompose || {});
  if (!Array.isArray(merged.modules)) merged.modules = [];
  if (!Array.isArray(merged.wiring)) merged.wiring = [];
  if (!Array.isArray(merged.constraints)) merged.constraints = [];

  const baseModuleIds = new Set((merged.modules || []).map(m => (typeof m?.id === 'string' ? m.id : null)).filter(Boolean));
  const moduleMap = new Map((merged.modules || []).map(m => [m.id, m]));
  const baseWiringKeys = new Set((merged.wiring || []).map(w => (w && typeof w.from === 'string' && typeof w.to === 'string') ? wiringKey(w) : null).filter(Boolean));
  const wiringMap = new Map((merged.wiring || []).map(w => [wiringKey(w), w]));
  const addedModules = new Set();
  const replacedModules = new Set();
  const removedModules = new Set();
  const addedWiring = new Set();
  const replacedWiring = new Set();
  const removedWiring = new Set();
  const addedConstraints = new Set();
  const removedConstraints = new Set();

  if ('modules' in overrides) {
    if (!Array.isArray(overrides.modules)) {
      throw tmError('E_COMPOSE_OVERRIDES', 'overrides.modules must be an array.');
    }
    for (const mod of overrides.modules) {
      if (typeof mod === 'string') {
        const trimmed = mod.trim();
        if (!trimmed.startsWith('-')) {
          throw tmError('E_COMPOSE_OVERRIDES', 'String entries in overrides.modules must start with "-" to remove a module id.');
        }
        const targetId = trimmed.slice(1);
        if (!targetId) {
          throw tmError('E_COMPOSE_OVERRIDES', 'Module removals must specify the module id after "-".');
        }
        if (moduleMap.delete(targetId)) {
          removedModules.add(targetId);
        }
        baseModuleIds.delete(targetId);
        continue;
      }
      ensureOverrideEntry('modules', mod);
      if (typeof mod.id !== 'string' || !mod.id.trim()) {
        throw tmError('E_COMPOSE_OVERRIDES', 'Override module entries must include an "id".');
      }
      const id = mod.id.trim();
      const clone = cloneJson(mod);
      clone.id = id;
      if (baseModuleIds.has(id)) {
        replacedModules.add(id);
      } else {
        addedModules.add(id);
      }
      moduleMap.set(id, clone);
    }
    merged.modules = Array.from(moduleMap.values()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  if ('wiring' in overrides) {
    if (!Array.isArray(overrides.wiring)) {
      throw tmError('E_COMPOSE_OVERRIDES', 'overrides.wiring must be an array.');
    }
    for (const segment of overrides.wiring) {
      if (segment && segment.remove) {
        if (typeof segment.from !== 'string' || !segment.from.trim() || typeof segment.to !== 'string' || !segment.to.trim()) {
          throw tmError('E_COMPOSE_OVERRIDES', 'Wiring removals require "from" and "to" strings.');
        }
        const from = segment.from.trim();
        const to = segment.to.trim();
        const key = wiringKey({ from, to });
        if (wiringMap.delete(key)) {
          removedWiring.add(key);
        }
        baseWiringKeys.delete(key);
        continue;
      }
      ensureOverrideEntry('wiring', segment);
      if (typeof segment.from !== 'string' || !segment.from.trim() || typeof segment.to !== 'string' || !segment.to.trim()) {
        throw tmError('E_COMPOSE_OVERRIDES', 'Override wiring entries require non-empty "from" and "to" strings.');
      }
      const clone = cloneJson(segment);
      clone.from = clone.from.trim();
      clone.to = clone.to.trim();
      const key = wiringKey(clone);
      if (baseWiringKeys.has(key)) {
        replacedWiring.add(key);
      } else {
        addedWiring.add(key);
      }
      wiringMap.set(key, clone);
    }
    merged.wiring = Array.from(wiringMap.values()).sort((a, b) => {
      const fromCmp = String(a.from).localeCompare(String(b.from));
      if (fromCmp !== 0) return fromCmp;
      return String(a.to).localeCompare(String(b.to));
    });
  }

  if ('constraints' in overrides) {
    if (!Array.isArray(overrides.constraints)) {
      throw tmError('E_COMPOSE_OVERRIDES', 'overrides.constraints must be an array.');
    }
    let working = Array.isArray(merged.constraints) ? [...merged.constraints] : [];
    for (const raw of overrides.constraints) {
      ensureOverrideString('constraints', raw);
      const trimmed = raw.trim();
      if (trimmed.startsWith('-')) {
        const target = trimmed.slice(1);
        if (!target) {
          throw tmError('E_COMPOSE_OVERRIDES', 'Constraint removals must specify a name after the leading "-".');
        }
        const before = working.length;
        working = working.filter(entry => entry !== target);
        if (working.length !== before) {
          removedConstraints.add(target);
        }
      } else if (!working.includes(trimmed)) {
        working.push(trimmed);
        addedConstraints.add(trimmed);
      }
    }
    merged.constraints = working;
  }

  const toSortedArray = (set) => Array.from(set).sort((a, b) => String(a).localeCompare(String(b)));
  const sectionsChanged = [];
  if (addedModules.size || replacedModules.size || removedModules.size) sectionsChanged.push('modules');
  if (addedWiring.size || replacedWiring.size || removedWiring.size) sectionsChanged.push('wiring');
  if (addedConstraints.size || removedConstraints.size) sectionsChanged.push('constraints');

  const detail = {};
  if (addedModules.size || addedWiring.size || addedConstraints.size) {
    detail.added = {};
    if (addedModules.size) detail.added.modules = toSortedArray(addedModules);
    if (addedWiring.size) detail.added.wiring = toSortedArray(addedWiring);
    if (addedConstraints.size) detail.added.constraints = toSortedArray(addedConstraints);
  }
  if (replacedModules.size || replacedWiring.size) {
    detail.replaced = {};
    if (replacedModules.size) detail.replaced.modules = toSortedArray(replacedModules);
    if (replacedWiring.size) detail.replaced.wiring = toSortedArray(replacedWiring);
  }
  if (removedModules.size || removedWiring.size) {
    detail.removed = {};
    if (removedModules.size) detail.removed.modules = toSortedArray(removedModules);
    if (removedWiring.size) detail.removed.wiring = toSortedArray(removedWiring);
  }
  if (removedConstraints.size) {
    detail.removed_constraints = toSortedArray(removedConstraints);
  }
  if (sectionsChanged.length) {
    detail.sections = sectionsChanged;
  }

  return {
    compose: merged,
    summary: {
      addedModules: toSortedArray(addedModules),
      replacedModules: toSortedArray(replacedModules),
      removedModules: toSortedArray(removedModules),
      addedWiring: toSortedArray(addedWiring),
      replacedWiring: toSortedArray(replacedWiring),
      removedWiring: toSortedArray(removedWiring),
      addedConstraints: toSortedArray(addedConstraints),
      removedConstraints: toSortedArray(removedConstraints),
      sectionsChanged,
      detail,
      changed: sectionsChanged.length > 0
    }
  };
}

function describeOverrideSummary(summary) {
  if (!summary || !summary.changed) return '';
  const parts = [];
  if (summary.replacedModules?.length) {
    parts.push(`replaced modules: ${summary.replacedModules.join(', ')}`);
  }
  if (summary.addedModules?.length) {
    parts.push(`added modules: ${summary.addedModules.join(', ')}`);
  }
  if (summary.removedModules?.length) {
    parts.push(`removed modules: ${summary.removedModules.join(', ')}`);
  }
  if (summary.replacedWiring?.length) {
    parts.push(`replaced wiring: ${summary.replacedWiring.join(', ')}`);
  }
  if (summary.addedWiring?.length) {
    parts.push(`added wiring: ${summary.addedWiring.join(', ')}`);
  }
  if (summary.removedWiring?.length) {
    parts.push(`removed wiring: ${summary.removedWiring.join(', ')}`);
  }
  if (summary.removedConstraints?.length) {
    parts.push(`removed constraints: ${summary.removedConstraints.join(', ')}`);
  }
  if (summary.addedConstraints?.length) {
    parts.push(`added constraints: ${summary.addedConstraints.join(', ')}`);
  }
  return parts.join('; ');
}

async function runCmd(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`Timeout ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', spawnErr => {
      clearTimeout(timer);
      const error = new Error(`Failed to spawn ${cmd}: ${spawnErr.message}`);
      error.cause = spawnErr;
      error.code = spawnErr.code || 'ERR_SPAWN';
      error.stdout = out;
      error.stderr = err;
      reject(error);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err, code });
      else {
        const message = (err || out || '').trim();
        const error = new Error(message || `Exit ${code}`);
        error.code = 'EXIT_' + code;
        error.exitCode = code;
        error.stdout = out;
        error.stderr = err;
        reject(error);
      }
    });
  });
}

function verifyPortRequires(compose, manifestsById) {
  const provided = new Set();
  for (const man of Object.values(manifestsById)) {
    for (const p of (man.provides || [])) provided.add(p.split('@')[0]);
  }
  const problems = [];
  for (const [id, man] of Object.entries(manifestsById)) {
    for (const req of (man.requires || [])) {
      const name = req.split('@')[0];
      if (!provided.has(name)) {
        problems.push(`${id} requires ${req} but no selected module provides ${name}`);
      }
    }
  }
  return problems;
}

async function dirExists(p) {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function listTarballs(dir) {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter(name => name.endsWith('.tgz')).sort();
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw tmError('npm_pack_failed', `Winner directory not found: ${path.relative(process.cwd(), dir) || dir}`);
    }
    throw err;
  }
}

function collectPackDiagnostics(stdout, stderr, fallback) {
  const lines = [];
  for (const chunk of [stderr, stdout]) {
    if (!chunk) continue;
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) lines.push(trimmed);
    }
  }
  if (fallback) lines.push(String(fallback));
  return lines.filter(Boolean).slice(0, 5);
}

async function execNpmPack(winnerDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['pack'], { cwd: winnerDir, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => {
      if (err && err.code === 'ENOENT') {
        resolve({ skipped: true, reason: 'npm executable not found on PATH' });
        return;
      }
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
    child.on('exit', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`npm pack exited with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.exitCode = code;
        reject(error);
      }
    });
  });
}

async function runNpmPackSmoke(winnerDir, ee) {
  const relDir = path.relative(process.cwd(), winnerDir) || '.';
  await ee.emit('NPM_PACK_START', { cwd: relDir });
  const start = Date.now();
  let before;
  try {
    before = new Set(await listTarballs(winnerDir));
  } catch (err) {
    if (err && err.code === 'npm_pack_failed') {
      const diagnostics = collectPackDiagnostics(null, null, err.message);
      err.diagnostics = diagnostics;
      await ee.emit('NPM_PACK_FAIL', { cwd: relDir, code: 'npm_pack_failed', diagnostics, dur_ms: Date.now() - start });
    }
    throw err;
  }

  const produced = new Set();
  try {
    const result = await execNpmPack(winnerDir);
    if (result?.skipped) {
      await ee.emit('NPM_PACK_SKIP', { cwd: relDir, reason: result.reason, dur_ms: Date.now() - start });
      ee.info(`ℹ️ npm pack skipped: ${result.reason}`);
      return { skipped: true, reason: result.reason };
    }
    const after = await listTarballs(winnerDir);
    for (const name of after) {
      if (!before.has(name)) produced.add(name);
    }
    if (produced.size === 0) {
      const diagnostics = collectPackDiagnostics(result?.stdout, result?.stderr, 'npm pack produced no tarball');
      const failure = tmError('npm_pack_failed', diagnostics[0] || 'npm pack produced no tarball');
      failure.diagnostics = diagnostics;
      await ee.emit('NPM_PACK_FAIL', { cwd: relDir, code: 'npm_pack_failed', diagnostics, dur_ms: Date.now() - start });
      throw failure;
    }
    const tarballName = [...produced][0];
    await ee.emit('NPM_PACK_PASS', { cwd: relDir, tarball: tarballName, dur_ms: Date.now() - start });
    ee.info(`✓ npm pack smoke passed (${tarballName})`);
    return { tarball: tarballName, workspace: relDir };
  } catch (err) {
    if (err && err.code === 'npm_pack_failed') throw err;
    const diagnostics = collectPackDiagnostics(err?.stdout, err?.stderr, err?.message || 'npm pack failed');
    const failure = tmError('npm_pack_failed', diagnostics[0] || 'npm pack failed');
    failure.diagnostics = diagnostics;
    await ee.emit('NPM_PACK_FAIL', { cwd: relDir, code: 'npm_pack_failed', diagnostics, dur_ms: Date.now() - start });
    throw failure;
  } finally {
    if (before) {
      try {
        const cleanup = await listTarballs(winnerDir);
        for (const name of cleanup) {
          if (!before.has(name)) {
            try {
              await fs.rm(path.join(winnerDir, name));
            } catch {}
          }
        }
      } catch {}
    }
  }
}

async function makeEventEmitter(opts) {
  const context = {
    run_id: opts.context?.run_id ?? null,
    mode: opts.context?.mode ?? null,
    compose_sha256: opts.context?.compose_sha256 ?? null
  };
  const strict = Boolean(opts.strictEvents);
  let validator = null;
  if (strict) {
    const schema = await loadJSON(path.join(specDir, 'events.schema.json'));
    const ajv = makeAjv();
    validator = ajv.compile(schema);
  }

  let fileHandle = null;
  if (opts.eventsOut) {
    const target = path.resolve(opts.eventsOut);
    await fs.mkdir(path.dirname(target), { recursive: true });
    fileHandle = await fs.open(target, opts.eventsTruncate ? 'w' : 'a');
  }

  let seq = 0;
  const writeLine = async (line) => {
    if (opts.emitEvents) {
      process.stdout.write(line + '\n');
    }
    if (fileHandle) {
      await fileHandle.appendFile(line + '\n');
    }
  };

  const emit = async (event, detail = {}) => {
    const envelope = {
      schema: 'tm-events@1',
      event,
      ts: new Date().toISOString(),
      seq: ++seq,
      source: { cli: 'tm', version: CLI_VERSION },
      context
    };
    if (detail && Object.keys(detail).length > 0) {
      envelope.detail = detail;
    }
    if (validator) {
      const valid = validator(envelope);
      if (!valid) {
        const errs = (validator.errors || []).map(e => `${e.instancePath} ${e.message}`).join('; ');
        throw tmError('E_EVENT_SCHEMA', `Event ${event} failed validation: ${errs}`);
      }
    }
    await writeLine(JSON.stringify(envelope));
  };

  const info = (msg) => {
    (opts.emitEvents ? console.error : console.log)(msg);
  };

  const close = async () => {
    if (fileHandle) {
      await fileHandle.close();
      fileHandle = null;
    }
  };

  return { emit, info, close };
}

function interfaceNameForPort(portId) {
  const [name, versionRaw] = (portId || '').split('@');
  const version = Number(versionRaw || '1');
  if (!version || version === 1) return name;
  return `${name}V${version}`;
}

async function resolvePortsDir(workspaceRoot) {
  const candidates = [
    path.resolve(workspaceRoot, '..', 'runtimes', 'ts', 'ports'),
    path.resolve(workspaceRoot, '..', '..', 'runtimes', 'ts', 'ports'),
    path.resolve(process.cwd(), 'runtimes', 'ts', 'ports')
  ];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      continue;
    }
  }
  return path.resolve(process.cwd(), 'runtimes', 'ts', 'ports');
}

async function buildPortHarness(manifests, workspaceRoot, portsDir, ee) {
  const entries = [];
  let harnessDir = null;

  async function ensureHarnessDir() {
    if (!harnessDir) {
      harnessDir = path.join(workspaceRoot, '.tm', 'port-checks');
      await fs.rm(harnessDir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(harnessDir, { recursive: true });
    }
  }

  for (const [moduleId, data] of Object.entries(manifests)) {
    const { manifest, root } = data;
    const provides = manifest.provides || [];
    const portExports = manifest.port_exports || {};
    for (const port of provides) {
      await ee.emit('PORT_CHECK_START', { module: moduleId, port });
      let binding = portExports[port];
      if (!binding) {
        const fallback = 'src/index.ts';
        try {
          await fs.access(path.join(root, fallback));
          binding = { file: fallback, export: 'default' };
          await ee.emit('GATES_WARN', { code: 'WARN_PORT_EXPORTS_MISSING', module: moduleId, port });
        } catch {
          await ee.emit('PORT_CHECK_FAIL', { module: moduleId, port, error: 'port_export_not_found', code: 'E_PORT_CONFORMANCE' });
          throw tmError('E_PORT_CONFORMANCE', `Port ${port} for ${moduleId} missing port_exports entry and fallback ${fallback} not found.`);
        }
      }

      const absFile = path.join(root, binding.file);
      try {
        await fs.access(absFile);
      } catch {
        await ee.emit('PORT_CHECK_FAIL', { module: moduleId, port, error: 'port_export_not_found', code: 'E_PORT_CONFORMANCE' });
        throw tmError('E_PORT_CONFORMANCE', `Port ${port} for ${moduleId} references missing file ${binding.file}`);
      }

      await ensureHarnessDir();
      const safeModule = moduleId.replace(/[\\/]/g, '_');
      const safePort = port.replace(/[\\/]/g, '_');
      const harnessPath = path.join(harnessDir, `${safeModule}__${safePort}.ts`);

      const relativeImport = path.relative(harnessDir, absFile).replace(/\\/g, '/');
      const importSpecifier = relativeImport.startsWith('.') ? relativeImport : `./${relativeImport}`;
      const portsImportRelative = path.relative(harnessDir, path.join(portsDir, 'index.js')).replace(/\\/g, '/');
      const portsImport = portsImportRelative.startsWith('.') ? portsImportRelative : `./${portsImportRelative}`;
      const interfaceName = interfaceNameForPort(port);
      let importLines;
      let reference = 'portExport';
      if ((binding.export || '').toLowerCase() === 'default') {
        importLines = `import provider from '${importSpecifier}';\nconst ${reference} = provider;`;
      } else {
        importLines = `import { ${binding.export} as ${reference} } from '${importSpecifier}';`;
      }
      const harnessCode = `import type { ${interfaceName} } from '${portsImport}';\n${importLines}\nconst _check: ${interfaceName} = ${reference};\nexport {};\n`;
      await fs.writeFile(harnessPath, harnessCode);
      entries.push({ harnessPath, module: moduleId, port });
    }
  }

  return { harnessDir, entries };
}

// ---- helpers for gates ----
async function listFilesRec(dir, exts) {
  const out = [];
  async function walk(d) {
    const ents = await fs.readdir(d, { withFileTypes: true });
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (!exts || exts.some(ext => p.endsWith(ext))) out.push(p);
    }
  }
  await walk(dir);
  return out;
}

async function crossImportLint(modulesRoot) {
  const modules = await fs.readdir(modulesRoot, { withFileTypes: true });
  const problems = [];
  for (const ent of modules) {
    if (!ent.isDirectory()) continue;
    const modId = ent.name;
    const modRoot = path.join(modulesRoot, modId);
    const srcFiles = await listFilesRec(modRoot, ['.ts','.tsx','.js','.jsx']);
    for (const fp of srcFiles) {
      const text = await fs.readFile(fp, 'utf8');
      const lines = text.split(/\r?\n/);
      lines.forEach((line, idx) => {
        const m = line.match(/from\s+['"]([^'"]+)['"]/);
        const r = line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/);
        const imp = m ? m[1] : (r ? r[1] : null);
        if (!imp) return;
        if (imp.startsWith('..')) {
          problems.push({ file: fp, line: idx+1, msg: `relative import escapes module root: ${imp}` });
        }
        if (imp.includes('modules/')) {
          const parts = imp.split('modules/');
          if (parts[1]) {
            const other = parts[1].split(/[\\/]/)[0];
            if (other && other !== modId) {
              problems.push({ file: fp, line: idx+1, msg: `imports sibling module '${other}'` });
            }
          }
        }
      });
    }
  }
  return problems;
}

// ---- lessons miner helpers ----
function normalizeGlobPattern(pattern) {
  if (!pattern) return '';
  let normalized = String(pattern).trim();
  if (!normalized) return '';
  normalized = normalized.replace(/\\/g, '/');
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

function globHasWildcards(pattern) {
  return /[*?]/.test(pattern);
}

function globBaseDir(pattern) {
  const normalized = normalizeGlobPattern(pattern);
  if (!normalized) return '.';
  if (!globHasWildcards(normalized)) {
    const dir = path.posix.dirname(normalized);
    if (!dir || dir === '.' || dir === '') return '.';
    return dir;
  }
  const segments = normalized.split('/');
  const baseSegments = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg === '' && i === 0 && normalized.startsWith('/')) {
      baseSegments.push('');
      continue;
    }
    if (globHasWildcards(seg)) break;
    baseSegments.push(seg);
  }
  if (baseSegments.length === 0) return '.';
  if (baseSegments.length === 1 && baseSegments[0] === '') return '/';
  const joined = baseSegments.join('/');
  if (!joined || joined === '.') return '.';
  return joined;
}

function escapeRegexChar(char) {
  return char.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
}

function globToRegExp(pattern) {
  const normalized = normalizeGlobPattern(pattern);
  let regex = '^';
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        i += 2;
        if (normalized[i] === '/') {
          regex += '(?:[^/]+/)*';
          i += 1;
        } else {
          regex += '.*';
        }
        continue;
      }
      regex += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      regex += '[^/]';
      i += 1;
      continue;
    }
    regex += escapeRegexChar(ch);
    i += 1;
  }
  regex += '$';
  return new RegExp(regex);
}

async function expandGlob(pattern) {
  const normalized = normalizeGlobPattern(pattern);
  const base = globBaseDir(normalized);
  const searchRoot = base === '/' ? '/' : path.resolve(base);
  const matcher = globToRegExp(normalized);
  const matches = [];
  let missingBase = false;

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        missingBase = true;
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const rel = path.relative(process.cwd(), fullPath).replace(/\\/g, '/');
        if (matcher.test(rel)) {
          matches.push(fullPath);
        } else {
          const absNormalized = fullPath.replace(/\\/g, '/');
          if (matcher.test(absNormalized)) matches.push(fullPath);
        }
      }
    }
  }

  try {
    await walk(searchRoot);
  } catch (err) {
    if (!(err && err.code === 'ENOENT')) throw err;
    missingBase = true;
  }

  return { matches, missingBase };
}

function normalizeResidualEntry(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text : null;
}

const FOLLOWUP_PRIORITY_ORDER = new Map([
  ['P0', 0],
  ['P1', 1],
  ['P2', 2],
  ['P3', 3]
]);

function normalizeFollowupEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const title = typeof entry.title === 'string' ? entry.title.replace(/\s+/g, ' ').trim() : '';
  const priorityRaw = typeof entry.priority === 'string' ? entry.priority.trim().toUpperCase() : '';
  if (!title || !FOLLOWUP_PRIORITY_ORDER.has(priorityRaw)) return null;
  const normalized = { title, priority: priorityRaw };
  if (typeof entry.owner === 'string') {
    const owner = entry.owner.trim();
    if (owner) normalized.owner = owner;
  }
  if (typeof entry.pointer === 'string') {
    const pointer = entry.pointer.trim();
    if (pointer) normalized.pointer = pointer;
  }
  return normalized;
}

function followupKey(entry) {
  const base = { title: entry.title, priority: entry.priority };
  if (entry.owner) base.owner = entry.owner;
  if (entry.pointer) base.pointer = entry.pointer;
  return JSON.stringify(base);
}

async function locateWinnerDir(composePath) {
  const resolvedCompose = path.resolve(composePath);
  const composeDir = path.dirname(resolvedCompose);
  const candidates = [];
  if (process.env.TM_WINNER_DIR) candidates.push(path.resolve(process.env.TM_WINNER_DIR));
  candidates.push(path.join(composeDir, 'winner'));
  candidates.push(path.resolve(process.cwd(), 'winner'));
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isDirectory()) continue;
      await fs.access(path.join(candidate, 'package.json'));
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function collectDiagnostics(err, limit = 5) {
  const lines = [];
  const seen = new Set();
  const push = (value) => {
    if (typeof value !== 'string') return;
    for (const rawLine of value.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
      if (lines.length >= limit) return;
    }
  };
  if (err && typeof err.stderr === 'string') push(err.stderr);
  if (err && typeof err.stdout === 'string') push(err.stdout);
  if (err && typeof err.message === 'string') push(err.message);
  return lines.slice(0, limit);
}

function npmInvocation() {
  const execPath = process.env.npm_execpath;
  if (execPath) {
    return { cmd: process.execPath, args: [execPath, 'pack'] };
  }
  return { cmd: 'npm', args: ['pack'] };
}

const lessonsCmd = program
  .command('lessons')
  .description('Lessons utilities');

lessonsCmd
  .command('mine')
  .requiredOption('--from <patterns...>', 'Glob patterns (space-separated) to locate report.json files')
  .requiredOption('--out <file>', 'Output file for merged lessons JSON')
  .description('Aggregate followups and residual risks across reports')
  .action(async (opts) => {
    const rawPatterns = Array.isArray(opts.from) ? opts.from : [opts.from];
    const patterns = rawPatterns
      .flatMap((value) => String(value).split(/\s+/))
      .map(normalizeGlobPattern)
      .filter(Boolean);
    if (!patterns.length) {
      throw new Error('At least one --from pattern must be provided.');
    }

    const matchedFiles = new Set();
    for (const pattern of patterns) {
      const { matches, missingBase } = await expandGlob(pattern);
      if (missingBase && matches.length === 0) {
        console.warn(`[lessons] Base path not found for pattern: ${pattern}`);
      }
      if (matches.length === 0) {
        console.warn(`[lessons] No files matched pattern: ${pattern}`);
      }
      for (const match of matches) matchedFiles.add(match);
    }

    if (matchedFiles.size === 0) {
      throw new Error('No reports matched the provided patterns.');
    }

    const followups = new Map();
    const residuals = new Set();
    let processed = 0;

    const sortedFiles = Array.from(matchedFiles).sort((a, b) => a.localeCompare(b));
    for (const filePath of sortedFiles) {
      let json;
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        json = JSON.parse(raw);
      } catch (err) {
        const rel = path.relative(process.cwd(), filePath) || filePath;
        console.warn(`[lessons] Skipping ${rel}: ${(err && err.message) || err}`);
        continue;
      }
      processed += 1;
      const rel = path.relative(process.cwd(), filePath) || filePath;

      if (Array.isArray(json.residual_risks)) {
        for (const entry of json.residual_risks) {
          const normalized = normalizeResidualEntry(entry);
          if (!normalized) continue;
          residuals.add(normalized);
        }
      } else if (json.residual_risks !== undefined) {
        console.warn(`[lessons] residual_risks in ${rel} is not an array; skipping.`);
      }

      if (Array.isArray(json.followups)) {
        for (const entry of json.followups) {
          const normalized = normalizeFollowupEntry(entry);
          if (!normalized) continue;
          followups.set(followupKey(normalized), normalized);
        }
      } else if (json.followups !== undefined) {
        console.warn(`[lessons] followups in ${rel} is not an array; skipping.`);
      }
    }

    if (processed === 0) {
      throw new Error('No reports could be read (all matched files failed to load).');
    }

    const sortedFollowups = Array.from(followups.values()).sort((a, b) => {
      const aRank = FOLLOWUP_PRIORITY_ORDER.get(a.priority) ?? 99;
      const bRank = FOLLOWUP_PRIORITY_ORDER.get(b.priority) ?? 99;
      if (aRank !== bRank) return aRank - bRank;
      const titleCmp = a.title.localeCompare(b.title);
      if (titleCmp !== 0) return titleCmp;
      const ownerCmp = (a.owner || '').localeCompare(b.owner || '');
      if (ownerCmp !== 0) return ownerCmp;
      return (a.pointer || '').localeCompare(b.pointer || '');
    });

    const sortedResiduals = Array.from(residuals).sort((a, b) => a.localeCompare(b));

    const outPath = path.resolve(opts.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const payload = { followups: sortedFollowups, residual_risks: sortedResiduals };
    await fs.writeFile(outPath, JSON.stringify(payload, null, 2) + '\n');

    const relOut = path.relative(process.cwd(), outPath) || outPath;
    console.log(`✓ Lessons mined ${sortedFollowups.length} followups & ${sortedResiduals.length} residual risks from ${processed} reports → ${relOut}`);
  });

program
  .command('schema-compile')
  .description('Compile all JSON Schemas to ensure they are valid (AJV 2020-12)')
  .action(async () => {
    const files = ['module.schema.json','compose.schema.json','coverage.schema.json','report.schema.json','events.schema.json'];
    for (const f of files) {
      const schema = await loadJSON(path.join(specDir, f));
      const ajv = makeAjv();
      ajv.compile(schema);
      console.log(`✓ Compiled ${f}`);
    }
  });

program
  .command('compose')
  .requiredOption('--compose <file>', 'Path to compose.json')
  .requiredOption('--modules-root <dir>', 'Root directory containing module folders (with module.json)')
  .option('--out <dir>', './winner', 'Output directory for winner artifacts')
  .option('--overrides <file>', 'Path to compose overrides JSON')
  .option('--emit-events', 'Emit line-delimited JSON events', false)
  .option('--events-out <file>', 'Write events to file (NDJSON)')
  .option('--events-truncate', 'Truncate events output file before writing', false)
  .option('--strict-events', 'Validate events against tm-events@1 schema (fail fast)', false)
  .option('--explain', 'Print provider resolution details', false)
  .description('Validate compose plan and manifests; emit a minimal winner report (scaffold)')
  .action(async (opts) => {
    const composePath = path.resolve(opts.compose);
    const modulesRoot = path.resolve(opts.modules_root || opts.modulesRoot);
    const baseCompose = await loadJSON(composePath);

    let compose = cloneJson(baseCompose);
    let overrideSummary = null;
    let overridesPath = null;

    if (opts.overrides) {
      overridesPath = path.resolve(opts.overrides);
      let overrides;
      try {
        overrides = await loadJSON(overridesPath);
      } catch (err) {
        const rel = path.relative(process.cwd(), overridesPath) || overridesPath;
        if (err && err.code === 'ENOENT') {
          throw tmError('E_COMPOSE_OVERRIDES', `Override file not found: ${rel}`);
        }
        const message = err?.message || `Failed to read overrides at ${rel}`;
        const failure = tmError('E_COMPOSE_OVERRIDES', message);
        failure.cause = err;
        throw failure;
      }
      const merged = mergeComposeOverrides(baseCompose, overrides);
      compose = merged.compose;
      overrideSummary = merged.summary;
    }

    await validateAgainst('compose.schema.json', compose);

    const composeJson = JSON.stringify(compose);
    const composeHash = crypto.createHash('sha256').update(composeJson).digest('hex');
    const runId = compose.run_id || new Date().toISOString();
    const ee = await makeEventEmitter({
      emitEvents: opts.emitEvents,
      eventsOut: opts.eventsOut ? path.resolve(opts.eventsOut) : null,
      eventsTruncate: opts.eventsTruncate,
      strictEvents: opts.strictEvents,
      context: { run_id: runId, mode: 'compose', compose_sha256: composeHash }
    });

    const overridesRel = overridesPath ? (path.relative(process.cwd(), overridesPath) || overridesPath) : null;
    const composeRel = path.relative(process.cwd(), composePath) || composePath;

    try {
      if (overrideSummary?.changed) {
        const detail = { ...overrideSummary.detail, compose_path: composeRel };
        if (overridesRel) detail.overrides_path = overridesRel;
        await ee.emit('COMPOSE_OVERRIDES_APPLIED', detail);
        const summaryText = describeOverrideSummary(overrideSummary);
        const prefix = overridesRel ? ` (${overridesRel})` : '';
        ee.info(`✓ Overrides applied${prefix}${summaryText ? `: ${summaryText}` : ''}`);
      } else if (overridesRel) {
        ee.info(`Overrides file ${overridesRel} did not change the compose plan.`);
      }

      // Load and validate module manifests
      const moduleEntries = {};
      for (const m of compose.modules || []) {
        const mdir = path.join(modulesRoot, m.id);
        const mfile = path.join(mdir, 'module.json');
        const manifest = await validateFile('module.schema.json', mfile);
        moduleEntries[m.id] = { dir: mdir, manifest };
      }

      const manifestsById = Object.fromEntries(
        Object.entries(moduleEntries).map(([k, v]) => [k, v.manifest])
      );
      const reqProblems = verifyPortRequires(compose, manifestsById);
      if (reqProblems.length) {
        throw tmError('E_REQUIRE_UNSAT', 'Compose port requirements failed:\n' + reqProblems.join('\n'));
      }

      // Basic wiring checks
      const providesPort = (manifest, portName) => {
        const arr = manifest.provides || [];
        return arr.some(p => (p.split('@')[0] === portName));
      };

      for (const w of (compose.wiring || [])) {
        const [fromName, fromPort] = w.from.split(':');
        const [toName, toPort] = w.to.split(':');
        if (!fromName || !fromPort || !toName || !toPort) {
          throw tmError('E_COMPOSE', `Invalid wiring entry: ${JSON.stringify(w)}`);
        }
        if (fromName !== 'orchestrator') {
          const ent = moduleEntries[fromName];
          if (!ent) throw tmError('E_COMPOSE', `Wiring 'from' references unknown module: ${fromName}`);
          if (!providesPort(ent.manifest, fromPort)) {
            throw tmError('E_COMPOSE', `Module ${fromName} does not provide port ${fromPort}`);
          }
        }
      }

      const { explanations, warnings } = analyzeProviders(compose, moduleEntries);

      // Emit a minimal winner report
      const outDir = path.resolve(opts.out || './winner');
      await fs.mkdir(outDir, { recursive: true });
      const winnerReport = {
        context: {
          run_id: runId,
          composer: 'tm (scaffold)',
          generated_at: new Date().toISOString()
        },
        bill_of_materials: (compose.modules || []).map(m => ({
          id: m.id, version: m.version || '0.0.0'
        })),
        wiring: compose.wiring || [],
        glue: compose.glue || [],
        constraints: compose.constraints || [],
        notes: [
          "This is a scaffold winner report generated without building/linking.",
          "Use the full Composer to assemble code and run gates in shipping mode."
        ]
      };
      await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(winnerReport, null, 2));
      await fs.writeFile(path.join(outDir, 'README.md'), '# Winner (scaffold)\n\nGenerated by `tm compose`.');
      ee.info(`✓ Wrote ${path.join(outDir, 'report.json')}`);

      for (const warning of warnings) {
        console.warn(warning);
      }

      if (opts.explain) {
        const explainOutput = JSON.stringify(explanations, null, 2);
        if (opts.emitEvents) {
          ee.info(explainOutput);
        } else {
          console.log(explainOutput);
        }
      }
    } finally {
      await ee.close();
    }
  });

program
  .command('meta')
  .requiredOption('--coverage <file>', 'Path to coverage.json')
  .option('--out <file>', 'Output compose file', './compose.greedy.json')
  .option('--respect-requires', 'Skip modules whose requires[] are not satisfied by the current selection', false)
  .description('Greedy set-cover with simple risk/evidence scoring')
  .action(async (opts) => {
    const cov = await validateFile('coverage.schema.json', path.resolve(opts.coverage));
    const weights = cov.weights || {};
    const goals = new Set(cov.goals || []);
    const respectRequires = Boolean(opts.respectRequires);

    
    // Build module metadata and index ports to providers
    const moduleInfo = new Map();
    const modulesProvidingPort = new Map();

    for (const p of (cov.provides || [])) {
      const mod = p.module; // e.g., "git.diff.core@var4"
      if (!moduleInfo.has(mod)) {
        moduleInfo.set(mod, {
          goals: new Set(),
          risk: 0.5,
          ev: 0.5,
          provides: new Set(),
          requires: new Set()
        });
      }
      const info = moduleInfo.get(mod);
      for (const g of (p.covers || [])) info.goals.add(g);
      if (typeof p.risk === 'number') info.risk = p.risk;
      if (typeof p.evidence_strength === 'number') info.ev = p.evidence_strength;
      for (const port of (p.provides_ports || [])) {
        if (typeof port === 'string' && port.length) {
          info.provides.add(port);
          if (!modulesProvidingPort.has(port)) modulesProvidingPort.set(port, new Set());
          modulesProvidingPort.get(port).add(mod);
        }
      }
      for (const req of (p.requires || [])) {
        if (typeof req === 'string' && req.length) {
          info.requires.add(req);
        }
      }
    }

    const available = new Set(moduleInfo.keys());
    const selectedSet = new Set();
    const selectionOrder = [];
    const covered = new Set();
    const selectedPorts = new Set();

    function ensureProvides(targetSet, modId) {
      const info = moduleInfo.get(modId);
      if (!info) return;
      for (const port of info.provides) targetSet.add(port);
    }

    for (const modId of selectedSet) ensureProvides(selectedPorts, modId);

    function bundleFor(moduleId) {
      if (!respectRequires) {
        if (!available.has(moduleId)) return { feasible: false, modules: [] };
        return { feasible: true, modules: [moduleId] };
      }

      const toAdd = new Set();
      const visiting = new Set();
      const plannedPorts = new Set(selectedPorts);

      function ensurePlanned(modId) {
        const info = moduleInfo.get(modId);
        if (!info) return;
        for (const port of info.provides) plannedPorts.add(port);
      }

      for (const mod of selectedSet) ensurePlanned(mod);

      function dfs(id) {
        if (selectedSet.has(id)) {
          ensurePlanned(id);
          return true;
        }
        if (!available.has(id) && !toAdd.has(id)) return false;
        const info = moduleInfo.get(id);
        if (!info) return false;
        if (visiting.has(id)) return false;
        visiting.add(id);

        ensurePlanned(id);

        for (const req of info.requires) {
          if (plannedPorts.has(req) || info.provides.has(req)) continue;

          let satisfied = false;
          for (const pending of toAdd) {
            const pendingInfo = moduleInfo.get(pending);
            if (pendingInfo && pendingInfo.provides.has(req)) {
              satisfied = true;
              break;
            }
          }
          if (satisfied) continue;

          const candidates = modulesProvidingPort.get(req);
          if (!candidates || candidates.size === 0) {
            visiting.delete(id);
            return false;
          }

          let provider = null;
          for (const cand of candidates) {
            if (selectedSet.has(cand) || toAdd.has(cand)) {
              provider = cand;
              break;
            }
          }

          if (!provider) {
            const availableCandidates = [...candidates].filter(c => available.has(c));
            if (availableCandidates.length === 0) {
              visiting.delete(id);
              return false;
            }

            let bestProvider = null;
            let bestScore = Number.NEGATIVE_INFINITY;
            for (const cand of availableCandidates) {
              const candInfo = moduleInfo.get(cand);
              if (!candInfo) continue;
              const score = (candInfo.ev * 0.5) - candInfo.risk;
              if (score > bestScore) {
                bestScore = score;
                bestProvider = cand;
              }
            }

            if (!bestProvider) {
              visiting.delete(id);
              return false;
            }

            provider = bestProvider;
          }

          if (!dfs(provider)) {
            visiting.delete(id);
            return false;
          }
          ensurePlanned(provider);
        }

        visiting.delete(id);
        if (!selectedSet.has(id)) {
          toAdd.add(id);
          ensurePlanned(id);
        }
        return true;
      }

      if (!dfs(moduleId)) return { feasible: false, modules: [] };
      return { feasible: true, modules: Array.from(toAdd) };
    }

    function gainOf(mod) {
      if (!available.has(mod)) return { gain: Number.NEGATIVE_INFINITY, modules: [] };
      const bundle = bundleFor(mod);
      if (!bundle.feasible || bundle.modules.length === 0) {
        if (!bundle.feasible) return { gain: Number.NEGATIVE_INFINITY, modules: [] };
      }

      let gsum = 0;
      let riskPenalty = 0;
      let evidenceBonus = 0;
      let duplicatePenalty = 0;
      const bundlePorts = new Set();

      for (const id of bundle.modules) {
        const info = moduleInfo.get(id);
        if (!info) continue;
        for (const g of info.goals) {
          if (!covered.has(g)) gsum += (typeof weights[g] === 'number' ? weights[g] : 1);
        }
        riskPenalty += info.risk;
        evidenceBonus += info.ev * 0.5;

        for (const port of info.provides) {
          if (selectedPorts.has(port) || bundlePorts.has(port)) duplicatePenalty += 1;
          bundlePorts.add(port);
        }
      }

      return { gain: gsum + evidenceBonus - riskPenalty - duplicatePenalty, modules: bundle.modules };
    }

    while (available.size > 0) {
      let best = null;
      let bestGain = Number.NEGATIVE_INFINITY;
      let bestBundle = [];
      for (const mod of available) {
        const result = gainOf(mod);
        if (result.gain > bestGain) {
          bestGain = result.gain;
          best = mod;
          bestBundle = result.modules;
        }
      }
      if (!best || bestGain <= 0) break;

      for (const id of bestBundle) {
        if (selectedSet.has(id)) continue;
        selectedSet.add(id);
        available.delete(id);
        selectionOrder.push(id);
        const info = moduleInfo.get(id);
        if (info) {
          for (const g of info.goals) covered.add(g);
          for (const port of info.provides) selectedPorts.add(port);
        }
      }
      if ([...goals].every(g => covered.has(g))) break;
    }

    const modulesSeen = new Set();
    const modulesList = [];
    for (const id of selectionOrder) {
      const base = id.split('@')[0];
      if (modulesSeen.has(base)) continue;
      modulesSeen.add(base);
      modulesList.push({ id: base, version: "0.1.0" });
    }

    const compose = {
      run_id: new Date().toISOString(),
      modules: modulesList,
      wiring: [],
      glue: [],
      constraints: ["no-cross-imports", "ports-only-coupling"]
    };
    await fs.writeFile(path.resolve(opts.out || './compose.greedy.json'), JSON.stringify(compose, null, 2));
    console.log(`✓ Wrote ${opts.out || './compose.greedy.json'} with ${modulesList.length} modules`);
  });

program
  .command('gates')
  .argument('<mode>', 'conceptual|shipping')
  .requiredOption('--compose <file>', 'Path to compose.json')
  .requiredOption('--modules-root <dir>', 'Root dir of modules')
  .option('--overrides <file>', 'Path to compose overrides JSON')
  .option('--emit-events', 'Emit line-delimited JSON events', false)
  .option('--events-out <file>', 'Write events to file (NDJSON)')
  .option('--events-truncate', 'Truncate events output file before writing', false)
  .option('--strict-events', 'Validate events against tm-events@1 schema (fail fast)', false)
  .option('--hook-cmd <cmd>', 'Run a hook that receives a summary JSON on stdin')
  .option('--timeout-ms <n>', 'Per-test timeout (ms)', '60000')
  .option('--npm-pack', 'Run npm pack smoke against winner workspace', false)
  .description('Run conceptual / shipping gates')
  .action(async (mode, opts) => {
    const composePath = path.resolve(opts.compose);
    const modulesRoot = path.resolve(opts.modules_root || opts.modulesRoot);
    const baseCompose = await loadJSON(composePath);

    let compose = cloneJson(baseCompose);
    let overrideSummary = null;
    let overridesPath = null;

    if (opts.overrides) {
      overridesPath = path.resolve(opts.overrides);
      let overrides;
      try {
        overrides = await loadJSON(overridesPath);
      } catch (err) {
        const rel = path.relative(process.cwd(), overridesPath) || overridesPath;
        if (err && err.code === 'ENOENT') {
          throw tmError('E_COMPOSE_OVERRIDES', `Override file not found: ${rel}`);
        }
        const message = err?.message || `Failed to read overrides at ${rel}`;
        const failure = tmError('E_COMPOSE_OVERRIDES', message);
        failure.cause = err;
        throw failure;
      }
      const merged = mergeComposeOverrides(baseCompose, overrides);
      compose = merged.compose;
      overrideSummary = merged.summary;
    }

    await validateAgainst('compose.schema.json', compose);

    const composeJson = JSON.stringify(compose);
    const composeHash = crypto.createHash('sha256').update(composeJson).digest('hex');
    const runId = compose.run_id || new Date().toISOString();
    const moduleIds = (compose.modules || []).map(m => m.id);
    const overridesRel = overridesPath ? (path.relative(process.cwd(), overridesPath) || overridesPath) : null;
    const composeRel = path.relative(process.cwd(), composePath) || composePath;
    const manifests = {};
    const ee = await makeEventEmitter({
      emitEvents: opts.emitEvents,
      eventsOut: opts.eventsOut ? path.resolve(opts.eventsOut) : null,
      eventsTruncate: opts.eventsTruncate,
      strictEvents: opts.strictEvents,
      context: { run_id: runId, mode, compose_sha256: composeHash }
    });
    const gateStart = Date.now();
    const summary = {
      run_id: runId,
      mode,
      modules: moduleIds,
      results: { passed: 0, failed: 0 }
    };
    let successMessage = '';
    let failureCode = null;
    let failureDetail = null;

    try {
      if (overrideSummary?.changed) {
        const detail = { ...overrideSummary.detail, compose_path: composeRel };
        if (overridesRel) detail.overrides_path = overridesRel;
        await ee.emit('COMPOSE_OVERRIDES_APPLIED', detail);
        const summaryText = describeOverrideSummary(overrideSummary);
        ee.info(`✓ Overrides applied${overridesRel ? ` (${overridesRel})` : ''}${summaryText ? `: ${summaryText}` : ''}`);
      } else if (overridesRel) {
        ee.info(`Overrides file ${overridesRel} did not change the compose plan.`);
      }

      await ee.emit('GATES_START', { compose_path: composePath, modules_total: moduleIds.length });
      // Shared checks
      for (const m of compose.modules || []) {
        const mroot = path.join(modulesRoot, m.id);
        const fp = path.join(mroot, 'module.json');
        const manifest = await validateFile('module.schema.json', fp);
        manifests[m.id] = { manifest, root: mroot };
        if (!Array.isArray(manifest.evidence) || manifest.evidence.length === 0) {
          throw tmError('E_REQUIRE_UNSAT', `Gate failure: ${m.id} has no evidence bindings.`);
        }
        if (!Array.isArray(manifest.tests) || manifest.tests.length === 0) {
          throw tmError('E_REQUIRE_UNSAT', `Gate failure: ${m.id} defines no tests.`);
        }
        if (!Array.isArray(manifest.invariants) || manifest.invariants.length === 0) {
          throw tmError('E_REQUIRE_UNSAT', `Gate failure: ${m.id} defines no invariants.`);
        }
      }

      // Cross-import lint (ESLint preferred, regex fallback)
      let ranEslint = false;
      const lintStart = Date.now();
      await ee.emit('LINT_START', { lint_tool: 'eslint' });
      try {
        const { errorCount, diagnostics } = await collectCrossImportDiagnostics([modulesRoot]);
        ranEslint = true;
        if (errorCount > 0) {
          const formatted = diagnostics.slice(0, 20).map(d => {
            const rel = path.relative(process.cwd(), d.file);
            return `${rel}:${d.line}:${d.column} ${d.message}`;
          }).join('\n');
          const first = diagnostics[0];
          failureCode = 'E_LINT';
          await ee.emit('LINT_FAIL', {
            lint_tool: 'eslint',
            code: 'E_LINT',
            message: first?.message,
            file: first ? path.relative(process.cwd(), first.file) : undefined,
            line: first?.line,
            dur_ms: Date.now() - lintStart
          });
          throw tmError('E_LINT', 'ESLint cross-module check failed:\n' + formatted);
        }
        await ee.emit('LINT_PASS', { lint_tool: 'eslint', dur_ms: Date.now() - lintStart });
      } catch (err) {
        if (!ranEslint && err && (err.code === 'ERR_MODULE_NOT_FOUND' || (typeof err.message === 'string' && err.message.includes("Cannot find module 'eslint'")))) {
          await ee.emit('GATES_WARN', { code: 'WARN_ESLINT_UNAVAILABLE', message: 'eslint not available; falling back to regex lint' });
          const fallbackStart = Date.now();
          await ee.emit('LINT_START', { lint_tool: 'fallback-regex' });
          const lint = await crossImportLint(modulesRoot);
          if (lint.length) {
            const formatted = lint.slice(0, 20).map(entry => {
              const rel = path.relative(process.cwd(), entry.file);
              return `${rel}:${entry.line} ${entry.msg}`;
            }).join('\n');
            failureCode = 'E_LINT';
            await ee.emit('LINT_FAIL', {
              lint_tool: 'fallback-regex',
              code: 'E_LINT',
              message: lint[0].msg,
              file: path.relative(process.cwd(), lint[0].file),
              line: lint[0].line,
              dur_ms: Date.now() - fallbackStart
            });
            throw tmError('E_LINT', 'Cross-module import violations:\n' + formatted);
          }
          await ee.emit('LINT_PASS', { lint_tool: 'fallback-regex', dur_ms: Date.now() - fallbackStart });
        } else if (!ranEslint) {
          throw err instanceof Error ? err : new Error(String(err));
        } else {
          throw err instanceof Error ? err : new Error(String(err));
        }
      }

      if (mode === 'conceptual') {
        successMessage = '✓ Conceptual gates passed.';
      } else {
        const timeoutMs = Number(opts.timeoutMs ?? 60_000);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          throw tmError('E_REQUIRE_UNSAT', 'Gate failure: invalid --timeout-ms value.');
        }

        const reqProblems = verifyPortRequires(
          compose,
          Object.fromEntries(Object.entries(manifests).map(([k, v]) => [k, v.manifest]))
        );
        if (reqProblems.length) {
          failureCode = 'E_REQUIRE_UNSAT';
          throw tmError('E_REQUIRE_UNSAT', 'Gate failure: port requirements unmet:\n' + reqProblems.join('\n'));
        }

        if (!(compose.wiring && compose.wiring.length) && !(compose.constraints && compose.constraints.length)) {
          throw tmError('E_REQUIRE_UNSAT', 'Gate failure: shipping mode requires non-empty wiring or constraints.');
        }

        let total = 0;
        let passed = 0;
        for (const m of compose.modules || []) {
          const { manifest, root } = manifests[m.id];
          for (const t of manifest.tests || []) {
            if (typeof t !== 'string') {
              throw tmError('E_REQUIRE_UNSAT', `Test entry for ${m.id} is not a string: ${JSON.stringify(t)}`);
            }
            total += 1;
            const testStart = Date.now();
            await ee.emit('TEST_START', { module: m.id, test: t });
            try {
              if (t.startsWith('script:')) {
                const scriptRel = t.replace(/^script:/, '').trim();
                if (!scriptRel) throw tmError('E_REQUIRE_UNSAT', 'Script entry missing path');
                const scriptAbs = path.join(root, scriptRel);
                await runCmd(process.execPath, [scriptAbs], { cwd: root, timeoutMs });
              } else if (t.endsWith('.json')) {
                const runner = path.join(root, 'tests', 'runner.mjs');
                await fs.access(runner);
                const specPath = path.join(root, t);
                await runCmd(
                  process.execPath,
                  [runner, '--spec', specPath, '--moduleRoot', root],
                  { cwd: root, timeoutMs }
                );
              } else {
                throw tmError('E_REQUIRE_UNSAT', `Unknown test entry: ${t}`);
              }
              const dur = Date.now() - testStart;
              passed += 1;
              await ee.emit('TEST_PASS', { module: m.id, test: t, dur_ms: dur });
            } catch (e) {
              const dur = Date.now() - testStart;
              const errMsg = e instanceof Error ? e.message : String(e);
              failureCode = 'E_TEST';
              await ee.emit('TEST_FAIL', { module: m.id, test: t, dur_ms: dur, error: errMsg, code: 'E_TEST' });
              summary.results = { passed, failed: total - passed };
              throw tmError('E_TEST', `Test failed for ${m.id} (${t}): ${errMsg}`);
            }
          }
        }

        summary.results = { passed, failed: 0 };
        const workspaceRoot = path.resolve(modulesRoot, '..');
        const portsDir = await resolvePortsDir(workspaceRoot);
        const portHarness = await buildPortHarness(manifests, workspaceRoot, portsDir, ee);
        const dirsToCheck = [modulesRoot];
        const glueDir = path.join(workspaceRoot, 'glue');
        try {
          const glueStat = await fs.stat(glueDir);
          if (glueStat.isDirectory()) dirsToCheck.push(glueDir);
        } catch {}

        const includeDirs = [...dirsToCheck];
        if (portHarness.harnessDir) includeDirs.push(portHarness.harnessDir);
        includeDirs.push(portsDir);

        let tsFiles = [];
        for (const dir of dirsToCheck) {
          const files = await listFilesRec(dir, ['.ts', '.tsx']);
          tsFiles = tsFiles.concat(files);
        }

        const mustTypeCheck = tsFiles.length > 0 || (portHarness.entries && portHarness.entries.length > 0);

        if (mustTypeCheck) {
          const tmDir = path.join(workspaceRoot, '.tm');
          await fs.mkdir(tmDir, { recursive: true });
          const tscLogPath = path.join(tmDir, 'tsc.log');
          const tsProjectPath = path.join(tmDir, 'tsconfig.json');
          const includePaths = includeDirs.map(dir => {
            const rel = path.relative(tmDir, dir) || '.';
            return rel.replace(/\\/g, '/');
          });
          const tsConfig = {
            compilerOptions: {
              module: "NodeNext",
              moduleResolution: "NodeNext",
              target: "ES2022",
              strict: true,
              skipLibCheck: true,
              allowImportingTsExtensions: true
            },
            include: includePaths
          };
          await fs.writeFile(tsProjectPath, JSON.stringify(tsConfig, null, 2));

          const requireForTs = createRequire(import.meta.url);
          let tscBin;
          try {
            const tsPackagePath = requireForTs.resolve('typescript/package.json');
            const tsPackage = requireForTs(tsPackagePath);
            const binRelative = tsPackage && tsPackage.bin && tsPackage.bin.tsc ? tsPackage.bin.tsc : 'bin/tsc';
            tscBin = path.join(path.dirname(tsPackagePath), binRelative);
          } catch {
            tscBin = null;
          }
          if (!tscBin) {
            throw tmError('E_TSC', 'TypeScript compiler not found. Install with `npm i -D typescript`.');
          }
          try {
            await fs.access(tscBin);
          } catch {
            throw tmError('E_TSC', 'TypeScript compiler not found. Install with `npm i -D typescript`.');
          }

          await ee.emit('TSC_START', { artifact: path.relative(process.cwd(), tscLogPath) });
          const start = Date.now();
          const child = spawn(process.execPath, [tscBin, '--noEmit', '--project', tsProjectPath], {
            cwd: workspaceRoot,
            shell: false
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', d => { stdout += d; });
          child.stderr.on('data', d => { stderr += d; });
          const exitCode = await new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('exit', code => resolve(code));
          });
          const duration = Date.now() - start;
          const combined = `${stdout}${stderr}`;
          await fs.writeFile(tscLogPath, combined);
          if (exitCode !== 0) {
            const lines = combined.split(/\r?\n/).filter(Boolean).slice(0, 10);
            failureCode = 'E_TSC';
            await ee.emit('TSC_FAIL', { dur_ms: duration, artifact: path.relative(process.cwd(), tscLogPath), code: 'E_TSC' });
            if (portHarness.entries?.length) {
              const firstLine = lines[0] || '';
              const match = portHarness.entries.find(entry => firstLine.includes(path.basename(entry.harnessPath)) || combined.includes(entry.harnessPath));
              if (match) {
                await ee.emit('PORT_CHECK_FAIL', { module: match.module, port: match.port, error: 'port_conformance_failed', code: 'E_PORT_CONFORMANCE' });
              }
            }
            throw tmError('E_TSC', `TypeScript check failed:\n${lines.join('\n')}\nSee full log at ${tscLogPath}`);
          } else {
            await ee.emit('TSC_PASS', { dur_ms: duration, artifact: path.relative(process.cwd(), tscLogPath) });
            if (portHarness.entries?.length) {
              for (const entry of portHarness.entries) {
                await ee.emit('PORT_CHECK_PASS', { module: entry.module, port: entry.port });
              }
            }
          }
        }

        if (opts.npmPack) {
          const winnerDir = await locateWinnerDir(composePath);
          if (!winnerDir) {
            await ee.emit('GATES_WARN', {
              code: 'WARN_NPM_PACK_NO_WORKSPACE',
              message: 'npm pack requested but no winner workspace with package.json was found; skipping smoke test.'
            });
            summary.npm_pack = { status: 'skipped', reason: 'workspace_missing' };
          } else {
            try {
              const result = await runNpmPackSmoke(winnerDir, ee);
              const relWinner = path.relative(process.cwd(), winnerDir) || '.';
              if (result?.skipped) {
                summary.npm_pack = { status: 'skipped', reason: result.reason };
              } else {
                summary.npm_pack = {
                  status: 'passed',
                  workspace: relWinner,
                  tarball: result?.tarball || null
                };
              }
            } catch (err) {
              if (err && err.code === 'npm_pack_failed') {
                failureCode = 'npm_pack_failed';
                summary.npm_pack = {
                  status: 'failed',
                  diagnostics: Array.isArray(err.diagnostics) ? err.diagnostics.slice(0, 5) : []
                };
              }
              throw err;
            }
          }
        }

        successMessage = `✓ Shipping tests passed (${passed}/${total}).`;
      }
      summary.duration_ms = Date.now() - gateStart;

      if (opts.hookCmd) {
        await new Promise((resolve, reject) => {
          const child = spawn(opts.hookCmd, {
            shell: true,
            stdio: ['pipe', 'inherit', 'inherit']
          });
          child.on('error', reject);
          child.on('exit', code => {
            if (code === 0) resolve();
            else reject(tmError('E_HOOK', `Hook exited with code ${code}`));
          });
          child.stdin.write(JSON.stringify(summary));
          child.stdin.end();
        });
      }

      await ee.emit('GATES_PASS', { passed: summary.results.passed, failed: summary.results.failed, dur_ms: summary.duration_ms });
      if (successMessage) ee.info(successMessage);
    } catch (err) {
      summary.duration_ms = Date.now() - gateStart;
      const message = err instanceof Error ? err.message : String(err);
      summary.error = message;
      const code = err && typeof err === 'object' && 'code' in err && err.code ? err.code : (failureCode || 'E_UNKNOWN');
      summary.code = code;
      if (failureDetail) summary.failure_detail = failureDetail;
      const failDetail = failureDetail ? { ...failureDetail } : {};
      await ee.emit('GATES_FAIL', { code, message, passed: summary.results.passed, failed: summary.results.failed, dur_ms: summary.duration_ms, ...failDetail });
      throw err instanceof Error ? err : new Error(message);
    } finally {
      await ee.close();
    }
  });

program
  .command('module')
  .requiredOption('--new <id>', 'Module id, e.g. git.diff.core')
  .option('--root <dir>', 'Modules root directory', 'modules')
  .description('Create a new module scaffold that passes schema validation')
  .action(async (opts) => {
    const id = opts.new;
    if (!/^[a-z][a-z0-9_.-]+$/.test(id)) {
      throw new Error('Invalid module id. Use lowercase letters, digits, dot/underscore/dash.');
    }
    const dir = path.resolve(opts.root, id);
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true });

    const manifest = {
      id,
      version: "0.1.0",
      summary: "New module",
      provides: ["ExamplePort@1"],
      requires: [],
      inputs: {},
      outputs: {},
      side_effects: [],
      invariants: ["deterministic(outputs | inputs)"],
      tests: ["tests/spec_example.json"],
      evidence: [
        { kind: "file", file: "src/lib.ts", lines: "1-1", note: "placeholder" }
      ]
    };
    await fs.writeFile(path.join(dir, 'module.json'), JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(dir, 'src', 'lib.ts'), '// TODO: implement');
    await fs.writeFile(path.join(dir, 'tests', 'spec_example.json'), JSON.stringify({ name: "example" }, null, 2));

    // Validate manifest
    await validateFile('module.schema.json', path.join(dir, 'module.json'));

    console.log('✓ Created module at ' + dir);
  });

program.parseAsync().catch(err => {
  console.error('tm error:', err.message);
  process.exit(1);
});
