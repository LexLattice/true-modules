import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

let ServerCtor;
let McpErrorCtor;
let sdkLoadedFromStub = false;

async function loadSdk() {
  if (ServerCtor && McpErrorCtor) return;
  try {
    const serverMod = await import('@modelcontextprotocol/sdk/server');
    ServerCtor = serverMod.Server ?? serverMod.default ?? serverMod;
    try {
      const typesMod = await import('@modelcontextprotocol/sdk/types');
      McpErrorCtor = typesMod.McpError ?? typesMod.default ?? serverMod.McpError;
    } catch (typeErr) {
      if (serverMod.McpError) {
        McpErrorCtor = serverMod.McpError;
      } else {
        throw typeErr;
      }
    }
  } catch (err) {
    const stub = await import('./sdk-stub.mjs');
    ServerCtor = stub.Server;
    McpErrorCtor = stub.McpError;
    sdkLoadedFromStub = true;
  }
}

await loadSdk();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));

function createServerInstance() {
  const metadata = {
    name: 'true-modules-mcp',
    version: packageJson.version || '0.0.0',
    description: 'Model Context Protocol façade for the True Modules CLI'
  };
  let server;
  try {
    server = new ServerCtor(metadata, { capabilities: { tools: {} } });
  } catch (err) {
    server = new ServerCtor(metadata);
  }
  if (sdkLoadedFromStub) {
    console.warn('[tm-mcp] Using local MCP stub. Install @modelcontextprotocol/sdk for production use.');
  }
  registerTools(server);
  return server;
}

function asMcpError(code, message, data) {
  if (code instanceof McpErrorCtor) return code;
  const err = new McpErrorCtor(code, message, data);
  if (!('code' in err)) err.code = code;
  if (data !== undefined && err.data === undefined) err.data = data;
  return err;
}

async function withTempDir(fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-mcp-'));
  try {
    return await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function writeJsonFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function normalizeJsonInput(name, value, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (!required) return undefined;
    throw asMcpError('E_INPUT', `${name} is required.`);
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (err) {
      throw asMcpError('E_INPUT', `${name} must be valid JSON if provided as a string.`);
    }
  }
  if (typeof value === 'object') {
    return value;
  }
  throw asMcpError('E_INPUT', `${name} must be an object or JSON string.`);
}

async function resolveModulesRoot(provided) {
  const candidate = provided ?? process.env.TM_MCP_MODULES_ROOT;
  if (!candidate) {
    throw asMcpError('E_MODULES_ROOT_REQUIRED', 'modulesRoot not provided and TM_MCP_MODULES_ROOT is not set.');
  }
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(repoRoot, candidate);
  let stats;
  try {
    stats = await fs.stat(resolved);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw asMcpError('E_MODULES_ROOT', `modulesRoot does not exist: ${resolved}`);
    }
    throw asMcpError('E_MODULES_ROOT', `Failed to access modulesRoot: ${resolved}`);
  }
  if (!stats.isDirectory()) {
    throw asMcpError('E_MODULES_ROOT', `modulesRoot must be a directory: ${resolved}`);
  }
  return resolved;
}

function streamToLogger(stream, logger, level) {
  if (!logger) return;
  const logFn = logger[level] || logger.info || logger.log;
  if (!logFn) return;
  stream.on('data', (chunk) => {
    const text = chunk.toString();
    if (!text.trim()) return;
    logFn.call(logger, text.trimEnd());
  });
}

function extractCliError(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    const match = /^tm error:\s*([A-Z0-9_]+)\s*(.*)$/i.exec(line);
    if (match) {
      const [, code, message] = match;
      return { code: code.toUpperCase(), message: message?.trim() || `tm CLI failed with ${code}` };
    }
  }
  return null;
}

