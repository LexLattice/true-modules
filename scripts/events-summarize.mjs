#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { readEvents } from './events-validate.mjs';
import { tmError } from './lib/provider-analysis.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_ARTIFACTS_DIR = path.resolve(process.cwd(), 'artifacts');
const DEFAULT_JSON = path.join(DEFAULT_ARTIFACTS_DIR, 'summary.json');
const DEFAULT_MARKDOWN = path.join(DEFAULT_ARTIFACTS_DIR, 'summary.md');

function parseTimestamp(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function roundDuration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US');
}

function renderTable(headers, rows) {
  const stringRows = rows.map((row) => row.map((cell) => (cell == null ? '' : String(cell))));
  const allRows = [headers.map((cell) => String(cell)), ...stringRows];
  const widths = headers.map((_, column) => {
    return allRows.reduce((max, row) => Math.max(max, row[column]?.length ?? 0), 0);
  });

  const makeDivider = (left, fill, mid, right) => {
    const segments = widths.map((width) => fill.repeat(width + 2));
    return `${left}${segments.join(mid)}${right}`;
  };

  const dividerTop = makeDivider('+', '-', '+', '+');
  const dividerMid = makeDivider('+', '-', '+', '+');
  const dividerBottom = dividerTop;

  const renderRow = (row) => {
    return `|${row
      .map((cell, idx) => {
        const width = widths[idx];
        const padded = (cell ?? '').padEnd(width, ' ');
        return ` ${padded} `;
      })
      .join('|')}|`;
  };

  const lines = [dividerTop, renderRow(allRows[0]), dividerMid];
  for (let i = 1; i < allRows.length; i += 1) {
    lines.push(renderRow(allRows[i]));
  }
  lines.push(dividerBottom);
  return lines.join('\n');
}

function buildMarkdown({ gateDurations, failCodes, slowTests, modules }) {
  const sections = [];

  sections.push('# Gate Summary');

  const gateRows = [
    ['Total', formatNumber(gateDurations.total_ms)],
    ['Lint', formatNumber(gateDurations.lint_ms)],
    ['Tests', formatNumber(gateDurations.test_ms)],
    ['TypeScript', formatNumber(gateDurations.tsc_ms)],
    ['Port checks', formatNumber(gateDurations.port_check_ms)],
    ['Other', formatNumber(gateDurations.other_ms)]
  ];
  sections.push('## Gate durations');
  sections.push('');
  sections.push(renderTable(['Stage', 'Duration (ms)'], gateRows));
  sections.push('');

  sections.push('## Failure codes');
  sections.push('');
  if (failCodes.length === 0) {
    sections.push('No failures recorded.');
  } else {
    const codeRows = failCodes.map((entry) => [entry.code, formatNumber(entry.count)]);
    sections.push(renderTable(['Code', 'Occurrences'], codeRows));
  }
  sections.push('');

  sections.push('## Slowest tests');
  sections.push('');
  if (slowTests.length === 0) {
    sections.push('No tests recorded.');
  } else {
    const testRows = slowTests.map((entry) => [entry.module, entry.test, formatNumber(entry.dur_ms), entry.status]);
    sections.push(renderTable(['Module', 'Test', 'Duration (ms)', 'Status'], testRows));
  }
  sections.push('');

  sections.push('## Module results');
  sections.push('');
  if (modules.length === 0) {
    sections.push('No module-scoped events recorded.');
  } else {
    const moduleRows = modules.map((entry) => [entry.module, formatNumber(entry.passed), formatNumber(entry.failed)]);
    sections.push(renderTable(['Module', 'Passed', 'Failed'], moduleRows));
  }
  sections.push('');

  return sections.join('\n');
}

function emptySummary() {
  return {
    run: { compose_sha256: null, run_id: null, total_events: 0 },
    gate_durations: {
      total_ms: null,
      lint_ms: 0,
      test_ms: 0,
      tsc_ms: 0,
      port_check_ms: 0,
      other_ms: 0
    },
    fail_codes: [],
    slow_tests: [],
    modules: []
  };
}

