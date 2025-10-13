#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { readEvents } from './events-validate.mjs';

const __filename = fileURLToPath(import.meta.url);

function formatNumber(value, digits = 3) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  return value.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function formatStartDetail(event, detail = {}) {
  const parts = [];
  if (detail.module) parts.push(`module=${detail.module}`);
  if (detail.test) parts.push(`test=${detail.test}`);
  if (detail.port) parts.push(`port=${detail.port}`);
  if (detail.lint_tool) parts.push(`lint=${detail.lint_tool}`);
  if (detail.compose_path) parts.push(`compose=${detail.compose_path}`);
  if (typeof detail.modules_total === 'number') parts.push(`modules=${detail.modules_total}`);
  return parts.length ? parts.join(' ') : 'start';
}

function formatFailureDetail(event, detail = {}) {
  const parts = [];
  if (detail.code) parts.push(`code=${detail.code}`);
  if (detail.module) parts.push(`module=${detail.module}`);
  if (detail.test) parts.push(`test=${detail.test}`);
  if (detail.port) parts.push(`port=${detail.port}`);
  if (detail.file) parts.push(`file=${detail.file}`);
  if (typeof detail.dur_ms === 'number') parts.push(`dur=${Math.round(detail.dur_ms)}ms`);
  return parts.join(' ');
}

export async function replayEvents({ inputPath, outPath, strict = false } = {}) {
  const absoluteIn = path.resolve(inputPath);
  const targetPath = path.resolve(outPath || path.join('artifacts', 'timeline.txt'));
  const { events, composeSha, runId } = await readEvents(absoluteIn, { strict });

  const lines = [];
  const header = `Run ${runId || 'unknown'} • compose ${composeSha || 'n/a'}`;
  lines.push(header);
  lines.push('-'.repeat(header.length));

  const seenFailures = new Set();

  for (const evt of events) {
    const detail = evt.detail || {};
    const ts = evt.ts || '';
    if (evt.event === 'META_PICK') {
      const drivers = detail.drivers || {};
      const goals = (drivers.coverage_goals || []).join(',') || '—';
      const bundle = Array.isArray(drivers.bundle) ? drivers.bundle.length : 0;
      const profile = detail.profile ? ` profile=${detail.profile}` : '';
      lines.push(`${ts} META_PICK ${detail.module || 'unknown'} gain=${formatNumber(detail.gain ?? 0)} goals=${goals} bundle=${bundle}${profile}`.trim());
      continue;
    }

    if (/START$/.test(evt.event)) {
      lines.push(`${ts} ${evt.event} ${formatStartDetail(evt.event, detail)}`.trim());
      continue;
    }

    if (evt.event === 'GATES_PASS' || evt.event === 'GATES_FAIL') {
      const dur = typeof detail.dur_ms === 'number' ? `${Math.round(detail.dur_ms)}ms` : 'n/a';
      const summary = evt.event === 'GATES_FAIL'
        ? `dur=${dur} code=${detail.code || 'UNKNOWN'} passed=${detail.passed ?? 0} failed=${detail.failed ?? 0}`
        : `dur=${dur} passed=${detail.passed ?? 0} failed=${detail.failed ?? 0}`;
      lines.push(`${ts} ${evt.event} ${summary}`.trim());
      continue;
    }

    if (/FAIL$/.test(evt.event)) {
      if (seenFailures.has(evt.event)) continue;
      seenFailures.add(evt.event);
      const summary = formatFailureDetail(evt.event, detail) || 'failure';
      lines.push(`${ts} ${evt.event} ${summary}`.trim());
      continue;
    }
  }

  const output = lines.join('\n');
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, output + '\n');
  return { output, timelinePath: targetPath, lines, composeSha, runId, count: events.length };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log('Usage: node scripts/events-replay.mjs <file> [--out timeline.txt] [--strict]');
    process.exit(args.length ? 0 : 1);
  }
  const strict = args.includes('--strict');
  const outIndex = args.findIndex(arg => arg === '--out');
  let outPath = null;
  if (outIndex !== -1) {
    outPath = args[outIndex + 1];
    if (!outPath) {
      console.error('--out expects a file path');
      process.exit(1);
    }
  }
  const file = args.find(arg => !arg.startsWith('--'));
  if (!file) {
    console.error('events-replay: missing <file> argument');
    process.exit(1);
  }
  try {
    const { output, timelinePath } = await replayEvents({ inputPath: file, outPath, strict });
    process.stdout.write(output + (output.endsWith('\n') ? '' : '\n'));
    console.error(`timeline written to ${timelinePath}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

const invokedDirectly = path.resolve(process.argv[1] || '') === __filename;
if (invokedDirectly) {
  main();
}