async function runTm(args, { logger } = {}) {
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, ['tm.mjs', ...args], {
        cwd: repoRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      reject(asMcpError('E_SPAWN', 'Failed to launch tm CLI.', { args, error: err?.message ?? String(err) }));
      return;
    }
    let stdout = '';
    let stderr = '';
    streamToLogger(child.stdout, logger, 'info');
    streamToLogger(child.stderr, logger, 'error');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      reject(asMcpError('E_SPAWN', 'tm CLI process failed to start.', { args, error: err?.message ?? String(err) }));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const parsed = extractCliError(stderr);
      const cliMessage = parsed?.message || `tm CLI failed with exit code ${code}`;
      const cliCode = parsed?.code || 'E_TM_CLI';
      const error = asMcpError(cliCode, cliMessage, { exitCode: code, stdout, stderr, args });
      error.stderr = stderr;
      error.exitCode = code;
      reject(error);
    });
  });
}

async function parseEvents(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const events = [];
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx].trim();
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch (err) {
        throw asMcpError('E_EVENTS_PARSE', 'Failed to parse tm gates events.', {
          filePath,
          lineNumber: idx + 1,
          line,
          error: err?.message ?? String(err)
        });
      }
    }
    return events;
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    if (err instanceof McpErrorCtor) throw err;
    throw asMcpError('E_EVENTS_READ', 'Failed to read tm gates events output.', {
      filePath,
      error: err?.message ?? String(err)
    });
  }
}

async function maybeWriteOverrides(tempDir, overrides) {
  if (overrides === undefined) return null;
  const overridesPath = path.join(tempDir, 'overrides.json');
  await writeJsonFile(overridesPath, overrides);
  return overridesPath;
}

async function tmMetaTool({ input }, { logger }) {
  const coverage = normalizeJsonInput('coverage', input?.coverage);
  const respectRequires = Boolean(input?.respectRequires);
  return await withTempDir(async (tempDir) => {
    const coveragePath = path.join(tempDir, 'coverage.json');
    const composePath = path.join(tempDir, 'compose.json');
    await writeJsonFile(coveragePath, coverage);
    const args = ['meta', '--coverage', coveragePath, '--out', composePath];
    if (respectRequires) {
      args.push('--respect-requires');
    }
    await runTm(args, { logger });
    const compose = await readJsonFile(composePath);
    return { compose };
  });
}

async function tmComposeTool({ input }, { logger }) {
  const compose = normalizeJsonInput('compose', input?.compose);
  const overrides = normalizeJsonInput('overrides', input?.overrides, { required: false });
  const modulesRoot = await resolveModulesRoot(input?.modulesRoot);
  return await withTempDir(async (tempDir) => {
    const composePath = path.join(tempDir, 'compose.json');
    const winnerDir = path.join(tempDir, 'winner');
    await writeJsonFile(composePath, compose);
    const overridesPath = await maybeWriteOverrides(tempDir, overrides);
    const args = [
      'compose',
      '--compose',
      composePath,
      '--modules-root',
      modulesRoot,
      '--out',
      winnerDir
    ];
    if (overridesPath) {
      args.push('--overrides', overridesPath);
    }
    await runTm(args, { logger });
    const report = await readJsonFile(path.join(winnerDir, 'report.json'));
    return { report };
  });
}

async function tmGatesTool({ input }, { logger }) {
  const mode = String(input?.mode || '').trim() || 'shipping';
  if (!['conceptual', 'shipping'].includes(mode)) {
    throw asMcpError('E_INPUT', "mode must be either 'conceptual' or 'shipping'.");
  }
  const compose = normalizeJsonInput('compose', input?.compose);
  const overrides = normalizeJsonInput('overrides', input?.overrides, { required: false });
  const strictEvents = Boolean(input?.strictEvents);
  const modulesRoot = await resolveModulesRoot(input?.modulesRoot);
  return await withTempDir(async (tempDir) => {
    const composePath = path.join(tempDir, 'compose.json');
    const eventsPath = path.join(tempDir, 'events.ndjson');
    await writeJsonFile(composePath, compose);
    const overridesPath = await maybeWriteOverrides(tempDir, overrides);
    try {
      const args = [
        'gates',
        mode,
        '--compose',
        composePath,
        '--modules-root',
        modulesRoot,
        '--emit-events',
        '--events-out',
        eventsPath
      ];
      if (overridesPath) {
        args.push('--overrides', overridesPath);
      }
      if (strictEvents) {
        args.push('--strict-events');
      }
      await runTm(args, { logger });
      const events = await parseEvents(eventsPath);
      return { pass: true, events };
    } catch (err) {
      let events = [];
      let eventsError = null;
      if (err?.code === 'E_EVENTS_PARSE' || err?.code === 'E_EVENTS_READ') {
        eventsError = err;
      } else {
        try {
          events = await parseEvents(eventsPath);
        } catch (eventErr) {
          eventsError = eventErr;
        }
      }
      if (err instanceof McpErrorCtor) {
        const data = { pass: false, events };
        if (eventsError) {
          data.eventsError = {
            code: eventsError.code ?? 'E_EVENTS_PARSE',
            message: eventsError.message,
            ...(eventsError.data || {})
          };
        }
        err.data = { ...(err.data || {}), ...data };
        err.events = events;
      }
      if (eventsError && err !== eventsError && !(err instanceof McpErrorCtor)) {
        throw eventsError;
      }
      throw err;
    }
  });
}

