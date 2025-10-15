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
import { evaluateSideEffects } from './scripts/lib/side-effects.mjs';
import { validateEventsFile } from './scripts/events-validate.mjs';
import { replayEvents } from './scripts/events-replay.mjs';

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

function parseSemver(version) {
  if (typeof version !== 'string') return { major: 0, minor: 0, patch: 0 };
  const match = version.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return { major: 0, minor: 0, patch: 0 };
  const [, major, minor, patch] = match;
  return {
    major: Number(major) || 0,
    minor: Number(minor) || 0,
    patch: Number(patch) || 0
  };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function runCommandCapture(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, ...options });
    let stdout = '';
    let stderr = '';
    let failed = false;
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      failed = true;
      resolve({ ok: false, error: err, stdout, stderr, code: err?.code });
    });
    child.on('exit', (code) => {
      if (failed) return;
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

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
  const allowed = new Set((opts.allowedExitCodes || []).map(code => Number(code)));
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: opts.env ? { ...process.env, ...opts.env } : process.env
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
      if (code === 0 || allowed.has(code)) {
        resolve({ out, err, code });
      } else {
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

const SIDE_EFFECTS_GUARD = path.join(__dirname, 'scripts', 'side-effects-guard.mjs');
const SIDE_EFFECTS_DIR = path.join(process.cwd(), '.tm', 'side-effects');
const TEST_SKIP_EXIT_CODE = 64;

function sanitizeSegment(value, fallback) {
  const text = String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '').replace(/_+$/, '');
  if (text.length === 0) return fallback;
  return text.slice(0, 80);
}

async function prepareSideEffectsLog(moduleId, caseName) {
  await fs.mkdir(SIDE_EFFECTS_DIR, { recursive: true });
  const modulePart = sanitizeSegment(moduleId, 'module');
  const casePart = sanitizeSegment(caseName, 'case');
  const logPath = path.join(SIDE_EFFECTS_DIR, `${modulePart}__${casePart}.log`);
  await fs.rm(logPath, { force: true }).catch(() => {});
  return logPath;
}

async function runNodeWithSideEffectsGuard({ scriptPath, args = [], cwd, timeoutMs, env = {}, moduleId, caseName, allowedExitCodes = [] }) {
  if (!moduleId) {
    throw tmError('E_SIDEEFFECTS_INTERNAL', 'Side-effects guard requires module id');
  }
  const logPath = await prepareSideEffectsLog(moduleId, caseName || path.basename(scriptPath));
  const finalArgs = ['--import', SIDE_EFFECTS_GUARD, scriptPath, ...args];
  const spawnEnv = {
    TM_SIDEEFFECTS_LOG: logPath,
    TM_SIDEEFFECTS_MODULE: moduleId,
    TM_SIDEEFFECTS_CASE: caseName || path.basename(scriptPath),
    ...env
  };
  const result = await runCmd(process.execPath, finalArgs, { cwd, timeoutMs, env: spawnEnv, allowedExitCodes });
  return { ...result, logPath };
}

async function readSideEffectEvents(logPath) {
  if (!logPath) return [];
  try {
    const text = await fs.readFile(logPath, 'utf8');
    if (!text.trim()) return [];
    const lines = text.split(/\r?\n/).filter(Boolean);
    const events = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        events.push(parsed);
      } catch {
        events.push({ type: 'parse_error', raw: line });
      }
    }
    return events;
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

const SIDEEFFECT_SAMPLE_LIMIT = 5;

function createSideEffectsAccumulator(sampleLimit = SIDEEFFECT_SAMPLE_LIMIT) {
  return { map: new Map(), sampleLimit };
}

function recordSideEffectsObservation(acc, moduleId, summary) {
  if (!acc || !moduleId || !summary) return;
  if (!acc.map.has(moduleId)) {
    acc.map.set(moduleId, {
      declared: new Set(),
      observed: new Set(),
      missing: new Set(),
      fsCount: 0,
      fsOutside: false,
      fsSamples: [],
      fsSampleSeen: new Set(),
      fsOutsideSamples: [],
      fsOutsideSeen: new Set(),
      processTotal: 0,
      processCategories: new Map()
    });
  }
  const entry = acc.map.get(moduleId);
  for (const value of summary.declared || []) {
    if (typeof value === 'string' && value) entry.declared.add(value);
  }
  for (const value of summary.observed_operations || []) {
    if (typeof value === 'string' && value) entry.observed.add(value);
  }
  for (const value of summary.undeclared_operations || []) {
    if (typeof value === 'string' && value) entry.missing.add(value);
  }
  if (summary.fs_write) {
    entry.fsCount += Number(summary.fs_write.count || 0);
    if (summary.fs_write.outside_module_root) entry.fsOutside = true;
    if (Array.isArray(summary.fs_write.sample_paths)) {
      for (const sample of summary.fs_write.sample_paths) {
        if (!sample || typeof sample.path !== 'string') continue;
        const key = `${sample.path}|${sample.inside_module_root ? '1' : '0'}`;
        if (!entry.fsSampleSeen.has(key) && entry.fsSamples.length < acc.sampleLimit) {
          entry.fsSampleSeen.add(key);
          entry.fsSamples.push({
            path: sample.path,
            inside_module_root: Boolean(sample.inside_module_root)
          });
        }
      }
    }
    if (Array.isArray(summary.fs_write.outside_samples)) {
      for (const sample of summary.fs_write.outside_samples) {
        if (typeof sample !== 'string' || !sample) continue;
        if (!entry.fsOutsideSeen.has(sample) && entry.fsOutsideSamples.length < acc.sampleLimit) {
          entry.fsOutsideSeen.add(sample);
          entry.fsOutsideSamples.push(sample);
        }
      }
    }
  }
  if (summary.processes) {
    entry.processTotal += Number(summary.processes.total || 0);
    const categories = summary.processes.categories || {};
    for (const [effect, info] of Object.entries(categories)) {
      if (!entry.processCategories.has(effect)) {
        entry.processCategories.set(effect, { count: 0, sample_commands: [], seen: new Set() });
      }
      const cat = entry.processCategories.get(effect);
      cat.count += Number(info?.count || 0);
      if (Array.isArray(info?.sample_commands)) {
        for (const cmd of info.sample_commands) {
          if (typeof cmd !== 'string' || !cmd.trim()) continue;
          if (!cat.seen.has(cmd) && cat.sample_commands.length < acc.sampleLimit) {
            cat.seen.add(cmd);
            cat.sample_commands.push(cmd);
          }
        }
      }
    }
  }
}

function finalizeSideEffectsSummary(acc) {
  if (!acc || !acc.map || acc.map.size === 0) return null;
  const modules = {};
  const sortedEntries = Array.from(acc.map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [moduleId, entry] of sortedEntries) {
    const categories = {};
    const sortedCategories = Array.from(entry.processCategories.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [effect, info] of sortedCategories) {
      categories[effect] = {
        count: info.count,
        sample_commands: info.sample_commands
      };
    }
    modules[moduleId] = {
      declared: Array.from(entry.declared).sort(),
      observed_operations: Array.from(entry.observed).sort(),
      undeclared_operations: Array.from(entry.missing).sort(),
      fs_write: {
        count: entry.fsCount,
        outside_module_root: entry.fsOutside,
        sample_paths: entry.fsSamples,
        outside_samples: entry.fsOutsideSamples
      },
      processes: {
        total: entry.processTotal,
        categories
      }
    };
  }
  return { modules };
}

let oracleSpecValidatorPromise = null;

async function getOracleSpecValidator() {
  if (!oracleSpecValidatorPromise) {
    oracleSpecValidatorPromise = (async () => {
      const ajv = makeAjv();
      const schemaPath = path.join(specDir, 'oracle.schema.json');
      const schema = await loadJSON(schemaPath);
      return ajv.compile(schema);
    })();
  }
  return oracleSpecValidatorPromise;
}

async function loadOracleSpecFile(specPath) {
  const rel = path.relative(process.cwd(), specPath) || specPath;
  let data;
  try {
    data = await loadJSON(specPath);
  } catch (err) {
    const failure = tmError('E_ORACLE_SPEC', `Failed to read oracle spec ${rel}: ${err?.message || err}`);
    failure.cause = err;
    throw failure;
  }
  const validate = await getOracleSpecValidator();
  const valid = validate(data);
  if (!valid) {
    const issues = (validate.errors || []).map(err => ({
      path: err.instancePath || '(root)',
      message: err.message || 'invalid value'
    }));
    const summary = issues.slice(0, 3).map(issue => `${issue.path} ${issue.message}`.trim()).filter(Boolean).join('; ');
    const failure = tmError('E_ORACLE_SPEC', `Oracle spec ${rel} failed schema validation: ${summary || 'invalid configuration'}`);
    if (issues.length) {
      failure.detail = { ...(failure.detail || {}), spec: rel, errors: issues };
    }
    throw failure;
  }
  return data;
}

function normalizeOracleCase(raw, index, specPath) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw tmError('E_ORACLE_SPEC', `Oracle case #${index + 1} in ${specPath} must be an object.`);
  }
  const nameRaw = typeof raw.name === 'string' ? raw.name.trim() : '';
  const name = nameRaw || `case_${index + 1}`;
  const entryRaw = typeof raw.entry === 'string' ? raw.entry.trim() : '';
  if (!entryRaw) {
    throw tmError('E_ORACLE_SPEC', `Oracle case ${name} in ${specPath} is missing an "entry" script.`);
  }
  let args = [];
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args)) {
      throw tmError('E_ORACLE_SPEC', `Oracle case ${name} in ${specPath} expects "args" to be an array.`);
    }
    args = raw.args.map((value, idx) => {
      if (value === undefined || value === null) return '';
      const text = String(value);
      if (!text.length) {
        throw tmError('E_ORACLE_SPEC', `Oracle case ${name} arg[${idx}] in ${specPath} must not be empty.`);
      }
      return text;
    });
  }
  const repeatRaw = raw.repeat ?? raw.runs ?? 2;
  let repeat = Number(repeatRaw);
  if (!Number.isFinite(repeat) || repeat < 2) repeat = 2;
  repeat = Math.floor(repeat);
  const timeoutRaw = raw.timeoutMs ?? raw.timeout_ms ?? null;
  const timeoutMs = Number.isFinite(Number(timeoutRaw)) && Number(timeoutRaw) > 0 ? Number(timeoutRaw) : null;
  const captureConfig = raw.capture && typeof raw.capture === 'object' ? raw.capture : {};
  const captureStdout = captureConfig.stdout === false ? false : true;
  const captureStderr = captureConfig.stderr === false ? false : true;
  const captureSideEffects = captureConfig.side_effects === false ? false : true;
  const captureFiles = Array.isArray(captureConfig.files) ? captureConfig.files.map(f => String(f)) : [];
  const resetPaths = Array.isArray(raw.reset) ? raw.reset.map(p => String(p)) : [];
  const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : null;
  const env = raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
    ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)]))
    : null;

  return {
    name,
    entry: entryRaw,
    args,
    repeat,
    timeoutMs,
    captureStdout,
    captureStderr,
    captureSideEffects,
    captureFiles,
    resetPaths,
    cwd,
    env
  };
}

