#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = new Map(
  process.argv.slice(2).reduce((acc, value, idx, arr) => {
    if (!value.startsWith('--')) return acc;
    return acc.concat([[value.slice(2), arr[idx + 1]]]);
  }, [])
);

const composePath = path.resolve(args.get('compose') || './compose.json');
const modulesRoot = path.resolve(args.get('modules-root') || './modules');
const glueRoot = path.resolve(args.get('glue-root') || './glue-catalog');
const outDir = path.resolve(args.get('out') || './winner');

async function readJSON(p) {
  const txt = await fs.readFile(p, 'utf8');
  return JSON.parse(txt);
}

function manifestPath(root, id) {
  return path.join(root, id, 'module.json');
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  if (fs.cp) {
    await fs.cp(src, dst, { recursive: true });
  } else {
    const { execSync } = await import('child_process');
    execSync(`cp -R "${src}/." "${dst}"`);
  }
}

function normalizePortName(entry) {
  return (entry || '').split('@')[0];
}

function tmError(code, message) {
  const err = new Error(`${code} ${message}`);
  err.code = code;
  return err;
}

function parsePortId(portId) {
  const [name, rawVersion] = String(portId || '').split('@');
  const versionPart = rawVersion && rawVersion.length ? rawVersion : '1';
  const major = versionPart.split('.')[0] || '1';
  return { name, major };
}

function portMajorId(portId) {
  const parsed = parsePortId(portId);
  if (!parsed.name) {
    throw tmError('E_COMPOSE', `Invalid port identifier: ${portId}`);
  }
  return `${parsed.name}@${parsed.major}`;
}

function extractPreferredProviders(constraints) {
  const preferred = new Map();
  for (const constraint of constraints || []) {
    if (!constraint) continue;
    if (typeof constraint === 'string') {
      const match = /^prefer:([A-Za-z][A-Za-z0-9]*Port@\d+)=([a-z][a-z0-9_.-]+)$/.exec(constraint.trim());
      if (match) {
        const [, port, module] = match;
        const prev = preferred.get(port);
        if (prev && prev !== module) {
          throw tmError('E_PREFER_UNSAT', `Conflicting preferred providers for ${port}: ${prev} vs ${module}`);
        }
        preferred.set(port, module);
      }
      continue;
    }
    if (typeof constraint === 'object' && !Array.isArray(constraint) && constraint.preferred_providers) {
      for (const [port, module] of Object.entries(constraint.preferred_providers)) {
        if (typeof module !== 'string') continue;
        if (!/^[A-Za-z][A-Za-z0-9]*Port@\d+$/.test(port)) continue;
        if (!/^[a-z][a-z0-9_.-]+$/.test(module)) continue;
        const prev = preferred.get(port);
        if (prev && prev !== module) {
          throw tmError('E_PREFER_UNSAT', `Conflicting preferred providers for ${port}: ${prev} vs ${module}`);
        }
        preferred.set(port, module);
      }
    }
  }
  return preferred;
}

function analyzeProviders(compose, manifests) {
  const infoMap = new Map();
  const modulePortIndex = new Map();

  for (const [moduleId, manifest] of Object.entries(manifests)) {
    const portMap = new Map();
    for (const portId of manifest.provides || []) {
      const major = portMajorId(portId);
      const name = normalizePortName(portId);
      if (!infoMap.has(major)) {
        infoMap.set(major, { port: major, providers: new Set(), chosen: null, reason: null });
      }
      infoMap.get(major).providers.add(moduleId);
      if (!portMap.has(name)) portMap.set(name, []);
      portMap.get(name).push(major);
    }
    modulePortIndex.set(moduleId, portMap);
  }

  const preferred = extractPreferredProviders(compose.constraints || []);
  const moduleIds = new Set(Object.keys(manifests));

  for (const [port, moduleId] of preferred.entries()) {
    const info = infoMap.get(port);
    if (!info) {
      throw tmError('E_PREFER_UNSAT', `Preferred provider for ${port} not present in compose plan.`);
    }
    if (!moduleIds.has(moduleId) || !info.providers.has(moduleId)) {
      throw tmError('E_PREFER_UNSAT', `Preferred provider ${moduleId} does not supply ${port}.`);
    }
  }

  for (const wiring of compose.wiring || []) {
    if (!wiring) continue;
    const [fromModule, fromPort] = String(wiring.from || '').split(':');
    const [toModule, toPort] = String(wiring.to || '').split(':');
    if (!fromModule || !fromPort || !toModule || !toPort) continue;
    let moduleId = null;
    let portName = null;
    if (fromModule !== 'orchestrator' && toModule === 'orchestrator') {
      moduleId = fromModule;
      portName = fromPort;
    } else if (toModule !== 'orchestrator' && fromModule === 'orchestrator') {
      moduleId = toModule;
      portName = toPort;
    } else {
      continue;
    }
    if (!manifests[moduleId]) continue;
    const candidates = (modulePortIndex.get(moduleId)?.get(portName)) || [];
    if (candidates.length === 0) {
      throw tmError('E_COMPOSE', `Module ${moduleId} does not provide port ${portName}`);
    }
    if (candidates.length > 1) {
      throw tmError('E_COMPOSE', `Module ${moduleId} provides multiple majors for port ${portName}; add constraints to disambiguate.`);
    }
    const port = candidates[0];
    const info = infoMap.get(port);
    if (!info) continue;
    if (info.chosen && info.chosen !== moduleId) {
      throw tmError('E_DUP_PROVIDER', `Conflicting wiring for ${port}: ${info.chosen} vs ${moduleId}`);
    }
    info.chosen = moduleId;
    info.reason = 'wired';
  }

  for (const [port, moduleId] of preferred.entries()) {
    const info = infoMap.get(port);
    if (!info) continue;
    if (info.reason === 'wired') {
      if (info.chosen !== moduleId) {
        console.warn(`Preference for ${port}=${moduleId} ignored because wiring selected ${info.chosen}.`);
      }
      continue;
    }
    info.chosen = moduleId;
    info.reason = 'preferred';
  }

  const unresolved = [];
  for (const info of infoMap.values()) {
    info.providers = Array.from(info.providers).sort();
    if (!info.chosen) {
      if (info.providers.length === 1) {
        info.chosen = info.providers[0];
        info.reason = 'sole';
      } else if (info.providers.length > 1) {
        unresolved.push(info);
      }
    }
  }

  if (unresolved.length) {
    const target = unresolved.sort((a, b) => a.port.localeCompare(b.port))[0];
    const msg = `Duplicate providers for ${target.port}: ${target.providers.join(', ')}.\nAdd wiring from orchestrator or constraint prefer:${target.port}=${target.providers[0]}.`;
    throw tmError('E_DUP_PROVIDER', msg);
  }

  for (const info of infoMap.values()) {
    if (info.reason === 'preferred' && info.providers.length > 1) {
      const leftovers = info.providers.filter(p => p !== info.chosen);
      if (leftovers.length) {
        console.warn(`Preferred provider for ${info.port} selected ${info.chosen}; remaining providers: ${leftovers.join(', ')}`);
      }
    }
  }
}

