#!/usr/bin/env node
// tm amr verify (lightweight): validates canon shape and RCM coverage sanity without external deps.
import fs from "fs/promises";
import path from "path";

function arg(k, d) { const i = process.argv.indexOf(k); return i>-1 ? process.argv[i+1] : d; }
const canonArch = arg("--canon", "amr/architecture.json");
const canonAcc  = arg("--acceptance", "amr/acceptance.json");
const rcmPath   = arg("--rcm", "rcm/rcm.json");
const tracePath = arg("--trace", "amr/traceability.map.json");

const die = (m, c=1) => { console.error(m); process.exit(c); };
const load = async (p) => JSON.parse(await fs.readFile(p, "utf8"));

function nonEmpty(a) { return Array.isArray(a) && a.length>0; }

(async () => {
  const [arch, acc, rcm, trace] = await Promise.all([canonArch, canonAcc, rcmPath, tracePath].map(p => load(p).catch(e => die(`Missing or invalid JSON: ${p}\n${e.message}`))));

  // Basic arch checks
  if (!Array.isArray(arch.modules) || !Array.isArray(arch.edges)) die("E_CANON_SCHEMA: modules/edges missing");
  const ids = new Set(arch.modules.map(m => m.id));
  for (const m of arch.modules) {
    if (!m.id) die("E_CANON_SCHEMA: module missing id");
    for (const it of (m.interfaces||[])) {
      const need = ["name","input","output","errors","pre","post"];
      for (const k of need) if (!(k in it)) die(`E_CANON_SCHEMA: interface ${it.name||"<unnamed>"} missing ${k}`);
    }
  }
  for (const e of arch.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) die(`E_CANON_SCHEMA: edge references unknown module: ${e.from}->${e.to}`);
    // check contract name exists among interfaces
    const hasContract = arch.modules.some(m => (m.interfaces||[]).some(it => it.name === e.contract));
    if (!hasContract) die(`E_CANON_SCHEMA: edge contract not found among interfaces: ${e.contract}`);
  }

  // RCM must coverage via trace
  const musts = (rcm.requirements||[]).filter(r => r.must).map(r => r.id);
  const missing = [];
  for (const id of musts) {
    const row = trace[id];
    if (!row || !nonEmpty(row.modules) || !nonEmpty(row.tests)) missing.push(id);
  }
  if (missing.length) die("E_CANON_INCOMPLETE: " + missing.join(", "));

  console.log("✓ AMR verify passed.");
})();