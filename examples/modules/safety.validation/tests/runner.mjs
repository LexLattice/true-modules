#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const args = new Map(
  process.argv.slice(2).map((value, idx, arr) => {
    if (!value.startsWith('--')) return null;
    return [value.replace(/^--/, ''), arr[idx + 1]];
  }).filter(Boolean)
);

const specArg = args.get('spec');
if (!specArg) {
  console.error('Missing --spec argument');
  process.exit(1);
}

const moduleRoot = args.get('moduleRoot');
if (!moduleRoot) {
  console.error('Missing --moduleRoot argument');
  process.exit(1);
}

const specPath = path.isAbsolute(specArg) ? specArg : path.join(moduleRoot, specArg);
let spec;
try {
  spec = JSON.parse(await fs.readFile(specPath, 'utf8'));
} catch (err) {
  console.error(`Failed to load spec at ${specPath}:`, err instanceof Error ? err.message : err);
  process.exit(1);
}

if (!spec || typeof spec.name !== 'string') {
  console.error('Spec missing "name" field');
  process.exit(1);
}

const tsSourcePath = path.join(moduleRoot, 'src', 'index.ts');
const tsSource = await fs.readFile(tsSourcePath, 'utf8');
const transpiled = ts.transpileModule(tsSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true
  }
});

const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText, 'utf8').toString('base64')}`;
const moduleExports = await import(moduleUrl);
const safetyPort = moduleExports?.safetyPort;
if (!safetyPort) {
  console.error('SafetyPort provider not exported from src/index.ts');
  process.exit(1);
}

const failures = [];
let assertions = 0;

for (const entry of Array.isArray(spec.normalize) ? spec.normalize : []) {
  if (!entry) continue;
  const actual = await safetyPort.normalizePath(entry.input);
  const expected = entry.expect;
  assertions += 1;
  if (actual !== expected) {
    failures.push(`normalizePath(${JSON.stringify(entry.input)}) → ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
  }
}

for (const entry of Array.isArray(spec.safe) ? spec.safe : []) {
  if (!entry) continue;
  const value = typeof entry === 'string' ? entry : entry.path;
  const expected = typeof entry === 'object' && entry !== null && Object.prototype.hasOwnProperty.call(entry, 'expected')
    ? Boolean(entry.expected)
    : true;
  const actual = await safetyPort.isSafe(value);
  assertions += 1;
  if (actual !== expected) {
    failures.push(`isSafe(${JSON.stringify(value)}) → ${actual} (expected ${expected})`);
  }
}

for (const value of Array.isArray(spec.unsafe) ? spec.unsafe : []) {
  if (!value) continue;
  const actual = await safetyPort.isSafe(value);
  assertions += 1;
  if (actual !== false) {
    failures.push(`isSafe(${JSON.stringify(value)}) should be false but returned ${actual}`);
  }
}

if (failures.length > 0) {
  console.error(`SafetyPort cases failed (${failures.length}):`);
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  process.exit(1);
}

console.log(`PASS ${spec.name} (${assertions} assertions)`);
