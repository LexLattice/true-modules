#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import process from 'process';

class CanonError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.code = code;
    if (detail) this.detail = detail;
  }
}

function usage() {
  console.error('Usage: node scripts/canon-verify.mjs --lock <file> --modules-root <dir> [--compose <file>]');
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`);
    }
    args[name] = value;
    i += 1;
  }
  return args;
}

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new CanonError('E_CANON_MISSING_RESOURCE', `File not found: ${filePath}`);
    }
    throw new CanonError('E_CANON_PARSE', `Failed to parse JSON at ${filePath}: ${err.message}`);
  }
}

function ensureArray(value, code, message) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CanonError(code, message);
  }
  return value;
}

async function ensureFileExists(filePath, code, message) {
  try {
    await fs.access(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new CanonError(code, message, { file: filePath });
    }
    throw new CanonError(code, message, { file: filePath, cause: err?.message });
  }
}

async function verifyModule(id, declaration, modulesRoot, composeModules) {
  if (!id || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new CanonError('E_CANON_PARSE', `Invalid lock entry for module ${id}`);
  }
  if (composeModules && !composeModules.has(id)) {
    throw new CanonError('E_CANON_MISSING_MODULE', `Compose plan is missing module ${id}`);
  }

  const moduleRoot = path.join(modulesRoot, id);
  const manifestPath = path.join(moduleRoot, 'module.json');
  const manifest = await readJson(manifestPath).catch((err) => {
    if (err instanceof CanonError && err.code === 'E_CANON_MISSING_RESOURCE') {
      throw new CanonError('E_CANON_MISSING_MODULE', `Module manifest missing for ${id}`, { manifest: manifestPath });
    }
    throw err;
  });

  const manifestPorts = manifest.port_exports || {};
  const manifestTests = new Set(manifest.tests || []);
  const manifestInvariants = new Set(manifest.invariants || []);

  if (!declaration.ports || typeof declaration.ports !== 'object') {
    throw new CanonError('E_CANON_PARSE', `Lock entry for ${id} must include "ports" object`);
  }

  for (const [portName, spec] of Object.entries(declaration.ports)) {
    const manifestPort = manifestPorts[portName];
    if (!manifestPort) {
      throw new CanonError('E_CANON_MISSING_INTERFACE', `Missing port_exports entry for ${portName} in ${id}`);
    }
    if (!spec || typeof spec !== 'object') {
      throw new CanonError('E_CANON_PARSE', `Invalid port declaration for ${portName} in lock`);
    }
    if (spec.export?.file && manifestPort.file !== spec.export.file) {
      throw new CanonError(
        'E_CANON_PORT_MISMATCH',
        `Port ${portName} in ${id} must export file ${spec.export.file}`,
        { expected: spec.export.file, found: manifestPort.file }
      );
    }
    if (spec.export?.symbol && manifestPort.export !== spec.export.symbol) {
      throw new CanonError(
        'E_CANON_PORT_MISMATCH',
        `Port ${portName} in ${id} must export symbol ${spec.export.symbol}`,
        { expected: spec.export.symbol, found: manifestPort.export }
      );
    }
    const resolvedFile = path.join(moduleRoot, manifestPort.file);
    await ensureFileExists(resolvedFile, 'E_CANON_PORT_MISSING_FILE', `Port export file missing for ${portName} in ${id}`);
  }

  if (declaration.invariants) {
    for (const [name, invariantSpec] of Object.entries(declaration.invariants)) {
      if (!manifestInvariants.has(name)) {
        throw new CanonError('E_CANON_MISSING_INVARIANT', `Invariant ${name} not declared in module.json for ${id}`);
      }
      const testPath = invariantSpec?.test;
      if (!testPath || typeof testPath !== 'string') {
        throw new CanonError('E_CANON_PARSE', `Invariant ${name} for ${id} must specify a test path`);
      }
      if (!manifestTests.has(testPath)) {
        throw new CanonError(
          'E_CANON_MISSING_INVARIANT_TEST',
          `Invariant test ${testPath} missing from module.json for ${id}`
        );
      }
      const resolvedTest = path.join(moduleRoot, testPath);
      await ensureFileExists(
        resolvedTest,
        'E_CANON_MISSING_INVARIANT_TEST',
        `Invariant test file missing for ${name} in ${id}`
      );
    }
  }

  if (declaration.acceptance) {
    for (const [label, testPath] of Object.entries(declaration.acceptance)) {
      if (typeof testPath !== 'string') {
        throw new CanonError('E_CANON_PARSE', `Acceptance ${label} for ${id} must be a string path`);
      }
      if (!manifestTests.has(testPath)) {
        throw new CanonError(
          'E_CANON_MISSING_ACCEPTANCE',
          `Acceptance ${label} missing from module.json for ${id}`
        );
      }
      const resolvedTest = path.join(moduleRoot, testPath);
      await ensureFileExists(
        resolvedTest,
        'E_CANON_MISSING_ACCEPTANCE',
        `Acceptance spec file missing (${label}) for ${id}`
      );
    }
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    usage();
    return;
  }

  const lockPath = args.lock;
  const modulesRoot = args['modules-root'] || args.modulesRoot;
  const composePath = args.compose;
  if (!lockPath || !modulesRoot) usage();

  const lock = await readJson(path.resolve(lockPath));
  if (!lock.modules || typeof lock.modules !== 'object') {
    throw new CanonError('E_CANON_PARSE', 'Canon lock must provide a "modules" object');
  }

  let composeModules = null;
  if (composePath) {
    const compose = await readJson(path.resolve(composePath));
    const modList = ensureArray(compose.modules, 'E_CANON_PARSE', 'Compose file missing "modules" array');
    composeModules = new Set(
      modList
        .map((m) => (m && typeof m.id === 'string' ? m.id : null))
        .filter(Boolean)
    );
  }

  for (const [moduleId, declaration] of Object.entries(lock.modules)) {
    // eslint-disable-next-line no-await-in-loop
    await verifyModule(moduleId, declaration, path.resolve(modulesRoot), composeModules);
  }
}

main()
  .then(() => {
    console.error('Canon verification completed.');
  })
  .catch((err) => {
    if (err instanceof CanonError) {
      const detail = err?.detail ? `\n${JSON.stringify(err.detail, null, 2)}` : '';
      console.error(`${err.code}: ${err.message}${detail}`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });
