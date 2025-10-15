#!/usr/bin/env node
import path from 'path';
import fs from 'fs/promises';
import process from 'process';
import { fileURLToPath, pathToFileURL } from 'url';

const args = new Map(
  process.argv.slice(2).map((value, idx, arr) => {
    if (!value.startsWith('--')) return null;
    return [value.replace(/^--/, ''), arr[idx + 1]];
  }).filter(Boolean)
);

const specArg = args.get('spec');
const moduleRoot = args.get('moduleRoot');

if (!specArg || !moduleRoot) {
  console.error('Usage: runner.mjs --spec <file> --moduleRoot <dir>');
  process.exit(1);
}

const specPath = path.isAbsolute(specArg) ? specArg : path.join(moduleRoot, specArg);
const spec = JSON.parse(await fs.readFile(specPath, 'utf8'));

if (!spec.name) {
  console.error('Spec missing "name" field');
  process.exit(1);
}

const entry = path.join(moduleRoot, 'src', 'index.ts');
const compiledUrl = pathToFileURL(entry).href;

try {
  const mod = await import(compiledUrl);
  if (typeof mod.greet !== 'function') {
    console.error('Expected greet export to be a function');
    process.exit(1);
  }
  const result = mod.greet('world');
  if (typeof result !== 'string' || !result.toLowerCase().includes('hello')) {
    console.error('greet("world") did not include "hello"');
    process.exit(1);
  }
} catch (err) {
  console.error(err?.stack || err);
  process.exit(1);
}
