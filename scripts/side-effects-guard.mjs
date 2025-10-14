#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');

const logPath = process.env.TM_SIDEEFFECTS_LOG ? path.resolve(process.env.TM_SIDEEFFECTS_LOG) : null;
const moduleLabel = process.env.TM_SIDEEFFECTS_MODULE || null;
const caseLabel = process.env.TM_SIDEEFFECTS_CASE || null;

const real = {
  appendFileSync: fs.appendFileSync.bind(fs),
  existsSync: fs.existsSync.bind(fs)
};

function writeLog(entry) {
  if (!logPath) return;
  try {
    const payload = { ...entry };
    if (moduleLabel && !payload.module) payload.module = moduleLabel;
    if (caseLabel && !payload.case) payload.case = caseLabel;
    const text = JSON.stringify(payload);
    real.appendFileSync(logPath, text + '\n', 'utf8');
  } catch {
    // Ignore logging failures to avoid interfering with execution.
  }
}

function normalizePathLike(value) {
  try {
    if (typeof value === 'string') return path.resolve(value);
    if (value instanceof URL) return fileURLToPath(value);
    if (Buffer.isBuffer(value)) return path.resolve(value.toString('utf8'));
    if (value && typeof value === 'object' && typeof value.path === 'string') {
      return path.resolve(value.path);
    }
    if (value && typeof value.toString === 'function') {
      const str = value.toString();
      if (typeof str === 'string' && str && str !== '[object Object]') {
        return path.resolve(str);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function recordFsWrite(op, target) {
  const resolved = normalizePathLike(target);
  if (!resolved) return;
  if (logPath && path.resolve(resolved) === logPath) return;
  writeLog({ type: 'fs_write', op, path: resolved });
}

function wrapFsMethod(target, methodName, opName) {
  const original = target[methodName];
  if (typeof original !== 'function') return;
  target[methodName] = function wrapped(...args) {
    try { recordFsWrite(opName || methodName, args[0]); } catch {}
    return original.apply(this, args);
  };
}

function wrapFsPromise(target, methodName, opName) {
  const original = target[methodName];
  if (typeof original !== 'function') return;
  target[methodName] = function wrapped(...args) {
    try { recordFsWrite(opName || methodName, args[0]); } catch {}
    return original.apply(this, args);
  };
}

wrapFsMethod(fs, 'writeFile', 'writeFile');
wrapFsMethod(fs, 'writeFileSync', 'writeFileSync');
wrapFsMethod(fs, 'appendFile', 'appendFile');
wrapFsMethod(fs, 'appendFileSync', 'appendFileSync');
wrapFsMethod(fs, 'truncate', 'truncate');
wrapFsMethod(fs, 'truncateSync', 'truncateSync');
wrapFsMethod(fs, 'rm', 'rm');
wrapFsMethod(fs, 'rmSync', 'rmSync');
wrapFsMethod(fs, 'unlink', 'unlink');
wrapFsMethod(fs, 'unlinkSync', 'unlinkSync');
wrapFsMethod(fs, 'rename', 'rename');
wrapFsMethod(fs, 'renameSync', 'renameSync');
wrapFsMethod(fs, 'mkdir', 'mkdir');
wrapFsMethod(fs, 'mkdirSync', 'mkdirSync');
wrapFsMethod(fs, 'createWriteStream', 'createWriteStream');

wrapFsPromise(fsp, 'writeFile', 'writeFile');
wrapFsPromise(fsp, 'appendFile', 'appendFile');
wrapFsPromise(fsp, 'truncate', 'truncate');
wrapFsPromise(fsp, 'rm', 'rm');
wrapFsPromise(fsp, 'unlink', 'unlink');
wrapFsPromise(fsp, 'rename', 'rename');
wrapFsPromise(fsp, 'mkdir', 'mkdir');
wrapFsPromise(fsp, 'cp', 'cp');

const originalCreateWriteStream = fs.createWriteStream;
if (typeof originalCreateWriteStream === 'function') {
  fs.createWriteStream = function wrappedCreateWriteStream(...args) {
    try { recordFsWrite('createWriteStream', args[0]); } catch {}
    return originalCreateWriteStream.apply(this, args);
  };
}

function extractCommand(command, args, options) {
  if (typeof command === 'string') {
    const trimmed = command.trim();
    if (!trimmed) return { command: '', argv: [], shell: Boolean(options && options.shell) };
    if (Boolean(options && options.shell)) {
      return { command: trimmed.split(/\s+/)[0] || trimmed, argv: [trimmed], shell: true };
    }
    const parts = trimmed.split(/\s+/);
    return { command: parts[0] || trimmed, argv: args && Array.isArray(args) ? args : parts.slice(1), shell: false };
  }
  const cmdStr = typeof command === 'string' ? command : (command && typeof command.toString === 'function' ? command.toString() : '');
  const base = cmdStr && cmdStr !== '[object Object]' ? cmdStr : '';
  return { command: base, argv: Array.isArray(args) ? args : [], shell: Boolean(options && options.shell) };
}

function recordSpawn(kind, command, args, options) {
  const info = extractCommand(command, args, options);
  writeLog({ type: 'process_spawn', kind, command: info.command, argv: Array.isArray(info.argv) ? info.argv : [], shell: info.shell });
}

function wrapSpawnMethod(name) {
  const original = childProcess[name];
  if (typeof original !== 'function') return;
  childProcess[name] = function wrapped(command, args, options) {
    try { recordSpawn(name, command, args, options); } catch {}
    return original.apply(this, arguments);
  };
}

wrapSpawnMethod('spawn');
wrapSpawnMethod('spawnSync');
wrapSpawnMethod('exec');
wrapSpawnMethod('execSync');
wrapSpawnMethod('execFile');
wrapSpawnMethod('execFileSync');
wrapSpawnMethod('fork');

process.on('uncaughtException', (err) => {
  writeLog({ type: 'uncaughtException', error: err && typeof err.message === 'string' ? err.message : String(err) });
  throw err;
});

process.on('unhandledRejection', (reason) => {
  writeLog({ type: 'unhandledRejection', error: reason && typeof reason.message === 'string' ? reason.message : String(reason) });
});
