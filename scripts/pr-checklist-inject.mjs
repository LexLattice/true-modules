#!/usr/bin/env node
// Generate REQ-* checklist from rcm/rcm.json and write/append to PR template.
import fs from "fs/promises";
import path from "path";

const rcmPath = process.argv[2] || "rcm/rcm.json";
const prTmpl = process.argv[3] || ".github/pull_request_template.md";
const mode = process.argv[4] || "append"; // 'append' or 'overwrite'

const load = async p => JSON.parse(await fs.readFile(p, "utf8"));

(async () => {
  const rcm = await load(rcmPath);
  const lines = ["## Requirements checklist", ""];
  for (const r of (rcm.requirements||[])) {
    const box = r.must ? "[ ]" : "[-]";
    lines.push(`${box} ${r.id} — ${r.text}`);
  }
  const section = lines.join("\n") + "\n";

  await fs.mkdir(path.dirname(prTmpl), { recursive: true });
  if (mode === "overwrite") {
    await fs.writeFile(prTmpl, section);
  } else {
    let prev = "";
    try { prev = await fs.readFile(prTmpl, "utf8"); } catch {}
    await fs.writeFile(prTmpl, prev + (prev && !prev.endsWith("\n") ? "\n" : "") + section);
  }
  console.log("✓ wrote PR checklist to", prTmpl);
})();