function registerTools(server) {
  const register = (name, definition, handler) => {
    if (typeof server.tool === 'function') {
      try {
        const result = server.tool(name, definition, handler);
        if (result !== undefined) return result;
      } catch (err) {
        if (err instanceof TypeError) {
          return server.tool({ name, ...definition }, handler);
        }
        throw err;
      }
      return;
    }
    if (typeof server.registerTool === 'function') {
      return server.registerTool(name, definition, handler);
    }
    throw new Error('Server implementation does not support tool registration.');
  };

  register('tm.meta', {
    description: 'Generate a greedy compose plan from coverage data using `tm meta`.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['coverage'],
      properties: {
        coverage: {
          description: 'Coverage JSON payload or stringified JSON.',
          anyOf: [{ type: 'object' }, { type: 'string' }]
        },
        respectRequires: {
          description: 'Set true to pass --respect-requires through to the CLI.',
          type: 'boolean'
        }
      }
    }
  }, tmMetaTool);

  register('tm.compose', {
    description: 'Validate a compose plan and emit the scaffold winner report using `tm compose`.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['compose'],
      properties: {
        compose: {
          description: 'Compose JSON payload or stringified JSON.',
          anyOf: [{ type: 'object' }, { type: 'string' }]
        },
        modulesRoot: {
          description: 'Path to the modules root directory. Defaults to $TM_MCP_MODULES_ROOT.',
          type: 'string'
        },
        overrides: {
          description: 'Compose overrides JSON payload or stringified JSON forwarded to --overrides.',
          anyOf: [{ type: 'object' }, { type: 'string' }]
        }
      }
    }
  }, tmComposeTool);

  register('tm.gates', {
    description: 'Run `tm gates` in conceptual or shipping mode and capture emitted events.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['compose'],
      properties: {
        mode: {
          description: "Gate mode: 'conceptual' or 'shipping'. Defaults to 'shipping'.",
          type: 'string'
        },
        compose: {
          description: 'Compose JSON payload or stringified JSON.',
          anyOf: [{ type: 'object' }, { type: 'string' }]
        },
        modulesRoot: {
          description: 'Path to the modules root directory. Defaults to $TM_MCP_MODULES_ROOT.',
          type: 'string'
        },
        overrides: {
          description: 'Compose overrides JSON payload or stringified JSON forwarded to --overrides.',
          anyOf: [{ type: 'object' }, { type: 'string' }]
        },
        strictEvents: {
          description: 'Set true to enforce event schema validation (--strict-events).',
          type: 'boolean'
        }
      }
    }
  }, tmGatesTool);
}

export async function createTmServer() {
  return createServerInstance();
}

async function startServer(server) {
  if (typeof server.start === 'function') return server.start();
  if (typeof server.listen === 'function') return server.listen();
  if (typeof server.run === 'function') return server.run();
  throw new Error('Unable to start MCP server: no start/listen/run method found.');
}

if (import.meta.url === pathToFileURL(process.argv[1])?.href) {
  const server = await createTmServer();
  await startServer(server);
}

export const tools = {
  meta: tmMetaTool,
  compose: tmComposeTool,
  gates: tmGatesTool
};
