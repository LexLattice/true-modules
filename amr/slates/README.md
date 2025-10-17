Place Bo4-A architecture slates under `var1..var4/` with the standard bundle:

- `architecture.json` — modules, interfaces, invariants, edges
- `schemas.json` — JSON Schemas referenced by the interfaces
- `acceptance.json` — REQ → acceptance steps/oracles
- `notes.md` — assumptions, risks, open design choices

Each Bo4-A attempt runs independently and knows nothing about sibling variants, so expect every output bundle to use the same canonical filenames (`architecture.json`, `schemas.json`, etc.). After harvesting a variant, drop its files into a numbered directory (`var1/`, `var2/`, …) yourself before running the merge prompt.

For the UI workflow console AMR run, aim for 3–4 distinct slates that explore:

1. Visualization of the AMR → Bo4 pipeline (per-stage status, artifacts, dependencies).
2. Configuration surfaces for variant counts, prompt depth, reviewer bots, and follow-up policy.
3. Embedded Codex authoring (briefs, RCM updates, slate notes) with safe hand-offs to the repo.
4. Persistent run history and replay/export mechanisms.

Name the directories `var1/`, `var2/`, etc. The AMR merge prompt expects these exact locations.
