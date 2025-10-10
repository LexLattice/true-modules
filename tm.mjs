#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { spawn } from 'child_process';

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

function createEventEmitter(enabled) {
  if (!enabled) return () => {};
  return (payload) => {
    try {
      process.stdout.write(JSON.stringify(payload) + '\n');
    } catch (err) {
      console.error('tm event emit error:', err.message);
    }
  };
}

async function runHookCommand(cmd, summary) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
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
  .option('--timeout-ms <ms>', 'Max milliseconds each module test may run (default: 60000)', '60000')
  .option('--emit-events', 'Emit line-delimited JSON events for gates')
  .option('--hook-cmd <cmd>', 'Shell command to receive summary JSON via stdin')
  .description('Run conceptual / shipping gates')
  .action(async (mode, opts) => {
    const compose = await validateFile('compose.schema.json', path.resolve(opts.compose));
    const modulesRoot = path.resolve(opts.modules_root || opts.modulesRoot);
    const manifests = {};
    const emit = createEventEmitter(Boolean(opts.emitEvents));
    const hookCmd = opts.hookCmd;
    const gateStart = Date.now();
    const stats = { passed: 0, failed: 0 };
    const moduleIds = (compose.modules || []).map(m => m.id);
    emit({
      event: 'GATES_START',
      mode,
      compose: opts.compose,
      run_id: compose.run_id || null
    });
    let successMessage = '';
    let failure = null;

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

      // Cross-import lint
      const lint = await crossImportLint(modulesRoot);
      if (lint.length) {
        const pretty = lint.map(p => `${p.file}:${p.line} — ${p.msg}`).join('\n');
        throw new Error('Gate failure: cross-module import violations:\n' + pretty);
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

        for (const m of compose.modules || []) {
          const { manifest, root } = manifests[m.id];
          for (const t of manifest.tests || []) {
            if (typeof t !== 'string') {
              throw new Error(`Test entry for ${m.id} is not a string: ${JSON.stringify(t)}`);
            }
            const testStart = Date.now();
            emit({ event: 'TEST_START', module: m.id, test: t });
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
              stats.passed += 1;
              emit({ event: 'TEST_PASS', module: m.id, test: t, dur_ms: dur });
            } catch (e) {
              const dur = Date.now() - testStart;
              stats.failed += 1;
              const errMsg = e instanceof Error ? e.message : String(e);
              emit({
                event: 'TEST_FAIL',
                module: m.id,
                test: t,
                dur_ms: dur,
                error: errMsg
              });
              throw new Error(`Test failed for ${m.id} (${t}): ${errMsg}`);
            }
          }
        }

        const total = stats.passed + stats.failed;
        successMessage = `✓ Shipping tests passed (${stats.passed}/${total}).`;
      }
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
    }

    const durationMs = Date.now() - gateStart;
    const summary = {
      run_id: compose.run_id || new Date().toISOString(),
      mode,
      modules: moduleIds,
      results: { passed: stats.passed, failed: stats.failed },
      duration_ms: durationMs
    };

    if (failure) {
      summary.error = failure.message;
      emit({
        event: 'GATES_FAIL',
        mode,
        error: failure.message,
        passed: stats.passed,
        failed: stats.failed
      });
    } else {
      emit({
        event: 'GATES_PASS',
        mode,
        passed: stats.passed,
        failed: stats.failed
      });
    }

    if (hookCmd) {
      try {
        await runHookCommand(hookCmd, summary);
      } catch (hookErr) {
        const hookError = hookErr instanceof Error ? hookErr : new Error(String(hookErr));
        if (!failure) {
          failure = hookError;
          emit({
            event: 'GATES_FAIL',
            mode,
            error: hookError.message,
            passed: stats.passed,
            failed: stats.failed
          });
        } else {
          failure = new Error(`${failure.message} (hook error: ${hookError.message})`);
        }
      }
    }

    if (!failure && successMessage) {
      console.log(successMessage);
    }

    if (failure) {
      throw failure;
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
