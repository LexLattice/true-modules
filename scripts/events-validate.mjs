#!/usr/bin/env node
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { tmError } from './lib/provider-analysis.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.resolve(__dirname, '../spec/events.schema.json');

let validatorPromise = null;
async function getValidator() {
  if (!validatorPromise) {
    validatorPromise = (async () => {
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      addFormats(ajv);
      const raw = await fsp.readFile(schemaPath, 'utf8');
      const schema = JSON.parse(raw);
      return ajv.compile(schema);
    })();
  }
  return validatorPromise;
}

async function processStream(inputPath, { strict = false, collect = false } = {}) {
  const absolute = path.resolve(inputPath);
  await fsp.access(absolute, fs.constants.R_OK);
  const validate = await getValidator();
  const stream = fs.createReadStream(absolute, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const events = [];
  let eventCount = 0;
  let lineNumber = 0;
  let lastSeq = 0;
  let seenAny = false;
  let expectedSha = null;
  let expectedRunId = null;

  try {
    for await (const line of rl) {
      lineNumber += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch (err) {
        throw tmError('E_EVENT_SCHEMA', `Line ${lineNumber}: invalid JSON (${err?.message || err})`);
      }
      const valid = validate(obj);
      if (!valid) {
        const message = (validate.errors || [])
          .map(e => `${e.instancePath || '.'} ${e.message}`)
          .join('; ');
        throw tmError('E_EVENT_SCHEMA', `Line ${lineNumber}: ${message || 'failed schema validation'}`);
      }
      if (seenAny) {
        if (strict) {
          if (obj.seq !== lastSeq + 1) {
            throw tmError('E_EVENT_SCHEMA', `Line ${lineNumber}: sequence ${obj.seq} is not contiguous after ${lastSeq}`);
          }
        } else if (obj.seq <= lastSeq) {
          throw tmError('E_EVENT_SCHEMA', `Line ${lineNumber}: sequence ${obj.seq} is not greater than previous ${lastSeq}`);
        }
      }
      lastSeq = obj.seq;
      seenAny = true;
      eventCount += 1;

      const sha = obj.context?.compose_sha256;
      if (sha) {
        if (!expectedSha) {
          expectedSha = sha;
        } else if (sha !== expectedSha) {
          throw tmError('E_EVENT_SCHEMA', `Line ${lineNumber}: compose_sha256 mismatch (expected ${expectedSha}, got ${sha})`);
        }
      }

      const runId = obj.context?.run_id;
      if (runId) {
        if (!expectedRunId) {
          expectedRunId = runId;
        } else if (runId !== expectedRunId) {
          throw tmError('E_EVENT_SCHEMA', `Line ${lineNumber}: run_id mismatch (expected ${expectedRunId}, got ${runId})`);
        }
      }

      if (collect) events.push(obj);
    }
  } catch (err) {
    rl.close();
    stream.destroy();
    throw err;
  }

  rl.close();
  stream.destroy();

  return { events, count: eventCount, composeSha: expectedSha, runId: expectedRunId };
}

export async function validateEventsFile(inputPath, { strict = false } = {}) {
  const { count, composeSha, runId } = await processStream(inputPath, { strict, collect: false });
  return { count, composeSha, runId };
}

export async function readEvents(inputPath, { strict = false } = {}) {
  return processStream(inputPath, { strict, collect: true });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    console.log('Usage: node scripts/events-validate.mjs <file> [--strict]');
    process.exit(args.length ? 0 : 1);
  }
  const strict = args.includes('--strict');
  const file = args.find(arg => !arg.startsWith('--'));
  if (!file) {
    console.error('events-validate: missing <file> argument');
    process.exit(1);
  }
  try {
    const { count, composeSha } = await validateEventsFile(file, { strict });
    console.log(`✓ ${count} events validated${composeSha ? ` (compose ${composeSha})` : ''}`);
  } catch (err) {
    if (err?.code === 'E_EVENT_SCHEMA') {
      console.error(err.message);
      process.exit(1);
    }
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

const invokedDirectly = path.resolve(process.argv[1] || '') === __filename;
if (invokedDirectly) {
  main();
}
