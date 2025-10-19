#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import process from 'process';

import { reporterWrite } from '../src/index.js';

function parseArgs(argv) {
  const result = new Map();
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    result.set(key, value);
    i += 1;
  }
  return result;
}

async function loadSpec(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function allocateScratch(rootDir) {
  const scratchRoot = path.join(rootDir, '.tmp');
  await fs.mkdir(scratchRoot, { recursive: true });
  return fs.mkdtemp(path.join(scratchRoot, 'case-'));
}

async function runCase(spec, moduleRoot) {
  const logDir = await allocateScratch(moduleRoot);
  try {
    switch (spec.case) {
      case 'create-log': {
        const res = await reporterWrite(spec.message, { logDir });
        assert.equal(res.appended, true);
        const contents = await fs.readFile(res.file, 'utf8');
        assert.match(contents, new RegExp(`${spec.message}\\s*$`, 'm'));
        break;
      }
      case 'preserve-order': {
        const first = await reporterWrite(spec.messages[0], { logDir });
        const second = await reporterWrite(spec.messages[1], { logDir });
        assert.equal(first.appended, true);
        assert.equal(second.appended, true);
        const contents = await fs.readFile(second.file, 'utf8');
        const lines = contents.trim().split(/\r?\n/);
        assert.deepEqual(lines, spec.messages);
        break;
      }
      case 'idempotent': {
        const first = await reporterWrite(spec.message, { logDir });
        assert.equal(first.appended, true);

        if (Array.isArray(spec.interleave)) {
          for (const entry of spec.interleave) {
            const res = await reporterWrite(entry, { logDir });
            assert.equal(res.appended, true);
          }
        }

        const second = await reporterWrite(spec.message, { logDir });
        assert.equal(second.appended, false);

        const contents = await fs.readFile(second.file, 'utf8');
        const lines = contents
          .split(/\r?\n/)
          .map((line) => line.trimEnd())
          .filter((line) => line.length > 0);
        const occurrences = lines.filter((line) => line === spec.message);
        assert.equal(occurrences.length, 1);
        break;
      }
      default:
        throw new Error(`Unknown spec case: ${spec.case}`);
  }
} finally {
  await fs.rm(logDir, { recursive: true, force: true });
}
}

async function main() {
  const args = parseArgs(process.argv);
  const specPath = args.get('spec');
  const moduleRoot = args.get('moduleRoot');
  if (!specPath) {
    throw new Error('Missing --spec argument');
  }
  if (!moduleRoot) {
    throw new Error('Missing --moduleRoot argument');
  }
  const spec = await loadSpec(specPath);
  await runCase(spec, moduleRoot);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
