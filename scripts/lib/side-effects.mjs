import path from 'node:path';
import { tmError } from './provider-analysis.mjs';

const DEFAULT_SAMPLE_LIMIT = 5;

function isPathInside(base, target) {
  const relative = path.relative(base, target);
  if (!relative) return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeProcessEffect(event) {
  const command = String(event?.command || '').toLowerCase();
  if (!command) {
    return event?.shell ? 'Process:shell' : 'Process:unknown';
  }
  const base = path.basename(command);
  if (base === 'git' || base === 'git.exe') return 'Process:git';
  if (event?.shell) return 'Process:shell';
  if (base === 'sh' || base === 'bash' || base === 'zsh' || base === 'fish' || base === 'cmd.exe' || base === 'powershell.exe') {
    return 'Process:shell';
  }
  if (base === 'node' || base === 'node.exe') return 'Process:shell';
  return 'Process:shell';
}

function formatPathSample(moduleRoot, entry) {
  if (!entry || typeof entry.path !== 'string') return null;
  const inside = Boolean(entry.inside);
  const relative = inside ? (path.relative(moduleRoot, entry.path) || '.') : entry.path;
  return { path: relative, inside_module_root: inside };
}

function formatCommandSample(event) {
  if (!event || typeof event !== 'object') return null;
  const parts = [];
  if (typeof event.command === 'string' && event.command.trim()) {
    parts.push(event.command.trim());
  }
  if (Array.isArray(event.argv) && event.argv.length) {
    for (const arg of event.argv) {
      if (typeof arg === 'string' && arg.trim()) {
        parts.push(arg.trim());
      } else if (arg !== undefined && arg !== null) {
        parts.push(String(arg));
      }
    }
  }
  if (!parts.length && event.shell && typeof event.command === 'string') {
    parts.push(event.command.trim());
  }
  const sample = parts.join(' ').trim();
  return sample || null;
}

function hasDeclaration(operation, declaredSet) {
  if (declaredSet.has(operation)) return true;
  if (operation === 'Process:git') {
    return declaredSet.has('Process:shell');
  }
  return false;
}

export function evaluateSideEffects({ events = [], moduleId, manifest, moduleRoot, sampleLimit = DEFAULT_SAMPLE_LIMIT }) {
  if (!moduleId) {
    throw tmError('E_SIDEEFFECTS_INTERNAL', 'Side-effects evaluation requires a module id');
  }
  const declaredSet = new Set(Array.isArray(manifest?.side_effects) ? manifest.side_effects : []);
  const writes = [];
  const processes = [];

  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'fs_write') {
      if (typeof event.path === 'string') {
        const resolved = path.resolve(event.path);
        const inside = isPathInside(moduleRoot, resolved);
        writes.push({ ...event, path: resolved, inside });
      }
    } else if (event.type === 'process_spawn') {
      const effect = normalizeProcessEffect(event);
      processes.push({ ...event, effect });
    }
  }

  const observedOperations = new Set();
  if (writes.length) observedOperations.add('FS:write');
  for (const proc of processes) {
    if (proc.effect === 'Process:git') {
      observedOperations.add('Process:git');
    } else if (proc.effect === 'Process:shell') {
      observedOperations.add('Process:shell');
    }
  }

  const undeclaredOperations = new Set();
  for (const op of observedOperations) {
    if (!hasDeclaration(op, declaredSet)) {
      undeclaredOperations.add(op);
    }
  }

  const outsideWrites = writes.filter(entry => entry.inside === false);

  const summary = {
    declared: Array.from(declaredSet).sort(),
    observed_operations: Array.from(observedOperations).sort(),
    undeclared_operations: Array.from(undeclaredOperations).sort(),
    fs_write: {
      count: writes.length,
      outside_module_root: outsideWrites.length > 0,
      sample_paths: [],
      outside_samples: []
    },
    processes: {
      total: processes.length,
      categories: {}
    }
  };

  for (const entry of writes.slice(0, sampleLimit)) {
    const sample = formatPathSample(moduleRoot, entry);
    if (sample) summary.fs_write.sample_paths.push(sample);
  }
  for (const entry of outsideWrites.slice(0, sampleLimit)) {
    summary.fs_write.outside_samples.push(entry.path);
  }

  const categoryMap = new Map();
  for (const proc of processes) {
    const key = proc.effect;
    if (!categoryMap.has(key)) {
      categoryMap.set(key, { count: 0, sample_commands: [] });
    }
    const cat = categoryMap.get(key);
    cat.count += 1;
    if (cat.sample_commands.length < sampleLimit) {
      const sample = formatCommandSample(proc);
      if (sample && !cat.sample_commands.includes(sample)) {
        cat.sample_commands.push(sample);
      }
    }
  }
  for (const [effect, info] of categoryMap.entries()) {
    summary.processes.categories[effect] = {
      count: info.count,
      sample_commands: info.sample_commands
    };
  }

  let violation = null;
  if (outsideWrites.length > 0) {
    const outside = outsideWrites[0];
    const err = tmError('E_SIDEEFFECTS_FORBIDDEN', `Module ${moduleId} wrote to ${outside.path} outside its root.`);
    err.detail = { module: moduleId, operation: outside.op || 'fs_write', path: outside.path, side_effects: summary };
    violation = err;
  } else if (writes.length > 0 && !declaredSet.has('FS:write')) {
    const sample = writes[0];
    const rel = path.relative(moduleRoot, sample.path) || sample.path;
    const err = tmError('E_SIDEEFFECTS_DECLARATION', `Module ${moduleId} performed filesystem writes (${rel}) without declaring FS:write.`);
    err.detail = { module: moduleId, operation: 'FS:write', path: rel, side_effects: summary };
    violation = err;
  } else {
    for (const proc of processes) {
      if (proc.effect === 'Process:git') {
        if (!(declaredSet.has('Process:git') || declaredSet.has('Process:shell'))) {
          const err = tmError('E_SIDEEFFECTS_DECLARATION', `Module ${moduleId} spawned git without declaring Process:git.`);
          err.detail = { module: moduleId, operation: 'Process:git', command: proc.command, side_effects: summary };
          violation = err;
          break;
        }
      } else if (proc.effect === 'Process:shell') {
        if (!declaredSet.has('Process:shell')) {
          const err = tmError('E_SIDEEFFECTS_DECLARATION', `Module ${moduleId} spawned ${proc.command || 'a subprocess'} without declaring Process:shell.`);
          err.detail = { module: moduleId, operation: 'Process:shell', command: proc.command, side_effects: summary };
          violation = err;
          break;
        }
      }
    }
  }

  return { summary, violation };
}
