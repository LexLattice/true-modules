#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const testsDir = path.dirname(__filename);
const outPath = path.join(testsDir, 'oracle-nondet.txt');

const token = crypto.randomBytes(8).toString('hex');
const now = Date.now();
await fs.writeFile(outPath, `${now}:${token}\n`, 'utf8');
console.log(`oracle nondeterministic token=${token}`);
