#!/usr/bin/env node
import fs from 'fs';

function usage() {
  console.error('Usage: node scripts/lib/get-manifest-prop.mjs <manifest> <path>');
  process.exit(1);
}

const [, , manifestPath, keyPath] = process.argv;
if (!manifestPath || !keyPath) {
  usage();
}

let manifest;
try {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  manifest = JSON.parse(raw);
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}

const segments = keyPath.split('.');
let current = manifest;
for (const segment of segments) {
  if (current && Object.prototype.hasOwnProperty.call(current, segment)) {
    current = current[segment];
  } else {
    process.exit(1);
  }
}

if (current === null || current === undefined) {
  process.exit(1);
}

if (typeof current === 'object') {
  process.stdout.write(`${JSON.stringify(current)}\n`);
} else {
  process.stdout.write(`${current}\n`);
}
