#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import process from 'process';

import { cliParse } from '../src/cli.js';

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

function runCase(spec) {
  switch (spec.case) {
    case 'basic': {
      const result = cliParse(spec.argv);
      assert.equal(result.command, 'report');
      assert.equal(result.errors.length, 0);
      assert.equal(result.options.format, 'json');
      assert.deepEqual(result.positionals, [spec.message]);
      break;
    }
    case 'invalid-format': {
      const result = cliParse(spec.argv);
      assert.ok(result.errors.some((err) => /unsupported format/i.test(err)));
      break;
    }
    case 'deterministic': {
      const first = cliParse(spec.argv);
      const second = cliParse(spec.argv);
      assert.deepEqual(second, first);
      break;
    }
    default:
      throw new Error(`Unknown spec case: ${spec.case}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const specPath = args.get('spec');
  if (!specPath) {
    throw new Error('Missing --spec argument');
  }
  const spec = await loadSpec(specPath);
  runCase(spec);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
