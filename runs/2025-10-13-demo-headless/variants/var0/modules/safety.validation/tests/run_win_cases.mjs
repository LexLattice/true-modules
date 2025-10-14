#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

if (process.platform !== 'win32') {
  console.log(`SKIP SafetyPort Windows cases (platform=${process.platform})`);
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const testsDir = path.dirname(__filename);
const moduleRoot = path.resolve(testsDir, '..');
const specPath = path.join(testsDir, 'spec_paths_windows.json');

let spec;
try {
  spec = JSON.parse(await fs.readFile(specPath, 'utf8'));
} catch (err) {
  console.error(`Failed to load ${specPath}:`, err instanceof Error ? err.message : err);
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

for (const entry of spec.normalize || []) {
  if (!entry) continue;
  const actual = await safetyPort.normalizePath(entry.input);
  const expected = entry.expect;
  assertions += 1;
  if (actual !== expected) {
    failures.push(`normalizePath(${JSON.stringify(entry.input)}) → ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
  }
}

for (const entry of spec.safe || []) {
  if (!entry) continue;
  const actual = await safetyPort.isSafe(entry.path);
  const expected = Boolean(entry.expected);
  assertions += 1;
  if (actual !== expected) {
    failures.push(`isSafe(${JSON.stringify(entry.path)}) → ${actual} (expected ${expected})`);
  }
}

for (const entry of spec.unsafe || []) {
  const actual = await safetyPort.isSafe(entry);
  assertions += 1;
  if (actual !== false) {
    failures.push(`isSafe(${JSON.stringify(entry)}) should be false but returned ${actual}`);
  }
}

if (failures.length > 0) {
  console.error(`SafetyPort Windows cases failed (${failures.length}):`);
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  process.exit(1);
}

console.log(`PASS ${spec.name} (${assertions} assertions)`);