function normalizeOracleSpec(spec, specPath) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw tmError('E_ORACLE_SPEC', `Oracle spec at ${specPath} must be an object.`);
  }
  const moduleId = typeof spec.module === 'string' ? spec.module.trim() : '';
  if (!moduleId) {
    throw tmError('E_ORACLE_SPEC', `Oracle spec at ${specPath} is missing a "module" id.`);
  }
  if (!Array.isArray(spec.cases) || spec.cases.length === 0) {
    throw tmError('E_ORACLE_SPEC', `Oracle spec at ${specPath} must define at least one case.`);
  }
  const cases = spec.cases.map((raw, idx) => normalizeOracleCase(raw, idx, specPath));
  return { module: moduleId, cases };
}

function compareOracleAttempts(attempts, caseConfig) {
  if (!attempts.length) return null;
  const first = attempts[0];
  for (let i = 1; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    if (caseConfig.captureStdout && attempt.stdout !== first.stdout) {
      return { field: 'stdout', attempt: i + 1 };
    }
    if (caseConfig.captureStderr && attempt.stderr !== first.stderr) {
      return { field: 'stderr', attempt: i + 1 };
    }
    for (const file of caseConfig.captureFiles) {
      if ((attempt.files?.[file] ?? null) !== (first.files?.[file] ?? null)) {
        return { field: `file:${file}`, attempt: i + 1 };
      }
    }
    if (caseConfig.captureSideEffects) {
      const left = JSON.stringify(attempt.sideEffects || []);
      const right = JSON.stringify(first.sideEffects || []);
      if (left !== right) {
        return { field: 'side_effects', attempt: i + 1 };
      }
    }
  }
  return null;
}

async function executeOracleCase({ caseConfig, moduleId, moduleRoot, manifest }) {
  const entryAbs = path.isAbsolute(caseConfig.entry) ? caseConfig.entry : path.join(moduleRoot, caseConfig.entry);
  const cwd = caseConfig.cwd ? (path.isAbsolute(caseConfig.cwd) ? caseConfig.cwd : path.join(moduleRoot, caseConfig.cwd)) : moduleRoot;
  const repeat = Math.max(caseConfig.repeat || 2, 2);
  const timeoutMs = caseConfig.timeoutMs ?? 60_000;
  const attempts = [];
  for (let attempt = 0; attempt < repeat; attempt += 1) {
    for (const reset of caseConfig.resetPaths) {
      const target = path.isAbsolute(reset) ? reset : path.join(cwd, reset);
      await fs.rm(target, { force: true, recursive: true }).catch(() => {});
    }
    let runResult;
    try {
      runResult = await runNodeWithSideEffectsGuard({
        scriptPath: entryAbs,
        args: caseConfig.args,
        cwd,
        timeoutMs,
        moduleId,
        caseName: caseConfig.name,
        env: caseConfig.env || undefined
      });
    } catch (err) {
      const failure = tmError(err?.code || 'E_ORACLE_EXEC', err instanceof Error ? err.message : String(err));
      failure.detail = { module: moduleId, case: caseConfig.name, attempt: attempt + 1 };
      failure.cause = err;
      throw failure;
    }
    const events = await readSideEffectEvents(runResult.logPath);
    const evaluation = evaluateSideEffects({ events, moduleId, manifest, moduleRoot });
    if (evaluation.violation) {
      const sideErr = evaluation.violation;
      if (!sideErr.detail || typeof sideErr.detail !== 'object') sideErr.detail = {};
      sideErr.detail.module = moduleId;
      sideErr.detail.case = caseConfig.name;
      sideErr.detail.attempt = attempt + 1;
      throw sideErr;
    }

    const capture = {
      stdout: caseConfig.captureStdout ? runResult.out : null,
      stderr: caseConfig.captureStderr ? runResult.err : null,
      files: {},
      sideEffects: caseConfig.captureSideEffects ? events : []
    };

    for (const rel of caseConfig.captureFiles) {
      const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
      let encoded = null;
      try {
        const buf = await fs.readFile(abs);
        encoded = buf.toString('base64');
      } catch (err) {
        if (!(err && err.code === 'ENOENT')) throw err;
        encoded = null;
      }
      capture.files[rel] = encoded;
    }

    attempts.push(capture);
  }

  const mismatch = compareOracleAttempts(attempts, caseConfig);
  if (mismatch) {
    const err = tmError('E_ORACLE_NONDETERMINISM', `Oracle ${moduleId}#${caseConfig.name} mismatch on ${mismatch.field} (attempt ${mismatch.attempt}).`);
    err.detail = { module: moduleId, case: caseConfig.name, field: mismatch.field, attempt: mismatch.attempt };
    throw err;
  }

  return { attempts: attempts.length };
}

