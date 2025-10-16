#!/usr/bin/env node
// Minimal RCM coverage + SSD analyzer (no external deps)
import fs from "fs/promises";
import path from "path";

function arg(k, d) {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
}

const rcmPath   = arg("--rcm", "rcm/rcm.json");
const tracePath = arg("--trace", "amr/traceability.map.json");
const slatesDir = arg("--slates", "amr/slates");
const outPath   = arg("--out", "amr/ssd.json");
const failLow   = Number(arg("--fail-low", "0.75"));

const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

async function loadJSON(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); }
  catch (e) { die(`Failed to read JSON: ${p}\n${e.message}`); }
}

function nonEmpty(v) { return Array.isArray(v) ? v.length > 0 : !!v; }

function ratio(n, d) { return d <= 0 ? 0 : Math.max(0, Math.min(1, n / d)); }

async function computeRCMCoverage(rcm, trace) {
  const musts = (rcm.requirements || []).filter(r => r.must);
  const uncovered = [];
  for (const req of musts) {
    const row = trace[req.id];
    const ok = row && nonEmpty(row.modules) && nonEmpty(row.tests);
    if (!ok) uncovered.push(req.id);
  }
  return {
    must_total: musts.length,
    covered: musts.length - uncovered.length,
    uncovered
  };
}

async function readSlate(dir) {
  const readMaybe = async (f) => {
    try { return await fs.readFile(path.join(dir, f), "utf8"); } catch { return ""; }
  };
  const tryJson = async (f) => {
    try { return JSON.parse(await fs.readFile(path.join(dir, f), "utf8")); } catch { return {}; }
  };
  const arch = await tryJson("architecture.json");
  const schemas = await tryJson("schemas.json");
  const acceptance = await tryJson("acceptance.json");
  const notes = await readMaybe("notes.md");

  const modCount = Array.isArray(arch.modules) ? arch.modules.length : 0;
  const ifaceCount = (arch.modules || []).reduce((a, m) => a + (Array.isArray(m.interfaces) ? m.interfaces.length : 0), 0);
  const archScore = (modCount > 0 && ifaceCount > 0) ? 1 : 0;

  const schemaCount = typeof schemas === "object" ? Object.keys(schemas).length : 0;
  const dataScore = schemaCount > 0 ? 1 : 0;

  let ifaces = 0, ifacesWithErrors = 0;
  for (const m of (arch.modules || [])) {
    for (const it of (m.interfaces || [])) {
      ifaces++;
      if (Array.isArray(it.errors) && it.errors.length) ifacesWithErrors++;
    }
  }
  const errorScore = ifaces ? ratio(ifacesWithErrors, ifaces) : 0;

  let cliScore = 0;
  const hasCliModule = (arch.modules || []).some(m => /(^cli$|\bcli\b)/i.test(m.id || ""));
  const hasCliIface  = (arch.modules || []).some(m => (m.interfaces || []).some(it => /^CLI\./.test(it.name || "")));
  cliScore = (hasCliModule || hasCliIface) ? 1 : 0;

  const byLayer = {
    architecture: archScore,
    data_schemas: dataScore,
    error_model:  errorScore,
    cli_surface:  cliScore
  };
  const overall = (byLayer.architecture + byLayer.data_schemas + byLayer.error_model + byLayer.cli_surface) / 4;

  const gaps = Object.entries(byLayer).filter(([,v]) => v < failLow).map(([k]) => k);
  return { byLayer, overall, gaps, notes_len: notes.length, modules: modCount, interfaces: ifaceCount };
}

(async () => {
  const rcm = await loadJSON(rcmPath);
  let trace = {};
  try { trace = await loadJSON(tracePath); } catch {}
  const rcmCov = await computeRCMCoverage(rcm, trace);

  let perSlate = {};
  try {
    const dirs = await fs.readdir(slatesDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const name = d.name;
      const ssd = await readSlate(path.join(slatesDir, name));
      perSlate[name] = ssd;
    }
  } catch {}

  const layers = ["architecture","data_schemas","error_model","cli_surface"];
  const minByLayer = Object.fromEntries(layers.map(L => {
    const vals = Object.values(perSlate).map(s => s.byLayer[L]).filter(x => typeof x === "number");
    return [L, vals.length ? Math.min(...vals) : 0];
  }));
  const allOverall = Object.values(perSlate).map(s => s.overall);
  const summary = {
    overall_min: allOverall.length ? Math.min(...allOverall) : 0,
    min_by_layer: minByLayer
  };

  const out = { rcm_coverage: rcmCov, per_slate: perSlate, summary, threshold: failLow, generated_at: new Date().toISOString() };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(out, null, 2));
  console.log(`✓ wrote ${outPath}`);

  if (rcmCov.uncovered.length) {
    die(`E_RCM_UNCOVERED: ${rcmCov.uncovered.join(", ")}`);
  }
  const lowHits = [];
  for (const [v, s] of Object.entries(perSlate)) {
    for (const [L,val] of Object.entries(s.byLayer)) if (val < failLow) lowHits.push(`${v}:${L}=${val}`);
  }
  if (lowHits.length) die(`E_SSD_LOW: ${lowHits.join(" | ")}`);
})();