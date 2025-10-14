import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { tools } from '../server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const artifactDir = path.join(repoRoot, 'artifacts', 'mcp');

const defaultLogger = {
  info() {},
  warn() {},
  error() {}
};

async function listTmpEntries() {
  const entries = await fs.readdir('/tmp');
  return entries.filter((entry) => entry.startsWith('tm-mcp-')).sort();
}

async function ensureServerBoots(modulesRoot) {
  const child = spawn(process.execPath, ['mcp/server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TM_MCP_MODULES_ROOT: modulesRoot
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal === 'SIGTERM' || code === 0) {
        resolve({ code, signal, stdout, stderr });
        return;
      }
      const error = new Error(`MCP server exited unexpectedly with code ${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });

  // Give the server a moment to initialise before shutting it down.
  await delay(500);
  child.kill('SIGTERM');
  await exitPromise;
}

async function loadJson(relativePath) {
  const abs = path.join(repoRoot, relativePath);
  const raw = await fs.readFile(abs, 'utf8');
  return JSON.parse(raw);
}

async function writeArtifact(fileName, payload) {
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, fileName), JSON.stringify(payload, null, 2));
}

async function run() {
  const modulesRoot = process.env.TM_MCP_MODULES_ROOT
    ? path.resolve(process.env.TM_MCP_MODULES_ROOT)
    : path.join(repoRoot, 'examples', 'modules');

  const tmpBefore = await listTmpEntries();

  // Ensure the server process can boot cleanly on stdio.
  await ensureServerBoots(modulesRoot);

  const coverage = await loadJson('examples/coverage.json');
  const composePlan = await loadJson('examples/compose.json');

  const metaResult = await tools.meta({ input: { coverage } }, { logger: defaultLogger });
  assert.ok(metaResult);
  assert.ok(metaResult.compose && typeof metaResult.compose === 'object', 'tm.meta should return a compose object');
  assert.ok(Array.isArray(metaResult.compose.modules), 'compose.modules should be an array');
  assert.ok(metaResult.compose.modules.length > 0, 'compose.modules should not be empty');
  await writeArtifact('meta.json', metaResult);

  const composeResult = await tools.compose(
    { input: { compose: composePlan, modulesRoot } },
    { logger: defaultLogger }
  );
  assert.ok(composeResult && typeof composeResult === 'object', 'tm.compose should return a payload');
  assert.ok(composeResult.report, 'tm.compose should return a report');
  assert.ok(Array.isArray(composeResult.report.bill_of_materials), 'report.bill_of_materials should be an array');
  assert.ok(composeResult.report.bill_of_materials.length > 0, 'bill_of_materials should not be empty');
  await writeArtifact('compose.json', composeResult);

  const gatesResult = await tools.gates(
    { input: { compose: composePlan, modulesRoot, mode: 'shipping' } },
    { logger: defaultLogger }
  );
  assert.ok(gatesResult && typeof gatesResult === 'object', 'tm.gates should return a payload');
  assert.strictEqual(gatesResult.pass, true, 'shipping gates should pass on the example compose plan');
  assert.ok(Array.isArray(gatesResult.events), 'gates events should be an array');
  assert.ok(gatesResult.events.length > 0, 'gates events should not be empty');
  const hasSchema = gatesResult.events.some((event) => event && typeof event === 'object' && event.schema === 'tm-events@1');
  assert.ok(hasSchema, 'at least one event should include the tm-events@1 schema marker');
  await writeArtifact('gates.json', gatesResult);

  const tmpAfter = await listTmpEntries();
  const beforeSet = new Set(tmpBefore);
  const afterSet = new Set(tmpAfter);
  const leaked = [...afterSet].filter((entry) => !beforeSet.has(entry));
  const removed = [...beforeSet].filter((entry) => !afterSet.has(entry));
  if (leaked.length || removed.length) {
    let message = 'MCP server run modified /tmp entries prefixed with tm-mcp-.';
    if (leaked.length) {
      const leakedPaths = leaked.map((entry) => path.join('/tmp', entry)).join('\n - ');
      message += `\nLeaked directories:\n - ${leakedPaths}`;
    }
    if (removed.length) {
      message += `\nMissing directories: ${removed.join(', ')}`;
    }
    throw new Error(message);
  }
}

await run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
