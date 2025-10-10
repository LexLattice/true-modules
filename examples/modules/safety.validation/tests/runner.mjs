#!/usr/bin/env node
import fs from 'fs/promises';
import process from 'process';
import path from 'path';

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
const spec = JSON.parse(await fs.readFile(specPath, 'utf8'));

if (!spec.name) {
  console.error('Spec missing "name" field');
  process.exit(1);
}

process.exit(0);
