# Contributor playbook

A checklist-driven loop for adding or evolving True Modules content. Pair this guide with the MCP façade ([docs/mcp.md](./mcp.md)) when you want automation to run the CLI on your behalf.

## Quick links

- [Specs & history](./meta-history.md), [ports conformance](./ports-conformance.md), [shipping tests](./tests.md)
- MCP smoke payloads plus troubleshooting: [docs/mcp.md](./mcp.md)
- Implementer prompt checklist: [../prompts/implementer/CHECKLIST.md](../prompts/implementer/CHECKLIST.md)

---

## Phase 1 — Plan

- [ ] Clarify the problem statement and success criteria. Capture references to related specs, RFCs, or incidents.
- [ ] Review existing coverage (`coverage.json`) to understand which goals already ship and what evidence exists.
- [ ] Inventory affected modules and their declared ports. Sketch the target wiring (providers, requires, glue).
- [ ] Decide which steps you will automate via MCP (`tm.meta`, `tm.compose`, `tm.gates`) versus running the CLI manually. Set `TM_MCP_MODULES_ROOT` to your workspace or note the path you will pass to each tool.
- [ ] Enumerate expected evidence artifacts (tests, manual notes, logs) and where they will live in the repo.

## Phase 2 — Implement

- [ ] Scaffold new modules with `node tm.mjs module --new <id>` or extend existing ones under `modules/`.
- [ ] Define ports, invariants, tests, and evidence in `module.json`. Cross-check [docs/ports-conformance.md](./ports-conformance.md) for naming, exports, and glue rules.
- [ ] Keep code changes within module boundaries—no cross-module imports. Shared glue belongs under `glue/` or the catalog.
- [ ] Capture evidence as you go (test specs, manual validation notes). Store artifacts alongside the module or under `docs/`.
- [ ] If overrides are needed, model them early (e.g., `examples/compose.overrides/*.json`) so validation reflects the final wiring.

## Phase 3 — Validate

- [ ] Compose the plan: `node tm.mjs compose --compose <plan> --modules-root <dir> --out <winner>` (add `--overrides <file>` if applicable). Confirm the generated `winner/report.json` matches your expectations.
- [ ] Run shipping gates locally: `node tm.mjs gates shipping --compose <plan> --modules-root <dir> --emit-events --events-out artifacts/events.ndjson --strict-events`. Include `--overrides` when replaying override scenarios.
- [ ] Inspect emitted events (`artifacts/events.ndjson`). Expect `GATES_PASS`, `TEST_PASS`, `EVIDENCE_LINKED`; investigate any failure codes before continuing.
- [ ] Archive key artifacts (winner report, events file, manual evidence) for reviewers.
- [ ] Update `docs/report.json` (or module docs) with new evidence, risks, and follow-ups. Note the exact commands you ran.
- [ ] Prefer the MCP façade for repeat runs—agents can call `tm.compose`/`tm.gates` with overrides, strict events, and respect-requires toggles without extra scripting.

## Phase 4 — Pull Request

- [ ] Summarize intent, scope, and validation in the PR description. Include gate commands, overrides used, and artifact paths or MCP transcripts.
- [ ] Link to emitted events, winner reports, manual evidence, and any troubleshooting steps.
- [ ] Ensure CI mirrors your local loop (`tm compose`, `tm gates shipping --emit-events --strict-events`). Re-run locally (via CLI or MCP) if CI fails.
- [ ] Cross-check the implementer checklist for any remaining TODOs or evidence gaps.
- [ ] Tag reviewers familiar with the affected modules and include any follow-up actions in `docs/report.json`.

## Automation hand-offs

- **MCP façade**: Use `tm.meta` to build compose drafts with `respectRequires`, `tm.compose` to validate with overrides, and `tm.gates` with `strictEvents` to surface structured telemetry even on failure. See [docs/mcp.md](./mcp.md) for payload samples and troubleshooting codes.
- **Manual loop**: Keep [docs/tests.md](./tests.md), [docs/meta-history.md](./meta-history.md), and the module schemas nearby. They outline expected checks, historical context, and validation rules the gates enforce.

## Common snags

| Snag | Symptom | Fix |
| --- | --- | --- |
| Schema validation failure | `tm compose`/`tm gates` exit with `E_COMPOSE` or `E_REQUIRE_UNSAT` | Re-run with `--emit-events --strict-events` (or set `strictEvents` in MCP) and inspect the event log for missing providers/evidence. Align manifests with `spec/module.schema.json`. |
| Cross-module import | Gates emit `lint_failed` events or ESLint errors | Run ESLint locally (`npm i -D eslint @typescript-eslint/parser`) and confine imports to the module boundary or glue catalog. |
| Missing evidence | Gates emit `EVIDENCE_MISSING` or reviewers flag gaps | Update `module.json` `evidence` entries with file paths/notes, regenerate artifacts, and attach them to the PR. |
| Overrides drift | CI replay fails with `E_REQUIRE_UNSAT` | Commit the overrides JSON used during validation and ensure MCP/CLI invocations reference the same file. |

Stick to the Plan → Implement → Validate → PR cadence to keep contributor work predictable and reviewer load light.