export async function summarizeEvents({ inputPath, jsonOut = DEFAULT_JSON, markdownOut = DEFAULT_MARKDOWN, topTests = 5 } = {}) {
  if (!inputPath) {
    throw new Error('summarizeEvents requires an inputPath');
  }
  const absoluteIn = path.resolve(inputPath);
  let parsed;
  try {
    parsed = await readEvents(absoluteIn, { strict: false });
  } catch (err) {
    if (err?.code === 'E_EVENT_SCHEMA') throw err;
    const failure = tmError('E_SUMMARY_PARSE', `Failed to read ${path.relative(process.cwd(), absoluteIn) || absoluteIn}`);
    failure.cause = err;
    throw failure;
  }

  const { events, composeSha, runId } = parsed;
  if (!Array.isArray(events) || events.length === 0) {
    const summary = emptySummary();
    summary.run.compose_sha256 = composeSha || null;
    summary.run.run_id = runId || null;
    await fs.mkdir(path.dirname(jsonOut), { recursive: true });
    await fs.writeFile(jsonOut, JSON.stringify(summary, null, 2) + '\n');
    await fs.mkdir(path.dirname(markdownOut), { recursive: true });
    const markdown = buildMarkdown({ gateDurations: summary.gate_durations, failCodes: [], slowTests: [], modules: [] });
    await fs.writeFile(markdownOut, markdown + '\n');
    return { summary, markdown };
  }

  const stageDurationKeys = {
    LINT: 'lint_ms',
    TEST: 'test_ms',
    TSC: 'tsc_ms',
    PORT_CHECK: 'port_check_ms'
  };
  const stageDurations = {
    lint_ms: 0,
    test_ms: 0,
    tsc_ms: 0,
    port_check_ms: 0,
    other_ms: 0
  };
  let totalDuration = null;
  const failCounts = new Map();
  const moduleStats = new Map();
  const testRuns = [];
  const testStarts = new Map();

  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue;
    const name = evt.event || '';
    const detail = evt.detail || {};

    if (name === 'GATES_PASS' || name === 'GATES_FAIL') {
      const dur = roundDuration(detail.dur_ms);
      if (dur != null) totalDuration = dur;
    }

    const stageMatch = /^(LINT|TEST|PORT_CHECK|TSC)_(START|PASS|FAIL)$/.exec(name);
    if (stageMatch) {
      const stage = stageMatch[1];
      const phase = stageMatch[2];
      const key = `${detail.module || ''}::${detail.test || ''}`;

      if (stage === 'TEST' && phase === 'START') {
        const tsValue = parseTimestamp(evt.ts);
        if (tsValue != null) testStarts.set(key, tsValue);
      }

      if (phase === 'PASS' || phase === 'FAIL') {
        let dur = roundDuration(detail.dur_ms);
        if (dur == null && stage === 'TEST') {
          const started = testStarts.get(key);
          const ended = parseTimestamp(evt.ts);
          if (started != null && ended != null && ended >= started) {
            dur = roundDuration(ended - started);
          }
        }
        const moduleId = detail.module || 'unknown';
        if (stage === 'TEST') {
          const testId = detail.test || 'unknown';
          const status = phase === 'PASS' ? 'pass' : 'fail';
          if (dur != null) {
            testRuns.push({ module: moduleId, test: testId, dur_ms: dur, status });
          } else {
            testRuns.push({ module: moduleId, test: testId, dur_ms: null, status });
          }
          testStarts.delete(key);
        }

        if (stage === 'TEST' || stage === 'PORT_CHECK') {
          const stats = moduleStats.get(moduleId) || { module: moduleId, passed: 0, failed: 0 };
          if (phase === 'PASS') {
            stats.passed += 1;
          } else {
            stats.failed += 1;
          }
          moduleStats.set(moduleId, stats);
        }

        if (dur != null) {
          const key = stageDurationKeys[stage];
          if (key) {
            stageDurations[key] += dur;
          }
        }

        if (phase === 'FAIL') {
          const code = detail.code || 'UNKNOWN';
          failCounts.set(code, (failCounts.get(code) || 0) + 1);
        }
      }
      continue;
    }

    if (/FAIL$/.test(name) && detail && detail.code) {
      failCounts.set(detail.code, (failCounts.get(detail.code) || 0) + 1);
    }
  }

  const summary = {
    run: {
      compose_sha256: composeSha || null,
      run_id: runId || null,
      total_events: events.length
    },
    gate_durations: {
      total_ms: totalDuration,
      lint_ms: stageDurations.lint_ms,
      test_ms: stageDurations.test_ms,
      tsc_ms: stageDurations.tsc_ms,
      port_check_ms: stageDurations.port_check_ms,
      other_ms: stageDurations.other_ms
    },
    fail_codes: Array.from(failCounts.entries())
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => (b.count - a.count) || a.code.localeCompare(b.code)),
    slow_tests: testRuns
      .filter((entry) => entry.dur_ms != null)
      .sort((a, b) => {
        if (a.dur_ms == null && b.dur_ms == null) return 0;
        if (a.dur_ms == null) return 1;
        if (b.dur_ms == null) return -1;
        return b.dur_ms - a.dur_ms;
      })
      .slice(0, Math.max(0, topTests)),
    modules: Array.from(moduleStats.values()).sort((a, b) => a.module.localeCompare(b.module))
  };

  await fs.mkdir(path.dirname(jsonOut), { recursive: true });
  await fs.writeFile(jsonOut, JSON.stringify(summary, null, 2) + '\n');

  const markdown = buildMarkdown({
    gateDurations: summary.gate_durations,
    failCodes: summary.fail_codes,
    slowTests: summary.slow_tests,
    modules: summary.modules
  });
  await fs.mkdir(path.dirname(markdownOut), { recursive: true });
  await fs.writeFile(markdownOut, markdown + '\n');

  return { summary, markdown, jsonPath: jsonOut, markdownPath: markdownOut };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    console.log('Usage: node scripts/events-summarize.mjs --in <events.ndjson> [--json <file>] [--md <file>] [--top <n>]');
    process.exit(args.length ? 0 : 1);
  }

  let input = null;
  let jsonOut = DEFAULT_JSON;
  let markdownOut = DEFAULT_MARKDOWN;
  let topTests = 5;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--in') {
      if (!args[i + 1]) {
        console.error('--in expects a file path');
        process.exit(1);
      }
      input = args[i + 1];
      i += 1;
    } else if (arg === '--json') {
      if (!args[i + 1]) {
        console.error('--json expects a file path');
        process.exit(1);
      }
      jsonOut = path.resolve(args[i + 1]);
      i += 1;
    } else if (arg === '--md') {
      if (!args[i + 1]) {
        console.error('--md expects a file path');
        process.exit(1);
      }
      markdownOut = path.resolve(args[i + 1]);
      i += 1;
    } else if (arg === '--top') {
      if (!args[i + 1]) {
        console.error('--top expects a numeric value');
        process.exit(1);
      }
      const value = Number(args[i + 1]);
      if (!Number.isFinite(value) || value < 0) {
        console.error('--top expects a non-negative number');
        process.exit(1);
      }
      topTests = Math.floor(value);
      i += 1;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  if (!input) {
    console.error('events-summarize: missing required --in <file> argument');
    process.exit(1);
  }

  try {
    const result = await summarizeEvents({ inputPath: input, jsonOut, markdownOut, topTests });
    process.stdout.write(result.markdown + (result.markdown.endsWith('\n') ? '' : '\n'));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

const invokedDirectly = path.resolve(process.argv[1] || '') === __filename;
if (invokedDirectly) {
  main();
}