(async () => {
  const compose = await readJSON(composePath);
  await fs.mkdir(outDir, { recursive: true });

  // Load manifests
  const manifById = {};
  for (const mod of compose.modules || []) {
    const mp = manifestPath(modulesRoot, mod.id);
    manifById[mod.id] = await readJSON(mp);
  }

  analyzeProviders(compose, manifById);

  const providers = {};
  for (const [id, man] of Object.entries(manifById)) {
    for (const p of (man.provides || [])) {
      const name = normalizePortName(p);
      if (!providers[name]) providers[name] = [];
      providers[name].push(id);
    }
  }

  // Requires check
  const providedPorts = new Set(Object.keys(providers));
  const reqProblems = [];
  for (const [id, man] of Object.entries(manifById)) {
    for (const req of (man.requires || [])) {
      const name = normalizePortName(req);
      if (!providedPorts.has(name)) {
        reqProblems.push(`${id} requires ${req} but no selected module provides ${name}`);
      }
    }
  }
  if (reqProblems.length) {
    throw tmError('E_REQUIRE_UNSAT', 'Port requires unsatisfied:\n' + reqProblems.join('\n'));
  }

  const winnerModulesDir = path.join(outDir, 'modules');
  await fs.mkdir(winnerModulesDir, { recursive: true });
  for (const mod of compose.modules || []) {
    await copyDir(path.join(modulesRoot, mod.id), path.join(winnerModulesDir, mod.id));
  }

  const winnerGlueDir = path.join(outDir, 'glue');
  await fs.mkdir(winnerGlueDir, { recursive: true });
  for (const glue of compose.glue || []) {
    if (!glue || !glue.id) continue;
    await copyDir(path.join(glueRoot, glue.id), path.join(winnerGlueDir, glue.id));
  }

  const portsMap = Object.fromEntries(Object.entries(providers).map(([port, ids]) => [port, ids]));
  await fs.writeFile(path.join(outDir, 'ports.map.json'), JSON.stringify(portsMap, null, 2));

  const report = {
    context: {
      run_id: compose.run_id || new Date().toISOString(),
      composer: 'ts-composer@0.1',
      generated_at: new Date().toISOString()
    },
    bill_of_materials: (compose.modules || []).map(m => ({
      id: m.id,
      version: m.version || '0.0.0'
    })),
    wiring: compose.wiring || [],
    glue: compose.glue || [],
    constraints: compose.constraints || [],
    notes: [
      'MVP composer copied selected modules/glue; link/build remains app responsibility.'
    ]
  };
  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(outDir, 'README.md'), '# Winner workspace (MVP)\n');

  const pkg = {
    name: 'true-modules-winner',
    private: true,
    version: '0.1.0',
    type: 'module',
    description: 'Materialized workspace generated by True Modules composer (MVP)'
  };
  await fs.writeFile(path.join(outDir, 'package.json'), JSON.stringify(pkg, null, 2));

  const tsconfig = {
    compilerOptions: {
      target: 'ES2020',
      module: 'ES2020',
      moduleResolution: 'node',
      esModuleInterop: true,
      resolveJsonModule: true,
      allowSyntheticDefaultImports: true,
      strict: false
    },
    include: ['modules/**/*', 'glue/**/*']
  };
  await fs.writeFile(path.join(outDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

  console.log('✓ Composer wrote', outDir);
})().catch(err => {
  console.error('composer error:', err.message);
  process.exit(1);
});
