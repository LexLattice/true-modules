#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { spawn } from 'child_process';
import { collectCrossImportDiagnostics } from './scripts/eslint-run.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();
program.name('tm').description('True Modules CLI (scaffold)').version('0.1.0');

const specDir = path.join(__dirname, 'spec');

async function loadJSON(p) {
  const txt = await fs.readFile(p, 'utf8');
  try { return JSON.parse(txt); } catch (e) {
    throw new Error(`Failed to parse JSON at ${p}: ${e.message}`);
  }
}

function makeAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

async function validateAgainst(schemaName, data) {
  const ajv = makeAjv();
  const schema = await loadJSON(path.join(specDir, schemaName));
  const validate = ajv.compile(schema);
  const valid = validate(data);
  if (!valid) {
    const errs = (validate.errors || []).map(e => `${e.instancePath} ${e.message}`).join('\n');
    throw new Error(`Validation failed for ${schemaName}:\n${errs}`);
  }
}

async function validateFile(schemaName, filePath) {
  const data = await loadJSON(filePath);
  await validateAgainst(schemaName, data);
  return data;
}

async function runCmd(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`Timeout ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(err || `Exit ${code}`));
    });
  });
}

function verifyPortRequires(compose, manifestsById) {
  const provided = new Set();
  for (const man of Object.values(manifestsById)) {
    for (const p of (man.provides || [])) provided.add(p.split('@')[0]);
  }
  const problems = [];
  for (const [id, man] of Object.entries(manifestsById)) {
    for (const req of (man.requires || [])) {
      const name = req.split('@')[0];
      if (!provided.has(name)) {
        problems.push(`${id} requires ${req} but no selected module provides ${name}`);
      }
    }
  }
  return problems;
}

function makeEventEmitter(opts) {
  const emit = (type, payload = {}) => {
    if (opts.emitEvents) {
      const evt = { event: type, ts: new Date().toISOString(), ...payload };
      process.stdout.write(JSON.stringify(evt) + '\n');
    }
  };
  const info = (msg) => {
    (opts.emitEvents ? console.error : console.log)(msg);
  };
  return { emit, info };
}

function interfaceNameForPort(portId) {
  const [name, versionRaw] = (portId || '').split('@');
  const version = Number(versionRaw || '1');
  if (!version || version === 1) return name;
  return `${name}V${version}`;
}

async function resolvePortsDir(workspaceRoot) {
  const candidates = [
    path.resolve(workspaceRoot, '..', 'runtimes', 'ts', 'ports'),
    path.resolve(workspaceRoot, '..', '..', 'runtimes', 'ts', 'ports'),
    path.resolve(process.cwd(), 'runtimes', 'ts', 'ports')
  ];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      continue;
    }
  }
  return path.resolve(process.cwd(), 'runtimes', 'ts', 'ports');
}

async function buildPortHarness(manifests, workspaceRoot, portsDir, ee) {
  const entries = [];
  let harnessDir = null;

  async function ensureHarnessDir() {
    if (!harnessDir) {
      harnessDir = path.join(workspaceRoot, '.tm', 'port-checks');
      await fs.rm(harnessDir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(harnessDir, { recursive: true });
    }
  }

  for (const [moduleId, data] of Object.entries(manifests)) {
    const { manifest, root } = data;
    const provides = manifest.provides || [];
    const portExports = manifest.port_exports || {};
    for (const port of provides) {
      ee.emit('PORT_CHECK_START', { module: moduleId, port });
      let binding = portExports[port];
      if (!binding) {
        const fallback = 'src/index.ts';
        try {
          await fs.access(path.join(root, fallback));
          binding = { file: fallback, export: 'default' };
          ee.emit('GATES_WARN', { warn: 'port_exports_missing', module: moduleId, port });
        } catch {
          ee.emit('PORT_CHECK_FAIL', { module: moduleId, port, error: 'port_export_not_found' });
          throw new Error(`Port ${port} for ${moduleId} missing port_exports entry and fallback ${fallback} not found.`);
        }
      }

      const absFile = path.join(root, binding.file);
      try {
        await fs.access(absFile);
      } catch {
        ee.emit('PORT_CHECK_FAIL', { module: moduleId, port, error: 'port_export_not_found' });
        throw new Error(`Port ${port} for ${moduleId} references missing file ${binding.file}`);
      }

      await ensureHarnessDir();
      const safeModule = moduleId.replace(/[\\/]/g, '_');
      const safePort = port.replace(/[\\/]/g, '_');
      const harnessPath = path.join(harnessDir, `${safeModule}__${safePort}.ts`);

      const relativeImport = path.relative(harnessDir, absFile).replace(/\\/g, '/');
      const importSpecifier = relativeImport.startsWith('.') ? relativeImport : `./${relativeImport}`;
      const portsImportRelative = path.relative(harnessDir, path.join(portsDir, 'index.js')).replace(/\\/g, '/');
      const portsImport = portsImportRelative.startsWith('.') ? portsImportRelative : `./${portsImportRelative}`;
      const interfaceName = interfaceNameForPort(port);
      let importLines;
      let reference = 'portExport';
      if ((binding.export || '').toLowerCase() === 'default') {
        importLines = `import provider from '${importSpecifier}';\nconst ${reference} = provider;`;
      } else {
        importLines = `import { ${binding.export} as ${reference} } from '${importSpecifier}';`;
      }
      const harnessCode = `import type { ${interfaceName} } from '${portsImport}';\n${importLines}\nconst _check: ${interfaceName} = ${reference};\nexport {};\n`;
      await fs.writeFile(harnessPath, harnessCode);
      entries.push({ harnessPath, module: moduleId, port });
    }
  }

  return { harnessDir, entries };
}

// ---- helpers for gates ----
async function listFilesRec(dir, exts) {
  const out = [];
  async function walk(d) {
    const ents = await fs.readdir(d, { withFileTypes: true });
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (!exts || exts.some(ext => p.endsWith(ext))) out.push(p);
    }
  }
  await walk(dir);
  return out;
}

async function crossImportLint(modulesRoot) {
  const modules = await fs.readdir(modulesRoot, { withFileTypes: true });
  const problems = [];
  for (const ent of modules) {
    if (!ent.isDirectory()) continue;
    const modId = ent.name;
    const modRoot = path.join(modulesRoot, modId);
    const srcFiles = await listFilesRec(modRoot, ['.ts','.tsx','.js','.jsx']);
    for (const fp of srcFiles) {
      const text = await fs.readFile(fp, 'utf8');
      const lines = text.split(/\r?\n/);
      lines.forEach((line, idx) => {
        const m = line.match(/from\s+['"]([^'"]+)['"]/);
        const r = line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/);
        const imp = m ? m[1] : (r ? r[1] : null);
        if (!imp) return;
        if (imp.startsWith('..')) {
          problems.push({ file: fp, line: idx+1, msg: `relative import escapes module root: ${imp}` });
        }
        if (imp.includes('modules/')) {
          const parts = imp.split('modules/');
          if (parts[1]) {
            const other = parts[1].split(/[\\/]/)[0];
            if (other && other !== modId) {
              problems.push({ file: fp, line: idx+1, msg: `imports sibling module '${other}'` });
            }
          }
        }
      });
    }
  }
  return problems;
}

program
  .command('schema-compile')
  .description('Compile all JSON Schemas to ensure they are valid (AJV 2020-12)')
  .action(async () => {
    const files = ['module.schema.json','compose.schema.json','coverage.schema.json','report.schema.json'];
    for (const f of files) {
      const schema = await loadJSON(path.join(specDir, f));
      const ajv = makeAjv();
      ajv.compile(schema);
      console.log(`✓ Compiled ${f}`);
    }
  });

program
  .command('compose')
  .requiredOption('--compose <file>', 'Path to compose.json')
  .requiredOption('--modules-root <dir>', 'Root directory containing module folders (with module.json)')
  .option('--out <dir>', './winner', 'Output directory for winner artifacts')
  .description('Validate compose plan and manifests; emit a minimal winner report (scaffold)')
  .action(async (opts) => {
    const compose = await validateFile('compose.schema.json', path.resolve(opts.compose));
    const modulesRoot = path.resolve(opts.modules_root || opts.modulesRoot);

    // Load and validate module manifests
    const moduleEntries = {};
    for (const m of compose.modules || []) {
      const mdir = path.join(modulesRoot, m.id);
      const mfile = path.join(mdir, 'module.json');
      const manifest = await validateFile('module.schema.json', mfile);
      moduleEntries[m.id] = { dir: mdir, manifest };
    }

    const manifestsById = Object.fromEntries(
      Object.entries(moduleEntries).map(([k, v]) => [k, v.manifest])
    );
    const reqProblems = verifyPortRequires(compose, manifestsById);
    if (reqProblems.length) {
      throw new Error('Compose port requirements failed:\n' + reqProblems.join('\n'));
    }

    // Basic wiring checks
    const providesPort = (manifest, portName) => {
      const arr = manifest.provides || [];
      return arr.some(p => (p.split('@')[0] === portName));
    };

    for (const w of (compose.wiring || [])) {
      const [fromName, fromPort] = w.from.split(':');
      const [toName, toPort] = w.to.split(':');
      if (!fromName || !fromPort || !toName || !toPort) {
        throw new Error(`Invalid wiring entry: ${JSON.stringify(w)}`);
      }
      if (fromName !== 'orchestrator') {
        const ent = moduleEntries[fromName];
        if (!ent) throw new Error(`Wiring 'from' references unknown module: ${fromName}`);
        if (!providesPort(ent.manifest, fromPort)) {
          throw new Error(`Module ${fromName} does not provide port ${fromPort}`);
        }
      }
    }

    // Emit a minimal winner report
    const outDir = path.resolve(opts.out || './winner');
    await fs.mkdir(outDir, { recursive: true });
    const winnerReport = {
      context: {
        run_id: compose.run_id || new Date().toISOString(),
        composer: 'tm (scaffold)',
        generated_at: new Date().toISOString()
      },
      bill_of_materials: (compose.modules || []).map(m => ({
        id: m.id, version: m.version || '0.0.0'
      })),
      wiring: compose.wiring || [],
      glue: compose.glue || [],
      constraints: compose.constraints || [],
      notes: [
        "This is a scaffold winner report generated without building/linking.",
        "Use the full Composer to assemble code and run gates in shipping mode."
      ]
    };
    await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(winnerReport, null, 2));
    await fs.writeFile(path.join(outDir, 'README.md'), '# Winner (scaffold)\n\nGenerated by `tm compose`.');
    console.log(`✓ Wrote ${path.join(outDir, 'report.json')}`);
  });

program
  .command('meta')
  .requiredOption('--coverage <file>', 'Path to coverage.json')
  .option('--out <file>', './compose.greedy.json', 'Output compose file')
  .description('Greedy set-cover with simple risk/evidence scoring')
  .action(async (opts) => {
    const cov = await validateFile('coverage.schema.json', path.resolve(opts.coverage));
    const weights = cov.weights || {};
    const goals = new Set(cov.goals || []);

    // Build module->goal map and attach risk/evidence
    const meta = {};
    for (const p of (cov.provides || [])) {
      const mod = p.module; // e.g., "git.diff.core@var4"
      if (!meta[mod]) meta[mod] = { goals: new Set(), risk: 0.5, ev: 0.5 };
      for (const g of (p.covers || [])) meta[mod].goals.add(g);
      if (typeof p.risk === 'number') meta[mod].risk = p.risk;
      if (typeof p.evidence_strength === 'number') meta[mod].ev = p.evidence_strength;
    }

    const covered = new Set();
    const selected = [];

    function gainOf(mod) {
      const info = meta[mod];
      let gsum = 0;
      for (const g of (info.goals || [])) {
        if (!covered.has(g)) gsum += (typeof weights[g] === 'number' ? weights[g] : 1);
      }
      const riskPenalty = info.risk;           // 0..1
      const evidenceBonus = info.ev * 0.5;     // 0..0.5
      return gsum + evidenceBonus - riskPenalty;
    }

    while (true) {
      let best = null, bestGain = 0;
      for (const mod of Object.keys(meta)) {
        const g = gainOf(mod);
        if (g > bestGain) { bestGain = g; best = mod; }
      }
      if (!best || bestGain <= 0) break;
      selected.push(best);
      for (const g of meta[best].goals) covered.add(g);
      delete meta[best];
      if ([...goals].every(g => covered.has(g))) break;
    }

    const modulesList = selected.map(id => ({ id: id.split('@')[0], version: "0.1.0" }));

    const compose = {
      run_id: new Date().toISOString(),
      modules: modulesList,
      wiring: [],
      glue: [],
      constraints: ["no-cross-imports", "ports-only-coupling"]
    };
    await fs.writeFile(path.resolve(opts.out || './compose.greedy.json'), JSON.stringify(compose, null, 2));
    console.log(`✓ Wrote ${opts.out || './compose.greedy.json'} with ${modulesList.length} modules`);
  });

program
  .command('gates')
  .argument('<mode>', 'conceptual|shipping')
  .requiredOption('--compose <file>', 'Path to compose.json')
  .requiredOption('--modules-root <dir>', 'Root dir of modules')
  .option('--emit-events', 'Emit line-delimited JSON events', false)
  .option('--hook-cmd <cmd>', 'Run a hook that receives a summary JSON on stdin')
  .option('--timeout-ms <n>', 'Per-test timeout (ms)', '60000')
  .description('Run conceptual / shipping gates')
  .action(async (mode, opts) => {
    const compose = await validateFile('compose.schema.json', path.resolve(opts.compose));
    const modulesRoot = path.resolve(opts.modules_root || opts.modulesRoot);
    const manifests = {};
    const ee = makeEventEmitter(opts);
    const gateStart = Date.now();
    const moduleIds = (compose.modules || []).map(m => m.id);
    const summary = {
      run_id: compose.run_id || new Date().toISOString(),
      mode,
      modules: moduleIds,
      results: { passed: 0, failed: 0 }
    };
    ee.emit('GATES_START', { mode, compose: opts.compose, run_id: compose.run_id || null });
    let successMessage = '';

    try {
      // Shared checks
      for (const m of compose.modules || []) {
        const mroot = path.join(modulesRoot, m.id);
        const fp = path.join(mroot, 'module.json');
        const manifest = await validateFile('module.schema.json', fp);
        manifests[m.id] = { manifest, root: mroot };
        if (!Array.isArray(manifest.evidence) || manifest.evidence.length === 0) {
          throw new Error(`Gate failure: ${m.id} has no evidence bindings.`);
        }
        if (!Array.isArray(manifest.tests) || manifest.tests.length === 0) {
          throw new Error(`Gate failure: ${m.id} defines no tests.`);
        }
        if (!Array.isArray(manifest.invariants) || manifest.invariants.length === 0) {
          throw new Error(`Gate failure: ${m.id} defines no invariants.`);
        }
      }

      // Cross-import lint (ESLint preferred, regex fallback)
      let ranEslint = false;
      try {
        const { errorCount, diagnostics } = await collectCrossImportDiagnostics([modulesRoot]);
        ranEslint = true;
        if (errorCount > 0) {
          const formatted = diagnostics.slice(0, 20).map(d => {
            const rel = path.relative(process.cwd(), d.file);
            return `${rel}:${d.line}:${d.column} ${d.message}`;
          }).join('\n');
          const first = diagnostics[0];
          ee.emit('GATES_FAIL', {
            mode,
            error: 'lint_failed',
            file: first ? path.relative(process.cwd(), first.file) : undefined,
            line: first?.line,
            message: first?.message
          });
          throw new Error('ESLint cross-module check failed:\n' + formatted);
        }
      } catch (err) {
        if (!ranEslint && err && (err.code === 'ERR_MODULE_NOT_FOUND' || (typeof err.message === 'string' && err.message.includes("Cannot find module 'eslint'")))) {
          ee.emit('GATES_WARN', { warn: 'eslint_unavailable' });
          const lint = await crossImportLint(modulesRoot);
          if (lint.length) {
            const formatted = lint.slice(0, 20).map(entry => {
              const rel = path.relative(process.cwd(), entry.file);
              return `${rel}:${entry.line} ${entry.msg}`;
            }).join('\n');
            ee.emit('GATES_FAIL', {
              mode,
              error: 'lint_failed',
              file: path.relative(process.cwd(), lint[0].file),
              line: lint[0].line,
              message: lint[0].msg
            });
            throw new Error('Cross-module import violations:\n' + formatted);
          }
        } else if (!ranEslint) {
          throw err instanceof Error ? err : new Error(String(err));
        } else {
          throw err instanceof Error ? err : new Error(String(err));
        }
      }

      if (mode === 'conceptual') {
        successMessage = '✓ Conceptual gates passed.';
      } else {
        const timeoutMs = Number(opts.timeoutMs ?? 60_000);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          throw new Error('Gate failure: invalid --timeout-ms value.');
        }

        const reqProblems = verifyPortRequires(
          compose,
          Object.fromEntries(Object.entries(manifests).map(([k, v]) => [k, v.manifest]))
        );
        if (reqProblems.length) {
          throw new Error('Gate failure: port requirements unmet:\n' + reqProblems.join('\n'));
        }

        if (!(compose.wiring && compose.wiring.length) && !(compose.constraints && compose.constraints.length)) {
          throw new Error('Gate failure: shipping mode requires non-empty wiring or constraints.');
        }

        let total = 0;
        let passed = 0;
        for (const m of compose.modules || []) {
          const { manifest, root } = manifests[m.id];
          for (const t of manifest.tests || []) {
            if (typeof t !== 'string') {
              throw new Error(`Test entry for ${m.id} is not a string: ${JSON.stringify(t)}`);
            }
            total += 1;
            const testStart = Date.now();
            ee.emit('TEST_START', { module: m.id, test: t });
            try {
              if (t.startsWith('script:')) {
                const scriptRel = t.replace(/^script:/, '').trim();
                if (!scriptRel) throw new Error('Script entry missing path');
                const scriptAbs = path.join(root, scriptRel);
                await runCmd(process.execPath, [scriptAbs], { cwd: root, timeoutMs });
              } else if (t.endsWith('.json')) {
                const runner = path.join(root, 'tests', 'runner.mjs');
                await fs.access(runner);
                const specPath = path.join(root, t);
                await runCmd(
                  process.execPath,
                  [runner, '--spec', specPath, '--moduleRoot', root],
                  { cwd: root, timeoutMs }
                );
              } else {
                throw new Error(`Unknown test entry: ${t}`);
              }
              const dur = Date.now() - testStart;
              passed += 1;
              ee.emit('TEST_PASS', { module: m.id, test: t, dur_ms: dur });
            } catch (e) {
              const dur = Date.now() - testStart;
              const errMsg = e instanceof Error ? e.message : String(e);
              ee.emit('TEST_FAIL', { module: m.id, test: t, dur_ms: dur, error: errMsg });
              summary.results = { passed, failed: total - passed };
              throw new Error(`Test failed for ${m.id} (${t}): ${errMsg}`);
            }
          }
        }

        const workspaceRoot = path.resolve(modulesRoot, '..');
        const portsDir = await resolvePortsDir(workspaceRoot);
        const portHarness = await buildPortHarness(manifests, workspaceRoot, portsDir, ee);
        const dirsToCheck = [modulesRoot];
        const glueDir = path.join(workspaceRoot, 'glue');
        try {
          const glueStat = await fs.stat(glueDir);
          if (glueStat.isDirectory()) dirsToCheck.push(glueDir);
        } catch {}

        const includeDirs = [...dirsToCheck];
        if (portHarness.harnessDir) includeDirs.push(portHarness.harnessDir);
        includeDirs.push(portsDir);

        let tsFiles = [];
        for (const dir of dirsToCheck) {
          const files = await listFilesRec(dir, ['.ts', '.tsx']);
          tsFiles = tsFiles.concat(files);
        }

        const mustTypeCheck = tsFiles.length > 0 || (portHarness.entries && portHarness.entries.length > 0);

        if (mustTypeCheck) {
          const tmDir = path.join(workspaceRoot, '.tm');
          await fs.mkdir(tmDir, { recursive: true });
          const tscLogPath = path.join(tmDir, 'tsc.log');
          const tsProjectPath = path.join(tmDir, 'tsconfig.json');
          const includePaths = includeDirs.map(dir => {
            const rel = path.relative(tmDir, dir) || '.';
            return rel.replace(/\\/g, '/');
          });
          const tsConfig = {
            compilerOptions: {
              module: "NodeNext",
              moduleResolution: "NodeNext",
              target: "ES2022",
              strict: true,
              skipLibCheck: true,
              allowImportingTsExtensions: true
            },
            include: includePaths
          };
          await fs.writeFile(tsProjectPath, JSON.stringify(tsConfig, null, 2));

          const requireForTs = createRequire(import.meta.url);
          let tscBin;
          try {
            const tsPackagePath = requireForTs.resolve('typescript/package.json');
            const tsPackage = requireForTs(tsPackagePath);
            const binRelative = tsPackage && tsPackage.bin && tsPackage.bin.tsc ? tsPackage.bin.tsc : 'bin/tsc';
            tscBin = path.join(path.dirname(tsPackagePath), binRelative);
          } catch {
            tscBin = null;
          }
          if (!tscBin) {
            throw new Error('TypeScript compiler not found. Install with `npm i -D typescript`.');
          }
          try {
            await fs.access(tscBin);
          } catch {
            throw new Error('TypeScript compiler not found. Install with `npm i -D typescript`.');
          }

          ee.emit('TSC_START', { mode });
          const start = Date.now();
          const child = spawn(process.execPath, [tscBin, '--noEmit', '--project', tsProjectPath], {
            cwd: workspaceRoot,
            shell: false
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', d => { stdout += d; });
          child.stderr.on('data', d => { stderr += d; });
          const exitCode = await new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('exit', code => resolve(code));
          });
          const duration = Date.now() - start;
          const combined = `${stdout}${stderr}`;
          await fs.writeFile(tscLogPath, combined);
          if (exitCode !== 0) {
            const lines = combined.split(/\r?\n/).filter(Boolean).slice(0, 10);
            ee.emit('TSC_FAIL', { mode, dur_ms: duration });
            if (portHarness.entries?.length) {
              const firstLine = lines[0] || '';
              const match = portHarness.entries.find(entry => firstLine.includes(path.basename(entry.harnessPath)) || combined.includes(entry.harnessPath));
              if (match) {
                ee.emit('PORT_CHECK_FAIL', { module: match.module, port: match.port, error: 'port_conformance_failed' });
              }
            }
            throw new Error(`TypeScript check failed:\n${lines.join('\n')}\nSee full log at ${tscLogPath}`);
          } else {
            ee.emit('TSC_PASS', { mode, dur_ms: duration });
            if (portHarness.entries?.length) {
              for (const entry of portHarness.entries) {
                ee.emit('PORT_CHECK_PASS', { module: entry.module, port: entry.port });
              }
            }
          }
        }

        summary.results = { passed, failed: 0 };
        successMessage = `✓ Shipping tests passed (${passed}/${total}).`;
      }
      summary.duration_ms = Date.now() - gateStart;

      if (opts.hookCmd) {
        await new Promise((resolve, reject) => {
          const child = spawn(opts.hookCmd, {
            shell: true,
            stdio: ['pipe', 'inherit', 'inherit']
          });
          child.on('error', reject);
          child.on('exit', code => {
            if (code === 0) resolve();
            else reject(new Error(`Hook exited with code ${code}`));
          });
          child.stdin.write(JSON.stringify(summary));
          child.stdin.end();
        });
      }

      ee.emit('GATES_PASS', { mode, ...summary.results });
      if (successMessage) ee.info(successMessage);
    } catch (err) {
      summary.duration_ms = Date.now() - gateStart;
      const message = err instanceof Error ? err.message : String(err);
      summary.error = message;
      ee.emit('GATES_FAIL', { mode, error: message, ...summary.results });
      throw err instanceof Error ? err : new Error(message);
    }
  });

program
  .command('module')
  .requiredOption('--new <id>', 'Module id, e.g. git.diff.core')
  .option('--root <dir>', 'Modules root directory', 'modules')
  .description('Create a new module scaffold that passes schema validation')
  .action(async (opts) => {
    const id = opts.new;
    if (!/^[a-z][a-z0-9_.-]+$/.test(id)) {
      throw new Error('Invalid module id. Use lowercase letters, digits, dot/underscore/dash.');
    }
    const dir = path.resolve(opts.root, id);
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true });

    const manifest = {
      id,
      version: "0.1.0",
      summary: "New module",
      provides: ["ExamplePort@1"],
      requires: [],
      inputs: {},
      outputs: {},
      side_effects: [],
      invariants: ["deterministic(outputs | inputs)"],
      tests: ["tests/spec_example.json"],
      evidence: [
        { kind: "file", file: "src/lib.ts", lines: "1-1", note: "placeholder" }
      ]
    };
    await fs.writeFile(path.join(dir, 'module.json'), JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(dir, 'src', 'lib.ts'), '// TODO: implement');
    await fs.writeFile(path.join(dir, 'tests', 'spec_example.json'), JSON.stringify({ name: "example" }, null, 2));

    // Validate manifest
    await validateFile('module.schema.json', path.join(dir, 'module.json'));

    console.log('✓ Created module at ' + dir);
  });

program.parseAsync().catch(err => {
  console.error('tm error:', err.message);
  process.exit(1);
});
