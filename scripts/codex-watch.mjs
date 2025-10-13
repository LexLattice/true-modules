#!/usr/bin/env node
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import {
  ensureDir,
  updateManifest,
  eventsPath,
  defaultEventContext,
  defaultEventSource,
  readLastSeq,
  nowIso,
  relativize
} from './lib/headless-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function usage() {
  console.error('Usage: node scripts/codex-watch.mjs <task_id> --run-dir <dir> [--interval-ms <n>] [--timeout-ms <n>]');
  process.exit(1);
}

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runCmd(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => {
      reject(err);
    });
    child.on('exit', code => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error(stderr.trim() || stdout.trim() || `Exit ${code}`);
        error.exitCode = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function normalizeTaskList(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.tasks)) return payload.tasks;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function extractStatus(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return entry.status || entry.state || null;
}

async function appendEvent({ eventsFile, seqRef, context, source }, event, detail) {
  seqRef.value += 1;
  const envelope = {
    schema: 'tm-events@1',
    event,
    ts: nowIso(),
    seq: seqRef.value,
    source,
    context,
    ...(detail && Object.keys(detail).length ? { detail } : {})
  };
  await fsp.appendFile(eventsFile, JSON.stringify(envelope) + '\n');
  return envelope;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const taskId = args.positional[0] || args.task;
  const runDirArg = args['run-dir'] || args.runDir;
  if (!taskId || !runDirArg) usage();

  const runDir = path.resolve(runDirArg);
  const codexBin = process.env.CODEX_BIN || 'codex';
  const intervalMs = Number(args['interval-ms'] || 5000);
  const timeoutMsRaw = args['timeout-ms'];
  const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : null;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    console.error('--interval-ms must be a positive number');
    process.exit(1);
  }
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    console.error('--timeout-ms must be a positive number');
    process.exit(1);
  }

  await ensureDir(runDir);
  const eventsFile = eventsPath(runDir);
  await ensureDir(path.dirname(eventsFile));

  const manifest = await updateManifest(runDir, current => {
    const next = { ...current };
    if (!next.task_id) next.task_id = taskId;
    next.events_mode = next.events_mode || 'shipping';
    next.artifacts = next.artifacts || {};
    next.artifacts.events = next.artifacts.events || relativize(eventsFile);
    next.watch = {
      ...(next.watch || {}),
      started_at: nowIso(),
      status: 'watching',
      interval_ms: intervalMs
    };
    if (!next.run_id) next.run_id = `watch:${taskId}`;
    return next;
  });

  const context = await defaultEventContext(manifest);
  const source = await defaultEventSource();
  const seqRef = { value: await readLastSeq(eventsFile) };

  await appendEvent({ eventsFile, seqRef, context, source }, 'GATES_START', {
    code: 'WATCH_START',
    message: `Watching task ${taskId}`
  });

  const started = Date.now();
  let lastStatus = null;
  let lastEventAt = 0;

  while (true) {
    if (timeoutMs && Date.now() - started > timeoutMs) {
      await appendEvent({ eventsFile, seqRef, context, source }, 'GATES_FAIL', {
        code: 'WATCH_TIMEOUT',
        message: `Timed out after ${timeoutMs}ms` }
      );
      await updateManifest(runDir, current => ({
        ...current,
        watch: {
          ...(current.watch || {}),
          ended_at: nowIso(),
          status: 'timeout'
        }
      }));
      process.exitCode = 1;
      return;
    }

    try {
      const { stdout } = await runCmd(codexBin, ['cloud', 'list', '--json']);
      let payload;
      try {
        payload = JSON.parse(stdout || '[]');
      } catch (err) {
        await appendEvent({ eventsFile, seqRef, context, source }, 'GATES_WARN', {
          code: 'WATCH_PARSE_ERROR',
          message: `Failed to parse cloud list JSON: ${err.message || err}`
        });
        await sleep(intervalMs);
        continue;
      }
      const entries = normalizeTaskList(payload);
      const entry = entries.find(item => (
        item && (item.task_id === taskId || item.id === taskId || item.taskId === taskId)
      ));
      if (!entry) {
        const now = Date.now();
        if (now - lastEventAt > intervalMs * 2) {
          await appendEvent({ eventsFile, seqRef, context, source }, 'GATES_WARN', {
            code: 'WATCH_NOT_FOUND',
            message: `Task ${taskId} not present in cloud list`
          });
          lastEventAt = now;
        }
        await sleep(intervalMs);
        continue;
      }
      const status = extractStatus(entry) || 'unknown';
      if (status !== lastStatus) {
        await appendEvent({ eventsFile, seqRef, context, source }, 'GATES_WARN', {
          code: 'WATCH_STATUS',
          message: status
        });
        lastStatus = status;
        lastEventAt = Date.now();
      }
      if (status === 'ready') {
        await appendEvent({ eventsFile, seqRef, context, source }, 'GATES_PASS', {
          code: 'WATCH_READY',
          message: `Task ${taskId} ready`
        });
        await updateManifest(runDir, current => ({
          ...current,
          watch: {
            ...(current.watch || {}),
            ended_at: nowIso(),
            status: 'ready'
          }
        }));
        return;
      }
      if (status === 'error' || status === 'failed' || status === 'cancelled') {
        await appendEvent({ eventsFile, seqRef, context, source }, 'GATES_FAIL', {
          code: 'WATCH_ERROR',
          message: entry.error || entry.message || status
        });
        await updateManifest(runDir, current => ({
          ...current,
          watch: {
            ...(current.watch || {}),
            ended_at: nowIso(),
            status: 'error',
            error: entry.error || entry.message || status
          }
        }));
        process.exitCode = 1;
        return;
      }
    } catch (err) {
      await appendEvent({ eventsFile, seqRef, context, source }, 'GATES_WARN', {
        code: 'WATCH_COMMAND_ERROR',
        message: err.message || String(err)
      });
    }

    await sleep(intervalMs);
  }
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