async function runOracles({ modulesRoot, specPatterns, manifestsById, filterModules, ee, onCase, skipIfEmpty = false }) {
  const patterns = (specPatterns && specPatterns.length) ? specPatterns : ['oracles/specs/**/*.json'];
  const resolvedSpecs = new Set();
  for (const pattern of patterns) {
    const { matches } = await expandGlob(pattern);
    for (const match of matches) {
      resolvedSpecs.add(path.resolve(match));
    }
  }
  const sortedSpecs = Array.from(resolvedSpecs).sort();
  const plan = [];
  const matchedSpecs = [];
  for (const specPath of sortedSpecs) {
    const spec = await loadOracleSpecFile(specPath);
    const normalized = normalizeOracleSpec(spec, specPath);
    if (filterModules && !filterModules.has(normalized.module)) continue;
    const relSpec = path.relative(process.cwd(), specPath) || specPath;
    matchedSpecs.push(relSpec);
    plan.push({ specPath, relSpec, module: normalized.module, cases: normalized.cases });
  }

  if (plan.length === 0) {
    if (skipIfEmpty) {
      return { totalCases: 0, totalAttempts: 0, results: [], matchedSpecs: [] };
    }
    throw tmError('E_ORACLE_SPEC', `No oracle specs matched the provided patterns: ${patterns.join(', ')}`);
  }

  let totalCases = 0;
  let totalAttempts = 0;
  const results = [];

  for (const entry of plan) {
    const moduleRoot = path.join(modulesRoot, entry.module);
    let manifest = manifestsById?.[entry.module]?.manifest;
    if (!manifest) {
      const manifestPath = path.join(moduleRoot, 'module.json');
      manifest = await validateFile('module.schema.json', manifestPath);
    }
    for (const caseConfig of entry.cases) {
      totalCases += 1;
      if (ee) {
        await ee.emit('ORACLE_START', {
          module: entry.module,
          case: caseConfig.name,
          spec: entry.relSpec
        });
      }
      try {
        const summary = await executeOracleCase({
          caseConfig,
          moduleId: entry.module,
          moduleRoot,
          manifest
        });
        totalAttempts += summary.attempts;
        results.push({ module: entry.module, case: caseConfig.name, attempts: summary.attempts });
        if (ee) {
          await ee.emit('ORACLE_PASS', { module: entry.module, case: caseConfig.name, attempts: summary.attempts });
        }
        if (onCase) {
          onCase({ status: 'pass', module: entry.module, case: caseConfig.name, attempts: summary.attempts });
        }
      } catch (err) {
        const code = err?.code || 'E_ORACLE';
        if (ee) {
          await ee.emit('ORACLE_FAIL', {
            module: entry.module,
            case: caseConfig.name,
            code,
            error: err instanceof Error ? err.message : String(err)
          });
        }
        if (onCase) {
          onCase({ status: 'fail', module: entry.module, case: caseConfig.name, error: err });
        }
        throw err;
      }
    }
  }

  return { totalCases, totalAttempts, results, matchedSpecs };
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
      throw tmError('E_NPM_PACK', `Winner directory not found: ${path.relative(process.cwd(), dir) || dir}`);
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

function parsePackSummary(stdout) {
  const text = String(stdout || '').trim();
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        if (parsed.length > 0 && parsed[0] && typeof parsed[0] === 'object') return parsed[0];
      } else if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      // fall through to line-wise parsing
    }
  }

  const lines = text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed)) {
        if (parsed.length > 0 && parsed[0] && typeof parsed[0] === 'object') return parsed[0];
        continue;
      }
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      continue;
    }
  }
  const failure = tmError('E_SUMMARY_PARSE', 'npm pack --json output could not be parsed.');
  if (lines.length) {
    failure.detail = { sample: lines.slice(0, 3) };
  }
  throw failure;
}

async function appendPackLog(logPath, { header, stdout, stderr, notes = [] }) {
  const stamp = new Date().toISOString();
  const parts = [`# ${stamp} ${header || ''}`.trim()];
  for (const note of notes) {
    if (note && note.trim()) parts.push(`- ${note.trim()}`);
  }
  const trimmedStdout = stdout && stdout.trim();
  const trimmedStderr = stderr && stderr.trim();
  if (trimmedStdout) {
    parts.push('stdout:');
    parts.push(trimmedStdout);
  }
  if (trimmedStderr) {
    parts.push('stderr:');
    parts.push(trimmedStderr);
  }
  parts.push('');
  await ensureDir(path.dirname(logPath));
  await fs.appendFile(logPath, parts.join('\n') + '\n');
}

