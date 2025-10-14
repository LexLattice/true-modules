#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const testsDir = path.dirname(__filename);
const outPath = path.join(testsDir, 'oracle-output.txt');

const payload = [
  'repeatable-diff-oracle',
  'v1',
  new Date('2020-01-01T00:00:00Z').toISOString()
].join('\n');

await fs.writeFile(outPath, payload + '\n', 'utf8');
console.log(`oracle wrote ${path.basename(outPath)} (${payload.length} bytes)`);
