#!/usr/bin/env node
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataRoot = path.resolve(__dirname, '../../examples/cloud-stub');
const tasksPath = path.join(dataRoot, 'tasks.json');

async function loadTasks() {
  const raw = await fsp.readFile(tasksPath, 'utf8');
  const data = JSON.parse(raw);
  return data.tasks || {};
}

function pickTaskArg(params, tasks) {
  const optionsWithValue = new Set(['--variant', '--dir', '--out', '--profile', '--weights']);
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i];
    if (p.startsWith('--') && optionsWithValue.has(p)) {
      i += 1;
      continue;
    }
    if (!p.startsWith('-')) return p;
  }
  const fallback = process.env.CODEX_STUB_TASK;
  if (fallback) return fallback;
  const taskIds = Object.keys(tasks || {});
  return taskIds.length ? taskIds[0] : null;
}

function optionValue(params, flag) {
  const idx = params.indexOf(flag);
  if (idx === -1) return null;
  return params[idx + 1] ?? null;
}

async function handleList(tasks, params) {
  const out = Object.entries(tasks).map(([taskId, info]) => ({
    task_id: taskId,
    status: info.status || 'ready'
  }));
  if (params.includes('--json')) {
    process.stdout.write(JSON.stringify(out));
  } else {
    out.forEach(entry => {
      process.stdout.write(`${entry.task_id}\t${entry.status}\n`);
    });
  }
}

async function handleShow(tasks, params) {
  const taskId = pickTaskArg(params, tasks);
  const info = tasks[taskId] || null;
  if (!info) {
    throw new Error(`Task ${taskId} not found in stub data`);
  }
  const variants = (info.variants || []).map(v => ({
    variant_index: v.variant_index,
    status: v.status || info.status || 'ready'
  }));
  const payload = { task_id: taskId, variants };
  process.stdout.write(JSON.stringify(payload));
}

async function copyRecursive(src, dest) {
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });
  await fsp.cp(src, dest, { recursive: true });
}

async function handleExport(tasks, params) {
  const variantStr = optionValue(params, '--variant');
  const dir = optionValue(params, '--dir');
  const taskId = pickTaskArg(params, tasks);
  if (!variantStr || !dir) {
    throw new Error('codex stub export requires --variant <n> --dir <out>');
  }
  const variantIndex = Number(variantStr);
  const info = tasks[taskId];
  const variant = (info?.variants || []).find(v => Number(v.variant_index) === variantIndex);
  if (!variant) throw new Error(`Variant ${variantIndex} not found for ${taskId}`);
  const sourceDir = path.join(dataRoot, 'variants', String(variant.export || `var${variantIndex}`));
  await copyRecursive(sourceDir, path.resolve(dir));
}

async function handleDiff(tasks, params) {
  const variantStr = optionValue(params, '--variant');
  const taskId = pickTaskArg(params, tasks);
  if (!variantStr) throw new Error('codex stub diff requires --variant <n>');
  const variantIndex = Number(variantStr);
  const info = tasks[taskId];
  const variant = (info?.variants || []).find(v => Number(v.variant_index) === variantIndex);
  if (!variant) throw new Error(`Variant ${variantIndex} not found for ${taskId}`);
  const sourceDir = path.join(dataRoot, 'variants', String(variant.export || `var${variantIndex}`));
  const diffPath = path.join(sourceDir, 'diff.patch');
  const diff = await fsp.readFile(diffPath, 'utf8');
  process.stdout.write(diff);
}

async function handleApply(tasks, params) {
  const variantStr = optionValue(params, '--variant');
  const taskId = pickTaskArg(params, tasks);
  if (!variantStr) throw new Error('codex stub apply requires --variant <n>');
  process.stdout.write(`stub: applied task ${taskId} variant ${variantStr}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'cloud') {
    throw new Error('codex stub expects leading "cloud" command');
  }
  const command = args[1];
  const params = args.slice(2);
  const tasks = await loadTasks();
  switch (command) {
    case 'list':
      await handleList(tasks, params);
      break;
    case 'show':
      await handleShow(tasks, params);
      break;
    case 'export':
      await handleExport(tasks, params);
      break;
    case 'diff':
      await handleDiff(tasks, params);
      break;
    case 'apply':
      await handleApply(tasks, params);
      break;
    default:
      throw new Error(`Unsupported cloud command: ${command}`);
  }
}

main().catch(err => {
  console.error(err?.message || String(err));
  process.exit(1);
});