async function execNpmPack(winnerDir) {
  return new Promise((resolve, reject) => {
    const { cmd, args } = npmInvocation();
    const env = { ...process.env };
    delete env.npm_config_http_proxy;
    delete env.npm_config_https_proxy;
    delete env.npm_config_proxy;
    const child = spawn(cmd, [...args, '--json'], { cwd: winnerDir, shell: false, env });
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
        try {
          const summary = parsePackSummary(stdout);
          resolve({ stdout, stderr, summary });
        } catch (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        }
      } else {
        const error = new Error(`npm pack exited with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.exitCode = code;
        error.code = 'E_NPM_PACK';
        reject(error);
      }
    });
  });
}

async function runNpmPackSmoke(winnerDir, ee) {
  const relDir = path.relative(process.cwd(), winnerDir) || '.';
  await ee.emit('NPM_PACK_START', { cwd: relDir });
  const start = Date.now();
  const artifactsDir = path.resolve(process.cwd(), 'artifacts');
  await ensureDir(artifactsDir);
  const logPath = path.join(artifactsDir, 'npm-pack.log');
  const logRel = path.relative(process.cwd(), logPath) || logPath;

  let before;
  try {
    before = new Set(await listTarballs(winnerDir));
  } catch (err) {
    if (err?.code === 'E_NPM_PACK') {
      await appendPackLog(logPath, { header: 'preflight failure', notes: [`workspace: ${relDir}`], stderr: err.message });
      const diagnostics = collectPackDiagnostics(null, null, err.message);
      err.diagnostics = diagnostics;
      err.logPath = logRel;
      await ee.emit('NPM_PACK_FAIL', { cwd: relDir, code: 'E_NPM_PACK', diagnostics, log: logRel, dur_ms: Date.now() - start });
    }
    throw err;
  }

  const produced = new Set();
  try {
    const result = await execNpmPack(winnerDir);
    if (result?.skipped) {
      await appendPackLog(logPath, { header: 'npm pack skipped', notes: [`workspace: ${relDir}`, `reason: ${result.reason}`] });
      await ee.emit('NPM_PACK_SKIP', { cwd: relDir, reason: result.reason, dur_ms: Date.now() - start, log: logRel });
      ee.info(`ℹ️ npm pack skipped: ${result.reason}`);
      return { skipped: true, reason: result.reason, logPath: logRel };
    }

    const after = await listTarballs(winnerDir);
    for (const name of after) {
      if (!before.has(name)) produced.add(name);
    }
    let tarballName = result?.summary?.filename || null;
    if (!tarballName && produced.size > 0) {
      tarballName = [...produced][0];
    }
    if (!tarballName) {
      const diagnostics = collectPackDiagnostics(result?.stdout, result?.stderr, 'npm pack produced no tarball');
      const failure = tmError('E_NPM_PACK', diagnostics[0] || 'npm pack produced no tarball');
      failure.diagnostics = diagnostics;
      failure.logPath = logRel;
      await appendPackLog(logPath, { header: 'npm pack failure', notes: [`workspace: ${relDir}`], stdout: result?.stdout, stderr: result?.stderr });
      await ee.emit('NPM_PACK_FAIL', { cwd: relDir, code: 'E_NPM_PACK', diagnostics, log: logRel, dur_ms: Date.now() - start });
      throw failure;
    }

    const artifactPath = path.join(artifactsDir, 'winner.tgz');
    await fs.rm(artifactPath, { force: true }).catch(() => {});
    const tarballPath = path.join(winnerDir, tarballName);
    await fs.copyFile(tarballPath, artifactPath);
    if (!before.has(tarballName)) {
      await fs.rm(tarballPath, { force: true }).catch(() => {});
    }

    await appendPackLog(logPath, {
      header: 'npm pack success',
      notes: [`workspace: ${relDir}`, `tarball: ${tarballName}`],
      stdout: result?.stdout,
      stderr: result?.stderr
    });

    await ee.emit('NPM_PACK_PASS', {
      cwd: relDir,
      tarball: tarballName,
      artifact: path.relative(process.cwd(), artifactPath) || artifactPath,
      dur_ms: Date.now() - start,
      log: logRel
    });
    ee.info(`✓ npm pack smoke passed (${tarballName})`);
    return {
      tarball: tarballName,
      workspace: relDir,
      artifact: path.relative(process.cwd(), artifactPath) || artifactPath,
      logPath: logRel
    };
  } catch (err) {
    if (err?.code === 'E_NPM_PACK' && err.logPath) throw err;
    const diagnostics = collectPackDiagnostics(err?.stdout, err?.stderr, err?.message || 'npm pack failed');
    await appendPackLog(logPath, {
      header: 'npm pack failure',
      notes: [`workspace: ${relDir}`],
      stdout: err?.stdout,
      stderr: err?.stderr
    });
    const failure = tmError('E_NPM_PACK', diagnostics[0] || 'npm pack failed');
    failure.diagnostics = diagnostics;
    failure.logPath = logRel;
    if (err?.code && err.code !== 'E_NPM_PACK') {
      failure.cause = err.code;
    }
    if (err?.code === 'E_SUMMARY_PARSE') {
      failure.cause = 'E_SUMMARY_PARSE';
    }
    await ee.emit('NPM_PACK_FAIL', {
      cwd: relDir,
      code: 'E_NPM_PACK',
      diagnostics,
      log: logRel,
      dur_ms: Date.now() - start,
      cause: failure.cause
    });
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
  candidates.push(path.resolve(process.cwd(), 'tmp', 'ts-winner'));
  candidates.push(path.resolve(composeDir, '..', 'tmp', 'ts-winner'));
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

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function normalizeTemplatePath(rootDir, filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, '/');
}

async function copyTemplateDir(templateRoot, targetRoot, report, baseTarget = targetRoot) {
  const entries = await fs.readdir(templateRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const fromPath = path.join(templateRoot, entry.name);
    const toPath = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      await ensureDir(toPath);
      await copyTemplateDir(fromPath, toPath, report, baseTarget);
      continue;
    }

    try {
      await fs.access(toPath);
      report.skipped.push(normalizeTemplatePath(baseTarget, toPath));
      continue;
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }

    await ensureDir(path.dirname(toPath));
    const content = await fs.readFile(fromPath);
    await fs.writeFile(toPath, content);
    try {
      const stat = await fs.stat(fromPath);
      await fs.chmod(toPath, stat.mode & 0o777);
    } catch {}
    report.created.push(normalizeTemplatePath(baseTarget, toPath));
  }
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
    const relOut = path.relative(process.cwd(), outPath) || outPath;
    try {
      await fs.writeFile(outPath, JSON.stringify(payload, null, 2) + '\n');
    } catch (err) {
      const message = err?.message || err;
      const failure = tmError('E_LESSONS_WRITE', `Failed to write lessons output at ${relOut}: ${message}`);
      failure.cause = err;
      throw failure;
    }

    console.log(`✓ Lessons mined ${sortedFollowups.length} followups & ${sortedResiduals.length} residual risks from ${processed} reports → ${relOut}`);
  });

program
  .command('doctor')
  .description('Check local environment prerequisites for the True Modules CLI')
  .option('--json', 'Emit machine-readable JSON')
  .option('--artifacts <dir>', 'Directory to store doctor artifacts', 'artifacts')
  .action(async (opts) => {
    const checkResults = [];
    const addCheck = (entry) => {
      checkResults.push(entry);
    };

    const generatedAt = new Date().toISOString();
    const artifactsDir = path.resolve(opts.artifacts || 'artifacts');
    const artifactPath = path.join(artifactsDir, 'doctor.json');
    const artifactRel = path.relative(process.cwd(), artifactPath) || artifactPath;

    const minNode = parseSemver('18.0.0');
    const nodeVersion = process.versions?.node || process.version || 'unknown';
    const parsedNode = parseSemver(nodeVersion);
    const nodeStatus = compareSemver(parsedNode, minNode) >= 0 ? 'pass' : 'fail';
    addCheck({
      id: 'node',
      name: 'Node.js',
      status: nodeStatus,
      message: `Node.js ${nodeVersion}`,
      details: {
        version: nodeVersion,
        minimum: '18.0.0'
      },
      hint: nodeStatus === 'pass' ? null : 'Install Node.js 18 or newer from https://nodejs.org/en/download.'
    });

    const minRust = parseSemver('1.70.0');
    const rust = await runCommandCapture('rustc', ['--version']);
    if (!rust.ok) {
      const missing = rust.code === 'ENOENT';
      addCheck({
        id: 'rust',
        name: 'Rust toolchain',
        status: missing ? 'warn' : 'fail',
        message: missing ? 'rustc not found on PATH' : `rustc unavailable (${rust.stderr.trim() || rust.stdout.trim()})`,
        details: missing ? {} : { stderr: rust.stderr.trim(), stdout: rust.stdout.trim() },
        hint: 'Install Rust via https://rustup.rs/ to build supporting tooling.'
      });
    } else {
      const rustLine = rust.stdout.trim().split(/\r?\n/)[0] || '';
      const rustMatch = /rustc\s+(\d+\.\d+\.\d+)/.exec(rustLine);
      const rustVersion = rustMatch ? rustMatch[1] : 'unknown';
      const parsedRust = parseSemver(rustVersion);
      const rustStatus = compareSemver(parsedRust, minRust) >= 0 ? 'pass' : 'warn';
      addCheck({
        id: 'rust',
        name: 'Rust toolchain',
        status: rustStatus,
        message: `rustc ${rustVersion}`,
        details: {
          version: rustVersion,
          minimum: '1.70.0'
        },
        hint: rustStatus === 'pass' ? null : 'Update Rust (`rustup update`) to ensure tooling builds cleanly.'
      });
    }

    const requireForDoctor = createRequire(import.meta.url);

    const tsCheck = (() => {
      try {
        const pkgPath = requireForDoctor.resolve('typescript/package.json');
        const pkg = requireForDoctor(pkgPath);
        return { status: 'pass', version: pkg?.version || 'unknown' };
      } catch (err) {
        if (err && (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND')) {
          return { status: 'warn', hint: 'Install TypeScript with `npm install --save-dev typescript`.' };
        }
        return { status: 'fail', hint: err?.message || 'TypeScript resolution failed.' };
      }
    })();
    addCheck({
      id: 'typescript',
      name: 'TypeScript',
      status: tsCheck.status,
      message: tsCheck.version ? `typescript ${tsCheck.version}` : 'TypeScript not installed',
      details: tsCheck.version ? { version: tsCheck.version } : {},
      hint: tsCheck.hint || null
    });

    const eslintCheck = (() => {
      try {
        const pkgPath = requireForDoctor.resolve('eslint/package.json');
        const pkg = requireForDoctor(pkgPath);
        return { status: 'pass', version: pkg?.version || 'unknown' };
      } catch (err) {
        if (err && (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND')) {
          return { status: 'warn', hint: 'Install ESLint with `npm install --save-dev eslint @typescript-eslint/parser`.' };
        }
        return { status: 'fail', hint: err?.message || 'ESLint resolution failed.' };
      }
    })();
    addCheck({
      id: 'eslint',
      name: 'ESLint',
      status: eslintCheck.status,
      message: eslintCheck.version ? `eslint ${eslintCheck.version}` : 'ESLint not installed',
      details: eslintCheck.version ? { version: eslintCheck.version } : {},
      hint: eslintCheck.hint || null
    });

    try {
      const ajv = makeAjv();
      const schemaFiles = [
        'module.schema.json',
        'compose.schema.json',
        'coverage.schema.json',
        'report.schema.json',
        'events.schema.json'
      ];
      for (const file of schemaFiles) {
        const schema = await loadJSON(path.join(specDir, file));
        ajv.compile(schema);
      }
      addCheck({
        id: 'ajv',
        name: 'AJV schema compile',
        status: 'pass',
        message: 'All core schemas compile under AJV 2020-12'
      });
    } catch (err) {
      addCheck({
        id: 'ajv',
        name: 'AJV schema compile',
        status: 'fail',
        message: err?.message || 'AJV compilation failed',
        hint: 'Run `npm install` to refresh dependencies, then re-run `tm doctor`.'
      });
    }

    try {
      const tmPath = path.join(__dirname, 'tm.mjs');
      const stat = await fs.stat(tmPath);
      const isExecutable = (stat.mode & 0o111) !== 0;
      addCheck({
        id: 'permissions',
        name: 'CLI permissions',
        status: isExecutable ? 'pass' : 'warn',
        message: isExecutable ? 'tm.mjs is executable' : 'tm.mjs is not executable',
        hint: isExecutable ? null : 'Run `chmod +x tm.mjs` so shells can invoke the CLI directly.'
      });
    } catch (err) {
      addCheck({
        id: 'permissions',
        name: 'CLI permissions',
        status: 'warn',
        message: err?.message || 'Unable to inspect tm.mjs permissions',
        hint: 'Ensure tm.mjs exists and is readable/executable.'
      });
    }

    const git = await runCommandCapture('git', ['--version']);
    if (!git.ok) {
      const missing = git.code === 'ENOENT';
      addCheck({
        id: 'git',
        name: 'Git',
        status: missing ? 'warn' : 'fail',
        message: missing ? 'git not found on PATH' : (git.stderr.trim() || git.stdout.trim() || 'git invocation failed'),
        hint: 'Install Git from https://git-scm.com/downloads so tm can capture repo metadata.'
      });
    } else {
      addCheck({
        id: 'git',
        name: 'Git',
        status: 'pass',
        message: git.stdout.trim().split(/\r?\n/)[0] || 'git --version'
      });
    }

    const artifactCheck = {
      id: 'doctor_artifact',
      name: 'Doctor artifact',
      status: 'pass',
      message: `doctor.json saved to ${artifactRel}`,
      details: { path: artifactPath }
    };
    addCheck(artifactCheck);

    const buildPayload = () => {
      let overall = 'pass';
      if (checkResults.some(entry => entry.status === 'fail')) {
        overall = 'fail';
      } else if (checkResults.some(entry => entry.status === 'warn')) {
        overall = 'warn';
      }
      return {
        schema: 'tm-doctor@1',
        generated_at: generatedAt,
        status: overall,
        checks: checkResults
          .map(({ id, name, status, message, hint, details }) => ({
            id,
            name,
            status,
            message,
            hint: hint || undefined,
            details: details || undefined
          }))
          .map(entry => {
            if (!entry.hint) delete entry.hint;
            if (!entry.details) delete entry.details;
            return entry;
          })
      };
    };

    try {
      await ensureDir(artifactsDir);
      const payloadForFile = buildPayload();
      await fs.writeFile(artifactPath, JSON.stringify(payloadForFile, null, 2) + '\n');
    } catch (err) {
      const detail = err?.message || String(err);
      artifactCheck.status = 'warn';
      artifactCheck.message = `Failed to write doctor.json (${detail})`;
      artifactCheck.details = { path: artifactPath, error: detail };
      if (err && err.code) {
        artifactCheck.details.code = err.code;
      }
      artifactCheck.hint = 'Ensure the artifacts directory is writable.';
    }

    const payload = buildPayload();
    const overall = payload.status;

    if (opts.json) {
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      for (const entry of checkResults) {
        const icon = entry.status === 'pass' ? '✓' : entry.status === 'warn' ? '⚠️' : '✗';
        const hintText = entry.hint ? ` — ${entry.hint}` : '';
        console.error(`${icon} ${entry.name}: ${entry.message}${hintText}`);
      }
    } else {
      for (const entry of checkResults) {
        const icon = entry.status === 'pass' ? '✓' : entry.status === 'warn' ? '⚠️' : '✗';
        console.log(`${icon} ${entry.name}: ${entry.message}`);
        if (entry.hint) {
          console.log(`    hint: ${entry.hint}`);
        }
      }
      console.log(`Overall status: ${overall.toUpperCase()}`);
    }

    if (overall === 'fail') {
      process.exitCode = 1;
    }
  });

program
  .command('init')
  .description('Bootstrap a minimal True Modules workspace')
  .option('--dir <path>', 'Target directory', '.')
  .option('--ts', 'Include a TypeScript project configuration', false)
  .option('--mcp', 'Include an MCP façade stub', false)
  .action(async (opts) => {
    const targetDir = path.resolve(opts.dir || '.');
    const templateRoot = path.join(__dirname, 'templates', 'init');
    const plan = [
      { name: 'base', enabled: true },
      { name: 'ts', enabled: Boolean(opts.ts) },
      { name: 'mcp', enabled: Boolean(opts.mcp) }
    ];

    await ensureDir(targetDir);

    const report = { created: [], skipped: [] };
    const applied = [];

    for (const step of plan) {
      if (!step.enabled) continue;
      const templateDir = path.join(templateRoot, step.name);
      let stat;
      try {
        stat = await fs.stat(templateDir);
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          continue;
        }
        throw err;
      }
      if (!stat.isDirectory()) continue;
      await copyTemplateDir(templateDir, targetDir, report, targetDir);
      applied.push(step.name);
    }

    report.created.sort((a, b) => a.localeCompare(b));
    report.skipped.sort((a, b) => a.localeCompare(b));

    const relTarget = path.relative(process.cwd(), targetDir) || '.';
    console.log(`✓ Initialized True Modules workspace at ${relTarget}`);
    if (applied.length > 0) {
      console.log(`  templates: ${applied.join(', ')}`);
    }
    if (report.created.length) {
      console.log('  created files:');
      for (const file of report.created) {
        console.log(`    ${file}`);
      }
    }
    if (report.skipped.length) {
      console.log('  skipped (already present):');
      for (const file of report.skipped) {
        console.log(`    ${file}`);
      }
    }
    console.log('Next: run `node tm.mjs doctor` and update compose/modules as you iterate.');
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


function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function cloneWeightMap(map) {
  return Object.fromEntries(Object.entries(map || {}).map(([k, v]) => [k, Number(v)]));
}

async function resolveFeatureWeights(profileName, weightsPath) {
  const builtinPath = path.join(__dirname, 'meta', 'weights.json');
  const builtin = await loadJSON(builtinPath);
  const defaultsProfile = builtin?.defaults?.profile || 'conservative';
  let activeProfile = profileName || defaultsProfile;
  let resolvedWeights = null;
  let source = builtinPath;

  if (weightsPath) {
    const customPath = path.resolve(weightsPath);
    const custom = await loadJSON(customPath);
    source = customPath;
    if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
      if (custom.profiles && typeof custom.profiles === 'object') {
        const profile = activeProfile || custom.defaults?.profile;
        const targetName = profile || Object.keys(custom.profiles)[0];
        if (!targetName || !custom.profiles[targetName]) {
          throw tmError('E_META_WEIGHTS', `Profile ${profile || '(unspecified)'} not found in ${customPath}`);
        }
        activeProfile = targetName;
        resolvedWeights = cloneWeightMap(custom.profiles[targetName]);
      } else {
        resolvedWeights = cloneWeightMap(custom);
      }
    }
  }

  if (!resolvedWeights) {
    if (!builtin.profiles || !builtin.profiles[activeProfile]) {
      throw tmError('E_META_WEIGHTS', `Profile ${activeProfile} not found in ${builtinPath}`);
    }
    resolvedWeights = cloneWeightMap(builtin.profiles[activeProfile]);
  }

  return { profile: activeProfile, weights: resolvedWeights, source };
}

program
  .command('meta')
  .requiredOption('--coverage <file>', 'Path to coverage.json')
  .option('--out <file>', 'Output compose file', './compose.greedy.json')
  .option('--profile <name>', 'Weight profile name to use')
  .option('--weights <file>', 'Path to custom feature weights JSON')
  .option('--emit-events', 'Emit line-delimited JSON events', false)
  .option('--events-out <file>', 'Write events to file (NDJSON)')
  .option('--events-truncate', 'Truncate events output file before writing', false)
  .option('--strict-events', 'Validate events against tm-events@1 schema (fail fast)', false)
  .description('Feasible greedy scorer for module selection')
  .action(async (opts) => {
    const coveragePath = path.resolve(opts.coverage);
    const cov = await validateFile('coverage.schema.json', coveragePath);
    const goalWeights = new Map(Object.entries(cov.weights || {}).map(([goal, weight]) => [goal, typeof weight === 'number' ? weight : 1]));
    const { profile: activeProfile, weights: featureWeights } = await resolveFeatureWeights(opts.profile, opts.weights);

    const moduleInfo = new Map();
    const providersByPort = new Map();
    const goalSet = new Set(cov.goals || []);

    for (const entry of (cov.provides || [])) {
      const moduleId = entry.module;
      if (!moduleId) continue;
      if (!moduleInfo.has(moduleId)) {
        moduleInfo.set(moduleId, {
          id: moduleId,
          goals: new Set(),
          provides: new Set(),
          requires: new Set(),
          evidence: 0.5,
          risk: 0.5,
          deltaCost: 1,
          hygiene: 0.5
        });
      }
      const info = moduleInfo.get(moduleId);
      for (const goal of (entry.covers || [])) info.goals.add(goal);
      if (typeof entry.evidence_strength === 'number') info.evidence = entry.evidence_strength;
      if (typeof entry.risk === 'number') info.risk = entry.risk;
      if (typeof entry.delta_cost === 'number') info.deltaCost = entry.delta_cost;
      if (typeof entry.hygiene === 'number') info.hygiene = entry.hygiene;
      for (const port of (entry.provides_ports || [])) {
        if (typeof port !== 'string' || !port.length) continue;
        info.provides.add(port);
        if (!providersByPort.has(port)) providersByPort.set(port, new Set());
        providersByPort.get(port).add(moduleId);
      }
      for (const req of (entry.requires || [])) {
        if (typeof req !== 'string' || !req.length) continue;
        info.requires.add(req);
      }
    }

    const sortedModules = Array.from(moduleInfo.keys()).sort((a, b) => a.localeCompare(b));
    const providerCandidates = new Map();
    for (const [port, providers] of providersByPort.entries()) {
      providerCandidates.set(port, Array.from(providers).sort((a, b) => a.localeCompare(b)));
    }

    const selectedModules = new Set();
    const coveredGoals = new Set();
    const selectedProviders = new Map();
    const picks = [];

    const ensureProvidersInto = (map, modId) => {
      const info = moduleInfo.get(modId);
      if (!info) return;
      for (const port of info.provides) {
        if (!map.has(port)) {
          map.set(port, modId);
        }
      }
    };

    const planBundle = (rootId) => {
      if (selectedModules.has(rootId)) return { feasible: false, modules: [] };
      const infoRoot = moduleInfo.get(rootId);
      if (!infoRoot) return { feasible: false, modules: [] };

      const providerMap = new Map(selectedProviders);
      const planned = new Set();
      const order = [];
      const visiting = new Set();

      const visit = (moduleId) => {
        if (selectedModules.has(moduleId) || planned.has(moduleId)) {
          ensureProvidersInto(providerMap, moduleId);
          return true;
        }
        const info = moduleInfo.get(moduleId);
        if (!info) return false;
        if (visiting.has(moduleId)) return false;
        visiting.add(moduleId);

        for (const req of info.requires) {
          if (info.provides.has(req)) {
            providerMap.set(req, moduleId);
            continue;
          }
          let providerId = providerMap.get(req);
          if (providerId) {
            ensureProvidersInto(providerMap, providerId);
            continue;
          }
          const candidates = providerCandidates.get(req) || [];
          let satisfied = false;

          for (const candidate of candidates) {
            if (selectedModules.has(candidate) || planned.has(candidate)) {
              ensureProvidersInto(providerMap, candidate);
              providerId = candidate;
              satisfied = true;
              break;
            }
          }

          if (!satisfied) {
            for (const candidate of candidates) {
              if (!moduleInfo.has(candidate)) continue;
              if (candidate === moduleId) continue;
              if (!visit(candidate)) continue;
              ensureProvidersInto(providerMap, candidate);
              providerId = candidate;
              satisfied = true;
              break;
            }
          }

          if (!satisfied) {
            visiting.delete(moduleId);
            return false;
          }

          providerMap.set(req, providerId);
        }

        for (const port of info.provides) {
          const existing = providerMap.get(port);
          if (existing && existing !== moduleId) {
            visiting.delete(moduleId);
            return false;
          }
        }

        planned.add(moduleId);
        order.push(moduleId);
        ensureProvidersInto(providerMap, moduleId);
        visiting.delete(moduleId);
        return true;
      };

      if (!visit(rootId)) return { feasible: false, modules: [] };
      return { feasible: true, modules: order };
    };

    const computeFeatures = (bundleModules) => {
      const coverageGoals = new Set();
      let coverageScore = 0;
      let evidenceSum = 0;
      let riskSum = 0;
      let hygieneSum = 0;
      let evidenceCount = 0;
      let riskCount = 0;
      let hygieneCount = 0;
      let deltaSum = 0;

      for (const modId of bundleModules) {
        const info = moduleInfo.get(modId);
        if (!info) continue;
        for (const goal of info.goals) {
          if (coveredGoals.has(goal) || coverageGoals.has(goal)) continue;
          coverageGoals.add(goal);
          coverageScore += goalWeights.get(goal) ?? 1;
        }
        if (typeof info.evidence === 'number') {
          evidenceSum += info.evidence;
          evidenceCount += 1;
        }
        if (typeof info.risk === 'number') {
          riskSum += info.risk;
          riskCount += 1;
        }
        if (typeof info.hygiene === 'number') {
          hygieneSum += info.hygiene;
          hygieneCount += 1;
        }
        deltaSum += numberOr(info.deltaCost, 0);
      }

      return {
        coverage_contribution: coverageScore,
        coverage_goals: Array.from(coverageGoals).sort((a, b) => a.localeCompare(b)),
        evidence_strength: evidenceCount ? evidenceSum / evidenceCount : 0,
        risk: riskCount ? riskSum / riskCount : 0,
        delta_cost: deltaSum,
        hygiene: hygieneCount ? hygieneSum / hygieneCount : 0
      };
    };

    const scoreCandidate = (features) => {
      let total = 0;
      for (const [key, weight] of Object.entries(featureWeights)) {
        if (typeof weight !== 'number') continue;
        const value = typeof features[key] === 'number' ? features[key] : 0;
        total += value * weight;
      }
      return total;
    };

    const betterOf = (current, challenger) => {
      if (!current) return challenger;
      if (challenger.gain > current.gain) return challenger;
      if (challenger.gain < current.gain) return current;
      if (challenger.features.evidence_strength !== current.features.evidence_strength) {
        return challenger.features.evidence_strength > current.features.evidence_strength ? challenger : current;
      }
      if (challenger.features.risk !== current.features.risk) {
        return challenger.features.risk < current.features.risk ? challenger : current;
      }
      if (challenger.features.delta_cost !== current.features.delta_cost) {
        return challenger.features.delta_cost < current.features.delta_cost ? challenger : current;
      }
      return challenger.moduleId.localeCompare(current.moduleId) < 0 ? challenger : current;
    };

    const remainingGoals = () => {
      let count = 0;
      for (const goal of goalSet) {
        if (!coveredGoals.has(goal)) count += 1;
      }
      return count;
    };

    while (true) {
      let best = null;
      for (const moduleId of sortedModules) {
        if (selectedModules.has(moduleId)) continue;
        const plan = planBundle(moduleId);
        if (!plan.feasible || plan.modules.length === 0) continue;
        const features = computeFeatures(plan.modules);
        const gain = scoreCandidate(features);
        const candidate = { moduleId, plan, features, gain };
        best = betterOf(best, candidate);
      }

      if (!best) break;
      const addsCoverage = best.features.coverage_goals.length > 0;
      if (best.gain <= 0 && (!addsCoverage || remainingGoals() === 0)) {
        break;
      }

      for (const modId of best.plan.modules) {
        if (selectedModules.has(modId)) continue;
        selectedModules.add(modId);
        ensureProvidersInto(selectedProviders, modId);
        const info = moduleInfo.get(modId);
        if (info) {
          for (const goal of info.goals) coveredGoals.add(goal);
        }
      }

      picks.push({
        module: best.moduleId,
        gain: best.gain,
        drivers: {
          coverage_contribution: best.features.coverage_contribution,
          coverage_goals: best.features.coverage_goals,
          evidence_strength: best.features.evidence_strength,
          risk: best.features.risk,
          delta_cost: best.features.delta_cost,
          hygiene: best.features.hygiene,
          bundle: best.plan.modules
        }
      });

      if (remainingGoals() === 0) break;
    }

    const moduleOrder = [];
    const seenBase = new Set();
    for (const pick of picks) {
      for (const modId of pick.drivers.bundle) {
        const base = modId.split('@')[0];
        if (seenBase.has(base)) continue;
        seenBase.add(base);
        moduleOrder.push(base);
      }
    }
    for (const modId of selectedModules) {
      const base = modId.split('@')[0];
      if (seenBase.has(base)) continue;
      seenBase.add(base);
      moduleOrder.push(base);
    }

    const modulesList = moduleOrder.map(id => ({ id, version: '0.1.0' }));
    const baseCompose = {
      modules: modulesList,
      wiring: [],
      glue: [],
      constraints: ['no-cross-imports', 'ports-only-coupling']
    };
    const baseComposeJson = JSON.stringify(baseCompose);
    const baseComposeHash = crypto.createHash('sha256').update(baseComposeJson).digest('hex');
    const runId = cov.run_id || `meta:${activeProfile || 'default'}:${baseComposeHash}`;
    const compose = {
      run_id: runId,
      ...baseCompose
    };

    const composePath = path.resolve(opts.out || './compose.greedy.json');
    const composeJson = JSON.stringify(compose, null, 2);
    await fs.writeFile(composePath, composeJson);

    const composeHash = crypto.createHash('sha256').update(composeJson).digest('hex');
    const ee = await makeEventEmitter({
      emitEvents: opts.emitEvents,
      eventsOut: opts.eventsOut ? path.resolve(opts.eventsOut) : null,
      eventsTruncate: opts.eventsTruncate,
      strictEvents: opts.strictEvents,
      context: { run_id: runId, mode: 'compose', compose_sha256: composeHash }
    });

    try {
      for (const pick of picks) {
        await ee.emit('META_PICK', {
          module: pick.module,
          gain: pick.gain,
          drivers: pick.drivers,
          profile: activeProfile
        });
      }
      const rel = path.relative(process.cwd(), composePath) || composePath;
      ee.info(`✓ Wrote ${rel} with ${modulesList.length} modules (profile: ${activeProfile})`);
    } finally {
      await ee.close();
    }
  });

const oraclesCmd = program.command('oracles').description('Determinism oracle utilities');

oraclesCmd
  .command('run')
  .requiredOption('--modules-root <dir>', 'Root dir of modules')
  .option(
    '--spec <pattern>',
    'Glob pattern for oracle specs (repeatable)',
    (value, previous) => {
      const list = Array.isArray(previous) ? previous.slice() : (previous ? [previous] : []);
      list.push(value);
      return list;
    },
    []
  )
  .action(async (opts) => {
    const modulesRoot = path.resolve(opts.modules_root || opts.modulesRoot);
    const patterns = (Array.isArray(opts.spec) && opts.spec.length) ? opts.spec : ['oracles/specs/**/*.json'];
    try {
      const summary = await runOracles({
        modulesRoot,
        specPatterns: patterns,
        manifestsById: null,
        filterModules: null,
        skipIfEmpty: true,
        onCase: (result) => {
          if (result.status === 'pass') {
            console.log(`✓ ${result.module} :: ${result.case} (${result.attempts} attempts)`);
          } else if (result.status === 'fail') {
            const message = result.error instanceof Error ? result.error.message : String(result.error);
            console.error(`✗ ${result.module} :: ${result.case} — ${message}`);
          }
        }
      });
      if (summary.totalCases === 0) {
        console.log(`No oracle specs matched patterns: ${patterns.join(', ')}`);
        return;
      }
      console.log(`✓ ${summary.totalCases} oracle cases passed (${summary.totalAttempts} attempts)`);
    } catch (err) {
      const code = err?.code || 'E_ORACLE';
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${code} ${message}`);
      process.exitCode = 1;
    }
  });

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return String(ms);
  if (ms >= 10_000) return `${Math.round(ms / 1000)}s`;
  if (ms >= 1_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function extractSkipReason(output) {
  if (!output) return { matched: false, reason: null };
  const lines = String(output)
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(entry => entry.length);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        const event = String(parsed.tm_event || parsed.event || '').toUpperCase();
        if (event === 'TEST_SKIPPED' || event === 'SKIP') {
          const reasonValue = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
          return { matched: true, reason: reasonValue || null };
        }
      }
    } catch {
      // fall through to regex checks
    }
    const testSkipped = /^TEST_SKIPPED\s*(.*)$/i.exec(line);
    if (testSkipped) {
      const reasonValue = testSkipped[1]?.trim() || '';
      return { matched: true, reason: reasonValue || null };
    }
    const skip = /^SKIP\s*(.*)$/i.exec(line);
    if (skip) {
      const reasonValue = skip[1]?.trim() || '';
      return { matched: true, reason: reasonValue || null };
    }
  }
  return { matched: false, reason: null };
}

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
  .option('--with-oracles', 'Run determinism oracles after shipping tests', false)
  .option(
    '--oracle-spec <pattern>',
    'Glob pattern for oracle specs (repeatable)',
    (value, previous) => {
      const list = Array.isArray(previous) ? previous.slice() : (previous ? [previous] : []);
      list.push(value);
      return list;
    }
  )
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
      results: { passed: 0, failed: 0, skipped: 0 }
    };
    const sideEffectsAccumulator = createSideEffectsAccumulator();
    let sideEffectsPublished = false;
    const publishSideEffectsSummary = async () => {
      if (sideEffectsPublished) return summary.side_effects || null;
      const final = finalizeSideEffectsSummary(sideEffectsAccumulator);
      if (final) {
        summary.side_effects = final;
        if (ee) {
          for (const [moduleId, data] of Object.entries(final.modules || {})) {
            await ee.emit('SIDEEFFECTS_SUMMARY', { module: moduleId, side_effects: data });
          }
        }
      }
      sideEffectsPublished = true;
      return final;
    };
    let successMessage = '';
    let failureCode = null;
    let failureDetail = null;
    const phases = [];
    const runPhase = async (name, fn) => {
      const start = Date.now();
      try {
        const result = await fn();
        phases.push({ name, dur_ms: Date.now() - start, status: 'pass' });
        return result;
      } catch (err) {
        phases.push({ name, dur_ms: Date.now() - start, status: 'fail' });
        throw err;
      }
    };

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
      await runPhase('manifest_validation', async () => {
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
      });

      await runPhase('lint', async () => {
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
          } else {
            throw err instanceof Error ? err : new Error(String(err));
          }
        }
      });

      if (mode === 'conceptual') {
        phases.push({ name: 'tests', dur_ms: 0, status: 'skipped' });
        phases.push({ name: 'typecheck', dur_ms: 0, status: 'skipped' });
        phases.push({ name: 'oracles', dur_ms: 0, status: 'skipped' });
        phases.push({ name: 'npm_pack', dur_ms: 0, status: 'skipped' });
        const lintPhase = phases.find(entry => entry.name === 'lint');
        const parts = [];
        if (lintPhase) parts.push(`lint ${formatDuration(lintPhase.dur_ms)}`);
        successMessage = parts.length ? `✓ Conceptual gates passed (${parts.join(', ')})` : '✓ Conceptual gates passed.';
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
        let skippedTests = 0;
        await runPhase('tests', async () => {
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
                let scriptAbs;
                let args = [];
                if (t.startsWith('script:')) {
                  const scriptRel = t.replace(/^script:/, '').trim();
                  if (!scriptRel) throw tmError('E_REQUIRE_UNSAT', 'Script entry missing path');
                  scriptAbs = path.join(root, scriptRel);
                } else if (t.endsWith('.json')) {
                  const runner = path.join(root, 'tests', 'runner.mjs');
                  await fs.access(runner);
                  const specPath = path.join(root, t);
                  scriptAbs = runner;
                  args = ['--spec', specPath, '--moduleRoot', root];
                } else {
                  throw tmError('E_REQUIRE_UNSAT', `Unknown test entry: ${t}`);
                }

                const runResult = await runNodeWithSideEffectsGuard({
                  scriptPath: scriptAbs,
                  args,
                  cwd: root,
                  timeoutMs,
                  moduleId: m.id,
                  caseName: t,
                  allowedExitCodes: [TEST_SKIP_EXIT_CODE]
                });

                const events = await readSideEffectEvents(runResult.logPath);
                const evaluation = evaluateSideEffects({ events, moduleId: m.id, manifest, moduleRoot: root });
                recordSideEffectsObservation(sideEffectsAccumulator, m.id, evaluation.summary);

                if (runResult.code === TEST_SKIP_EXIT_CODE) {
                  const skipInfo = extractSkipReason(runResult.out || runResult.err);
                  if (!skipInfo.matched) {
                    const skipErr = tmError(
                      'E_TEST',
                      `Test ${t} exited with skip code ${TEST_SKIP_EXIT_CODE} but did not emit TEST_SKIPPED directive.`
                    );
                    skipErr.detail = { module: m.id, test: t, exit_code: runResult.code };
                    throw skipErr;
                  }
                  skippedTests += 1;
                  const dur = Date.now() - testStart;
                  await ee.emit('TEST_SKIPPED', {
                    module: m.id,
                    test: t,
                    dur_ms: dur,
                    reason: skipInfo.reason || undefined,
                    side_effects: evaluation.summary
                  });
                  continue;
                }
                if (evaluation.violation) {
                  const sideErr = evaluation.violation;
                  const dur = Date.now() - testStart;
                  const message = sideErr instanceof Error ? sideErr.message : String(sideErr);
                  failureCode = sideErr?.code || 'E_SIDEEFFECTS';
                  failureDetail = { module: m.id, test: t, ...(sideErr?.detail || {}), side_effects: evaluation.summary };
                  await ee.emit('TEST_FAIL', {
                    module: m.id,
                    test: t,
                    dur_ms: dur,
                    error: message,
                    code: failureCode,
                    side_effects: evaluation.summary
                  });
                  summary.results = { passed, failed: total - passed, skipped: skippedTests };
                  throw sideErr;
                }

                const dur = Date.now() - testStart;
                passed += 1;
                await ee.emit('TEST_PASS', { module: m.id, test: t, dur_ms: dur, side_effects: evaluation.summary });
              } catch (e) {
                if (e && (e.code === 'E_SIDEEFFECTS_DECLARATION' || e.code === 'E_SIDEEFFECTS_FORBIDDEN')) {
                  throw e;
                }
                const dur = Date.now() - testStart;
                const errMsg = e instanceof Error ? e.message : String(e);
                failureCode = 'E_TEST';
                await ee.emit('TEST_FAIL', { module: m.id, test: t, dur_ms: dur, error: errMsg, code: 'E_TEST' });
                summary.results = { passed, failed: total - passed, skipped: skippedTests };
                throw tmError('E_TEST', `Test failed for ${m.id} (${t}): ${errMsg}`);
              }
            }
          }
        });

        summary.results = { passed, failed: 0, skipped: skippedTests };
        summary.tests = { total, passed, skipped: skippedTests };

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

        if (!mustTypeCheck) {
          phases.push({ name: 'typecheck', dur_ms: 0, status: 'skipped' });
        } else {
          await runPhase('typecheck', async () => {
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
                module: 'NodeNext',
                moduleResolution: 'NodeNext',
                target: 'ES2022',
                strict: true,
                skipLibCheck: true,
                allowImportingTsExtensions: true,
                incremental: true,
                tsBuildInfoFile: 'tsconfig.tsbuildinfo'
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
            const child = spawn(process.execPath, [tscBin, '--noEmit', '--incremental', '--project', tsProjectPath], {
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
          });
        }

        if (opts.withOracles) {
          await runPhase('oracles', async () => {
            const patternsOption = opts.oracleSpec || opts.oracle_spec;
            const patternList = Array.isArray(patternsOption)
              ? patternsOption
              : (patternsOption ? [patternsOption] : []);
            const filterModules = new Set((compose.modules || []).map(entry => entry.id));
            try {
              const oracleResult = await runOracles({
                modulesRoot,
                specPatterns: patternList.length ? patternList : ['oracles/specs/**/*.json'],
                manifestsById: manifests,
                filterModules,
                ee,
                skipIfEmpty: true
              });
              if (oracleResult.totalCases > 0) {
                summary.oracles = {
                  status: 'passed',
                  cases: oracleResult.totalCases,
                  attempts: oracleResult.totalAttempts,
                  specs: oracleResult.matchedSpecs || []
                };
                ee.info(`✓ Oracles passed (${oracleResult.totalCases} cases)`);
              } else {
                summary.oracles = { status: 'skipped', cases: 0, specs: [] };
                ee.info('No oracle specs matched selected modules; skipping oracles.');
              }
            } catch (err) {
              const code = err?.code || 'E_ORACLE';
              failureCode = code;
              summary.oracles = {
                status: 'failed',
                code,
                message: err instanceof Error ? err.message : String(err),
                specs: []
              };
              throw err instanceof Error ? err : new Error(String(err));
            }
          });
        } else {
          phases.push({ name: 'oracles', dur_ms: 0, status: 'skipped' });
        }

        if (opts.npmPack) {
          const packStart = Date.now();
          const winnerDir = await locateWinnerDir(composePath);
          if (!winnerDir) {
            await ee.emit('GATES_WARN', {
              code: 'WARN_NPM_PACK_NO_WORKSPACE',
              message: 'npm pack requested but no winner workspace with package.json was found; skipping smoke test.'
            });
            summary.npm_pack = { status: 'skipped', reason: 'workspace_missing' };
            phases.push({ name: 'npm_pack', dur_ms: Date.now() - packStart, status: 'skipped' });
          } else {
            try {
              const result = await runNpmPackSmoke(winnerDir, ee);
              const relWinner = path.relative(process.cwd(), winnerDir) || '.';
              if (result?.skipped) {
                summary.npm_pack = {
                  status: 'skipped',
                  reason: result.reason,
                  log: result.logPath || null
                };
                phases.push({ name: 'npm_pack', dur_ms: Date.now() - packStart, status: 'skipped' });
              } else {
                summary.npm_pack = {
                  status: 'passed',
                  workspace: relWinner,
                  tarball: result?.tarball || null,
                  artifact: result?.artifact || null,
                  log: result?.logPath || null
                };
                phases.push({ name: 'npm_pack', dur_ms: Date.now() - packStart, status: 'pass' });
              }
            } catch (err) {
              if (err && err.code === 'E_NPM_PACK') {
                failureCode = 'E_NPM_PACK';
                summary.npm_pack = {
                  status: 'failed',
                  diagnostics: Array.isArray(err.diagnostics) ? err.diagnostics.slice(0, 5) : [],
                  log: err.logPath || null,
                  cause: err.cause || undefined
                };
              }
              phases.push({ name: 'npm_pack', dur_ms: Date.now() - packStart, status: 'fail' });
              throw err;
            }
          }
        } else {
          phases.push({ name: 'npm_pack', dur_ms: 0, status: 'skipped' });
        }

        const lintPhase = phases.find(entry => entry.name === 'lint');
        const testsPhase = phases.find(entry => entry.name === 'tests');
        const typePhase = phases.find(entry => entry.name === 'typecheck');
        const parts = [];
        if (testsPhase) {
          const testSummary = skippedTests ? `${passed}/${total} (${skippedTests} skipped)` : `${passed}/${total}`;
          parts.push(`tests ${testSummary} in ${formatDuration(testsPhase.dur_ms)}`);
        }
        if (lintPhase) parts.push(`lint ${formatDuration(lintPhase.dur_ms)}`);
        if (typePhase && typePhase.status === 'pass') {
          parts.push(`typecheck ${formatDuration(typePhase.dur_ms)}`);
        }
        successMessage = parts.length ? `✓ Shipping gates passed (${parts.join(', ')})` : '✓ Shipping gates passed.';
      }
      await publishSideEffectsSummary();
      summary.duration_ms = Date.now() - gateStart;
      summary.phases = phases;

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

      await ee.emit('GATES_SUMMARY', {
        phases,
        dur_ms: summary.duration_ms,
        passed: summary.results.passed,
        failed: summary.results.failed,
        skipped: summary.results.skipped
      });
      await ee.emit('GATES_PASS', {
        passed: summary.results.passed,
        failed: summary.results.failed,
        skipped: summary.results.skipped,
        dur_ms: summary.duration_ms
      });
      if (successMessage) ee.info(successMessage);
    } catch (err) {
      await publishSideEffectsSummary();
      summary.duration_ms = Date.now() - gateStart;
      summary.phases = phases;
      const message = err instanceof Error ? err.message : String(err);
      summary.error = message;
      const code = err && typeof err === 'object' && 'code' in err && err.code ? err.code : (failureCode || 'E_UNKNOWN');
      summary.code = code;
      if (failureDetail) summary.failure_detail = failureDetail;
      const failDetail = failureDetail ? { ...failureDetail } : {};
      await ee.emit('GATES_SUMMARY', {
        phases,
        dur_ms: summary.duration_ms,
        passed: summary.results.passed,
        failed: summary.results.failed,
        skipped: summary.results.skipped
      });
      await ee.emit('GATES_FAIL', {
        code,
        message,
        passed: summary.results.passed,
        failed: summary.results.failed,
        skipped: summary.results.skipped,
        dur_ms: summary.duration_ms,
        ...failDetail
      });
      throw err instanceof Error ? err : new Error(message);
    } finally {
      await ee.close();
    }
  });

