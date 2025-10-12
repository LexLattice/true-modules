#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const targetFile = process.argv[2];
if (!targetFile) {
  console.error('Usage: node scripts/validate-events.mjs <events.ndjson>');
  process.exit(1);
}

const specDir = path.resolve(__dirname, '..', 'spec');

async function loadSchema() {
  const schemaPath = path.join(specDir, 'events.schema.json');
  const txt = await fs.readFile(schemaPath, 'utf8');
  return JSON.parse(txt);
}

(async () => {
  const schema = await loadSchema();
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  const buf = await fs.readFile(path.resolve(targetFile), 'utf8');
  const lines = buf.split(/\r?\n/).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch (err) {
      console.error(`Line ${i + 1}: invalid JSON - ${err.message}`);
      process.exit(1);
    }
    const ok = validate(parsed);
    if (!ok) {
      const message = (validate.errors || [])
        .map(e => `${e.instancePath} ${e.message}`)
        .join('; ');
      console.error(`Line ${i + 1}: schema violation - ${message}`);
      process.exit(1);
    }
  }
  console.log(`✓ ${lines.length} events validated against tm-events@1`);
})();
