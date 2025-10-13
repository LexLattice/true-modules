import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

let pkgVersion = null;

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function manifestPath(runDir) {
  return path.join(runDir, 'run.json');
}

async function loadManifest(runDir) {
  const filePath = manifestPath(runDir);
  const existing = await readJsonIfExists(filePath);
  if (existing) return existing;
  return {
    task_id: null,
    run_id: null,
    created_at: new Date().toISOString(),
    artifacts: {},
    variants: []
  };
}

async function saveManifest(runDir, manifest) {
  const filePath = manifestPath(runDir);
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, JSON.stringify(manifest, null, 2));
}

async function updateManifest(runDir, updater) {
  const manifest = await loadManifest(runDir);
  const next = await updater(manifest) || manifest;
  await saveManifest(runDir, next);
  return next;
}

function eventsPath(runDir) {
  return path.join(runDir, 'artifacts', 'events.ndjson');
}

async function readNdjson(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeNdjson(filePath, entries) {
  await ensureDir(path.dirname(filePath));
  if (!entries || entries.length === 0) {
    await fsp.writeFile(filePath, '');
    return;
  }
  const lines = entries.map(entry => JSON.stringify(entry));
  await fsp.writeFile(filePath, lines.join('\n') + '\n');
}

function resequenceEvents(events, startSeq = 0) {
  let seq = startSeq;
  return events.map(event => ({ ...event, seq: ++seq }));
}

function nowIso() {
  return new Date().toISOString();
}

async function sha256File(filePath) {
  const buf = await fsp.readFile(filePath);
  const hash = crypto.createHash('sha256');
  hash.update(buf);
  return hash.digest('hex');
}

async function sha256String(contents) {
  const hash = crypto.createHash('sha256');
  hash.update(contents);
  return hash.digest('hex');
}

async function packageVersion() {
  if (pkgVersion) return pkgVersion;
  const pkg = await readJson(path.join(repoRoot, 'package.json'));
  pkgVersion = pkg.version || '0.0.0';
  return pkgVersion;
}

async function defaultEventContext(manifest) {
  const composeSha = manifest.compose_sha256 || '0'.repeat(64);
  const runId = manifest.run_id || manifest.task_id || 'headless';
  const mode = manifest.events_mode || 'shipping';
  return { run_id: runId, compose_sha256: composeSha, mode };
}

async function defaultEventSource() {
  return { cli: 'tm-headless', version: await packageVersion() };
}

async function readLastSeq(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) return 0;
    const last = JSON.parse(lines[lines.length - 1]);
    return Number(last.seq) || 0;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
}

function relativize(targetPath) {
  return path.relative(repoRoot, targetPath) || path.basename(targetPath);
}

export {
  ensureDir,
  loadManifest,
  saveManifest,
  updateManifest,
  eventsPath,
  readNdjson,
  writeNdjson,
  resequenceEvents,
  nowIso,
  sha256File,
  sha256String,
  packageVersion,
  defaultEventContext,
  defaultEventSource,
  readLastSeq,
  relativize,
  manifestPath
};