const eventsCmd = program.command('events').description('Event telemetry utilities');

eventsCmd
  .command('validate')
  .requiredOption('--in <file>', 'Input events NDJSON file')
  .option('--strict', 'Require contiguous sequencing', false)
  .description('Validate an events NDJSON stream against tm-events@1')
  .action(async (opts) => {
    const inputPath = path.resolve(opts.in);
    try {
      const result = await validateEventsFile(inputPath, { strict: opts.strict });
      const composeInfo = result.composeSha ? ` (compose ${result.composeSha})` : '';
      console.log(`✓ ${result.count} events validated${composeInfo}`);
    } catch (err) {
      if (err?.code === 'E_EVENT_SCHEMA') {
        console.error(err.message);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  });

eventsCmd
  .command('replay')
  .requiredOption('--in <file>', 'Input events NDJSON file')
  .option('--out <file>', 'Timeline output file', path.join('artifacts', 'timeline.txt'))
  .option('--strict', 'Validate with contiguous sequencing', false)
  .description('Render a human-readable timeline from events')
  .action(async (opts) => {
    const inputPath = path.resolve(opts.in);
    const outPath = path.resolve(opts.out || path.join('artifacts', 'timeline.txt'));
    try {
      const result = await replayEvents({ inputPath, outPath, strict: opts.strict });
      const text = result.output.endsWith('\n') ? result.output : result.output + '\n';
      process.stdout.write(text);
      console.error(`timeline written to ${path.relative(process.cwd(), result.timelinePath) || result.timelinePath}`);
    } catch (err) {
      if (err?.code === 'E_EVENT_SCHEMA') {
        console.error(err.message);
        process.exitCode = 1;
        return;
      }
      throw err;
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
