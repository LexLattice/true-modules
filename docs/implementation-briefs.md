# Implementation Briefs — Wave 1 (C1–C3)

This implementation layer translates the high-level briefs into concrete work items for Codex Cloud coders. Each card below captures scope, files, acceptance criteria, event expectations, and CI touchpoints. Wave 1 focuses on hardening shipping gates and static analysis.

---

## C1 — Type-Safe Shipping (TypeScript compile)

- **Objective**: extend `tm.mjs` shipping gates to run TypeScript type checks whenever selected modules/glue include TS sources.
- **Key files**: `tm.mjs`, `docs/tests.md`, `runtimes/ts/composer/index.mjs`, `package.json` (devDependencies).
- **Implementation steps**:
  1. **Tooling**: add `typescript@^5.6` to `devDependencies`. During gates, resolve `node_modules/.bin/tsc`; if missing, emit `GATES_FAIL { "error": "tsc_missing" }` with guidance to run `npm i -D typescript`.
  2. **Detection rule**: scan the target modules root (`--modules-root`) for `**/*.ts` or `**/*.tsx` inside `modules/` or `glue/` only. If none exist, skip the TS pass and log an informational skip event.
  3. **tsconfig authoring**: ensure `winner/tsconfig.json` exists with:
     ```json
     {
       "compilerOptions": {
         "module": "NodeNext",
         "moduleResolution": "NodeNext",
         "target": "ES2022",
         "strict": true,
         "skipLibCheck": true
       },
       "include": ["modules", "glue"]
     }
     ```
     Do not include the composer/CLI sources.
  4. **Compile step**: emit `TSC_START`, run `tsc --noEmit` from the winner workspace. Capture stdout/stderr; write the full compiler output to a deterministic temp file (e.g., `winner/.tm/tsc.log`). On success emit `TSC_PASS { "dur_ms": … }`; on failure emit `TSC_FAIL` and surface the first 10 diagnostics plus `see full log at …/tsc.log`.
  5. **Docs**: add a concise troubleshooting checklist (“missing types”, “bad relative imports”, “path aliases”) to `docs/tests.md`.
- **Acceptance**:
  - Shipping gates fail with `error: "tsc_failed"` when diagnostics are produced; pass when TS sources type-check or when no TS sources exist (skip).
  - CI flow continues to compose examples and run shipping gates on both source modules and the generated winner workspace.
- **Event hygiene**: human-readable success/failure stays on stderr when `--emit-events` is enabled; stdout remains LD-JSON.

---

## C2 — ESLint Cross-Import Enforcement

- **Objective**: replace the regex-based cross-import lint with an AST-driven ESLint rule.
- **Key files**: `tm.mjs`, `scripts/eslint-run.mjs` (new), `.eslintrc.cjs` (new), `.eslintignore` (new), `docs/tests.md` (lint section).
- **Implementation steps**:
  1. **Tooling**: add `eslint@^8` (and `@typescript-eslint/parser` for TS files) plus `eslint-plugin-local-rules` to devDependencies. Surface a hint if ESLint binaries are missing.
  2. **Config**: create `.eslintrc.cjs` that registers the local rule via `eslint-plugin-local-rules` so the configuration works in CLI/IDE contexts.
     Implement the `cross-module-imports` rule inline. It must flag (a) relative imports escaping the module root (`../` beyond `modules/<this>`), and (b) absolute imports containing `modules/<other>`.
  3. **Ignore file**: add `.eslintignore` to exclude generated artifacts (`winner/**`, `.tm/**`, etc.).
  4. **Runner**: write `scripts/eslint-run.mjs` that loads ESLint programmatically, runs against a target directory, and returns structured diagnostics. Limit to the first 20 findings. When ESLint is unavailable, emit `GATES_WARN { "warn": "eslint_unavailable" }` and fall back to the existing regex scanner.
  5. **Gates integration**: update conceptual gates in `tm.mjs` to prefer the ESLint runner. On failure emit `GATES_FAIL { "error": "lint_failed", "file": …, "line": …, "message": … }`.
- **Acceptance**:
  - Introducing a cross-module import triggers the ESLint rule; removal restores passing gates.
  - When ESLint is missing, gates still run using regex fallback without failing the build (warning only).
- **CI**: add a dedicated job step for ESLint (see cross-cutting). During development, intentionally create/revert a violation to confirm detection.

---

## C3 — Port Interface Conformance

- **Objective**: ensure modules claiming to provide ports implement the expected TypeScript interface.
- **Key files**: `tm.mjs`, `runtimes/ts/ports/index.d.ts` (new), `docs/ports-conformance.md` (new), `spec/module.schema.json` (schema extension).
- **Implementation steps**:
  1. **Schema update**: extend `spec/module.schema.json` to allow an optional `port_exports` map:
     ```json
     "port_exports": {
       "type": "object",
       "patternProperties": {
         "^[A-Za-z][A-Za-z0-9]*Port@\\d+$": {
           "type": "object",
           "required": ["file", "export"],
           "properties": {
             "file": { "type": "string" },
             "export": { "type": "string" }
           },
           "additionalProperties": false
         }
       },
       "additionalProperties": false
     }
     ```
  2. **Declarations**: add `runtimes/ts/ports/index.d.ts` defining interfaces (e.g., `export interface DiffPort { … }`). Document version → interface naming (e.g., `DiffPort@1` → `DiffPort`; `@2` would map to `DiffPortV2`).
  3. **Harness generation**: for each module providing ports, emit `PORT_CHECK_START` and synthesize a temporary TS file that imports the declared `file`/`export` (from `port_exports`) and assigns it to the interface type:
     ```ts
     import type { DiffPort } from '../runtimes/ts/ports/index.js';
     import { diffPort } from './modules/git.diff.core/src/index.js';
     const _check: DiffPort = diffPort;
     ```
     If `port_exports` is absent, attempt heuristics (`default`, camelCase) but emit a warning encouraging explicit mappings.
  4. **Compilation**: reuse the C1 `tsc --noEmit` invocation, passing all generated harnesses in a single run (clean up afterward). Emit `PORT_CHECK_PASS`/`FAIL` events with `module` and `port`.
  5. **Errors**: on failure, produce `GATES_FAIL { "error": "port_conformance_failed", "module": “…", "port": “…" }` and show the first compiler diagnostic. If a referenced file/export is missing, fail earlier with `error: "port_export_not_found"`.
  6. **Docs**: create `docs/ports-conformance.md` describing how to declare `port_exports`, the interface expectations, and example harness output.
- **Acceptance**:
  - Example modules pass (they may need `port_exports` entries).
  - Missing or mismatched exports cause shipping gates to fail with actionable messaging.

---

## Cross-cutting requirements

1. **Tool presence**: every card must check for required binaries (`typescript`, `eslint`) and provide installation hints. C1 fails hard when TypeScript is absent; C2 logs a warning and falls back.
2. **Isolation**: lints and type checks should only touch the target modules/glue; never analyze the composer CLI itself.
3. **Event discipline**: when `--emit-events` is active, stdout is LD-JSON only; human-readable info must go to stderr via the emitter helper.
4. **CI restructuring**: split the workflow into `schemas`, `composer+gates`, and `eslint` jobs/steps. Ensure artifacts (e.g., `events.ndjson`, `tsc.log`) are collected where useful.

Once these briefs are approved, dispatch C1–C3 to Codex Cloud coders as independent tasks. After each landing, rerun the full local validation sequence (compose → winner composer → conceptual/shipping gates with events and hooks).

---

# Implementation Briefs — Wave 2 (C4–C5)

Wave 2 focuses on making composition deterministic and formalizing telemetry for downstream BO4 automation.

---

## C4 — Composer Duplicate-Provider Policy

- **Objective**: refuse ambiguous port providers unless plans disambiguate via wiring or explicit constraints, and surface deterministic reasoning.
- **Key files**: `runtimes/ts/composer/index.mjs`, `docs/composer.md` (new), new fixtures under `examples/dup-provider/`.
- **Implementation steps**:
  1. **Provider analysis**: treat provider identity as `PortName@major`. When multiple modules provide the same major, resolve using a deterministic order:
     1. Wiring entries (`compose.wiring[]`) that select a provider win.
     2. Constraints win next. Support string form `prefer:DiffPort@1=git.diff.core` and structured form `{ "preferred_providers": { "DiffPort@1": "git.diff.core" } }`.
     3. If still ambiguous → error.
  2. **Error model**: emit `E_DUP_PROVIDER` with message:
     ```
     Duplicate providers for DiffPort@1: git.diff.core, git.diff.alt.
     Add wiring from orchestrator or constraint prefer:DiffPort@1=git.diff.core.
     ```
     When a provider is chosen (wired or preferred), log why so `composer --explain` can report deterministic reasoning.
  3. **Edge handling**:
     - Constraints targeting missing ports (e.g., `DiffPort@2`) must fail with `E_PREFER_UNSAT`.
     - If a constraint resolves the port but other provider modules remain in the plan unused, emit a warning encouraging cleanup.
     - Implement `composer --explain` that outputs stable JSON/table listing each port, chosen module, and reason (`wired`, `preferred`, `sole`).
  4. **Docs & fixtures**: add `docs/composer.md` covering failure (no disambiguation) and fixes (wiring, `preferred_providers`). Create fixtures `examples/dup-provider/compose.fail.json` (expect `E_DUP_PROVIDER`) and `examples/dup-provider/compose.ok.json` (resolved).
  5. **Tests/CI**: extend composer CI to run both fixtures and assert exit codes, plus surface warning/success logs in explain mode.
- **Acceptance**:
  - Ambiguous ports without disambiguation exit with `E_DUP_PROVIDER`.
  - Constraints pointing at missing ports trigger `E_PREFER_UNSAT`.
  - `--explain` produces deterministic output describing provider choices/reasons.
  - Warning issued when unused providers remain after constraint resolution.

---

## C5 — Event Schema & File Sink

- **Objective**: stabilize gate event contracts and support artifact capture for BO4 orchestration.
- **Key files**: `spec/events.schema.json` (new), `tm.mjs`, `docs/events.md` (new), `.github/workflows/ci.yml`.
- **Implementation steps**:
  1. **Schema**: create `spec/events.schema.json` describing `tm-events@1` envelope with required fields `schema`, `event`, `ts`, `seq`, `source`, `context`, optional `detail`. Enumerate allowed event names (`GATES_*`, `TEST_*`, `TSC_*`, `LINT_*`, `PORT_CHECK_*`). Document per-event `detail` fields in `docs/events.md`.
  2. **CLI flags/behavior**:
     - `--emit-events` (stdout NDJSON) remains.
     - Add `--events-out <file>`: tee events to file (append by default; add `--events-truncate` to overwrite). Auto-create directories.
     - Add `--strict-events` (default enabled in CI) to fail fast on schema violations (emit `E_EVENT_SCHEMA`).
     - Every emission must include `schema: "tm-events@1"`, monotonically increasing `seq`, `source: { cli: "tm", version }`, `context: { run_id, mode, compose_sha256 }`, and event-specific `detail` fields (`module`, `test`, `dur_ms`, `code`, `artifact`, etc.).
     - Normalize error codes: e.g., `E_TSC`, `E_LINT`, `E_PORT_CONFORMANCE`, `E_HOOK`, `E_DUP_PROVIDER`, `E_REQUIRE_UNSAT`, `E_PREFER_UNSAT`, `E_EVENT_SCHEMA`.
     - Keep stdout free of human text when emitting events; continue logging human summaries to stderr.
  3. **Docs**: author `docs/events.md` with 3–4 sample LD-JSON lines, explaining `seq`, strict vs non-strict modes, artifact pointers, and usage (`tm gates ... --emit-events --events-out artifacts/events.ndjson --strict-events`).
  4. **CI**: run shipping gates with `--emit-events --events-out artifacts/events.ndjson --strict-events`, validate each line against the schema (AJV or script), and upload the NDJSON artifact.
- **Acceptance**:
  - All events (conceptual + shipping) validate against `tm-events@1` with monotonic `seq`.
  - `--events-out` produces a file identical to stdout stream when `--emit-events` is set.
  - Schema violations with `--strict-events` cause an immediate failure (`E_EVENT_SCHEMA`).
  - Event `detail` includes compose hash, durations, and artifact pointers for downstream automation.

---

After Wave 2 briefs are approved, hand C4–C5 to Codex Cloud coders. Post-merge, rerun the end-to-end validation (compose → winner composer → gates) and inspect the duplicate-provider and events-out scenarios to confirm behavior.


---

# Implementation Briefs — Wave 3 (C6–C7)

Prompt packs equip both implementers and meta reviewers with consistent, self-contained guidance. Wave 3 focuses on formalising those prompts and ensuring the meta planner respects module requirements during selection.

---

## C6 — Implementer Prompt Pack

- **Objective**: deliver a first-party prompt kit that keeps Codex implementers aligned with module schemas, evidence expectations, and checklist discipline.
- **Key files**: `prompts/implementer/implementer.md` (new), `prompts/implementer/CHECKLIST.md` (new), `docs/getting-started.md` (link the pack), `docs/tests.md` (reference checklist usage).
- **Implementation steps**:
  1. **Author the primary prompt** (`prompts/implementer/implementer.md`):
     - Opening context (what True Modules is, where to work, how to run gates).
     - Explicit deliverables (module folder, `module.json`, tests, evidence bindings).
     - Schema references (`/spec/module.schema.json`, `/docs/evidence-bindings.md`, `/docs/tests.md`).
     - Guardrails (no cross-imports, respect `requires[]`, keep port contracts intact).
     - Output contract (summaries, tests executed, risks/follow-ups).
  2. **Publish a checklist** (`prompts/implementer/CHECKLIST.md`): concise list of MUST items (schema fields present, invariants, evidence attachments, gate runs). Reference it from the prompt and the docs.
  3. **Docs integration**: in `docs/getting-started.md` “Implementer loop” section, add a bullet that links to the new prompt pack and reminds users to copy the checklist into their PR description. Update `docs/tests.md` with a short paragraph describing how the checklist aligns with the event telemetry.
  4. **Prompt hygiene**: ensure Markdown uses code fences for commands, emphasises deterministic steps (`npm ci`, `node tm.mjs gates shipping`). Provide placeholders for module IDs and evidence citations so Codex can substitute easily.
- **Acceptance**:
  - The prompt renders without broken links and contains explicit references to schema, evidence, and tests.
  - The checklist covers at least schema completion, invariants, `requires[]` satisfaction, gates/test execution, and evidence citations.
  - `docs/getting-started.md` and `docs/tests.md` mention the new pack so human reviewers know where to find it.

---

## C7 — Meta Prompt Pack++

- **Objective**: upgrade the meta-review prompt and solver so planners evaluate module requirements, duplicate providers, and confidence per goal before BO4 hand-off.
- **Key files**: `meta/prompts/meta.md`, `tm.mjs` (meta command), `docs/bo4/meta/meta_report.v1.schema.json`, `docs/bo4/meta/rubric.v1.json`, `docs/bo4/templates/variant_report.v1.stub.json`.
- **Implementation steps**:
  1. **Prompt updates** (`meta/prompts/meta.md`): call out the evaluation goals (architecture clarity, checklist coverage, novelty, coherence), require evidence bindings per claim, require explicit confidence scores, and remind reviewers to check `requires[]` satisfaction and duplicate providers before selecting a winner.
  2. **Solver enhancement** (`tm.mjs meta`): add a `--respect-requires` flag. When enabled, compute the set of satisfied requirements based on the coverage JSON; penalise or exclude modules whose `requires[]` cannot be met by the chosen set (e.g., drop gain to `-inf` or subtract a large weight). Document the flag in the CLI usage string.
  3. **Rubric alignment**: extend `docs/bo4/meta/rubric.v1.json` with a note on penalising unmet `requires[]` and duplicate providers; update the template (`docs/bo4/templates/variant_report.v1.stub.json`) so the meta report explicitly records confidence per goal and rationale for discarded variants.
  4. **Schema tweak** (if necessary): ensure `docs/bo4/meta/meta_report.v1.schema.json` permits new fields (e.g., `confidence` per decision) or tighten descriptions so the prompt-to-report loop stays consistent.
  5. **Examples/testing**: run `node tm.mjs meta --coverage ./examples/coverage.json --respect-requires --out ./examples/compose.greedy.json` and confirm the resulting plan excludes modules with unsatisfied requirements. Capture a before/after diff in the PR description.
  6. **Workflow note**: meta reviewers should prefer `--respect-requires` during tournament runs so the greedy selector only emits plans where every module dependency (per `provides_ports`/`requires`) is satisfied; escalate any unresolved duplicates as residual risks.
  7. **Meta history**: after choosing a winner and merging, append the outcome, imports, and review learnings to `docs/meta-history.md` so the next wave can reference it.
- **Acceptance**:
  - Updated prompt emphasises requirements checks, duplicate-provider handling, and evidence-backed scoring.
  - With `--respect-requires`, the greedy meta planner no longer selects modules whose `requires[]` cannot be fulfilled by the current goal set.
  - The rubric/template/schema stay consistent with the prompt (confidence, rationale, rejected alternatives fields present).
  - Example coverage run succeeds and produces a valid `compose.greedy.json` without unmet dependencies.

---

# Implementation Briefs — Wave 4 (C8–C10)

Wave 4 continues the post-review polish: mine residual lessons, expand cross-platform safety coverage, and ensure winners can pass a packaging smoke test. Handle C8–C10 in one combined effort so tooling, docs, and fixtures stay in sync.

---

## C8–C10 — Lessons Miner · SafetyPort Pack · Winner Pack Smoke

- **Objective**: surface residual risks and follow-ups as durable lessons, harden SafetyPort across Windows path edge cases, and add an optional packaging smoke test for composed winners.
- **Key files**: `tm.mjs`, `docs/lessons.md` (new), `docs/tests.md`, `examples/modules/safety.validation/tests/spec_paths_windows.json`, `examples/modules/safety.validation/tests/run_win_cases.mjs`, `runtimes/ts/composer/index.mjs`, `docs/composer.md`, `package.json` (optional script wiring).
- **Implementation steps**:
  1. **Lessons miner command** (`tm.mjs lessons mine`):
     - Accept `--from <glob …>` (one or many) and `--out <file>`.
     - Load each matching `report.json` (implementer, meta, winner), gather `followups[]` and `residual_risks[]`, normalise strings, and deduplicate entries.
     - Emit `{ "followups": [...], "residual_risks": [...] }`; running the command twice over the same inputs must produce identical output (idempotent).
     - Warn (but continue) when a file is missing or malformed; only hard-fail when no reports could be read.
  2. **Lessons documentation**:
     - Author `docs/lessons.md` summarising the miner, the expected JSON shape, sample commands (e.g., `node tm.mjs lessons mine --from "docs/**/*.json" --out lessons.json`), and guidance on cross-linking to `docs/meta-history.md`.
     - Optional: expose a convenience npm script (e.g., `"lessons": "node tm.mjs lessons mine --from \\\"docs/**/*.json winner/report.json\\\" --out lessons.json"`).
  3. **Examples & verification**:
     - Drop a handful of sample reports under `examples/lessons/` or reuse existing docs; add a README note or fixture output demonstrating the merged lessons file.
  4. **SafetyPort Windows test pack**:
     - Create `examples/modules/safety.validation/tests/spec_paths_windows.json` covering Windows/WSL path quirks.
     - Author `run_win_cases.mjs` that executes those cases; it must exit 0 with a “SKIP” message when `process.platform !== "win32"` but perform real assertions on Windows.
     - Update any local `package.json` or docs so the script can be invoked (`node run_win_cases.mjs`); ensure tests integrate with existing gating (no manual wiring required on non-Windows).
     - Add a short “Platform-conditional tests” subsection to `docs/tests.md`, explaining how to invoke the Windows pack and how skips appear in CI.
  5. **Winner packaging smoke**:
     - Extend `runtimes/ts/composer/index.mjs` to emit a minimal `winner/package.json` (mark `"private": true`; include name/version gleaned from the compose run).
     - In `tm.mjs gates shipping`, add `--npm-pack`: after gates succeed, run `npm pack` inside `winner/`, capture output, and always delete the generated tarball.
     - If `npm` is unavailable, surface a warning and skip the smoke instead of crashing.
     - Failures should bubble as `GATES_FAIL { "error": "npm_pack_failed", ... }` with the first few diagnostics.
     - Update `docs/composer.md` with a “Packaging smoke” section describing the flag, artifacts, and cleanup behaviour.
  6. **Validation checklist**:
     - Run `node tm.mjs lessons mine --from "docs/report.json" --out tmp/lessons.json` (and against sample fixtures) to confirm deduping.
     - Execute the Windows SafetyPort script on both Linux/macOS (verify skip) and Windows (real assertions).
     - Compose the sample modules and run `node tm.mjs gates shipping --compose examples/compose.greedy.json --modules-root examples/modules --npm-pack`, ensuring the tarball is produced then removed.
- **Acceptance**:
  - Lessons miner produces stable, deduplicated output and handles missing files gracefully.
  - SafetyPort Windows tests skip cleanly on non-Windows hosts and execute on Windows without breaking existing gates.
  - `--npm-pack` succeeds for the examples; failures surface actionable messaging and clean up temp artifacts.
  - Documentation additions (`docs/lessons.md`, `docs/tests.md`, `docs/composer.md`) match the implemented behaviour and point to the new commands/scripts.

After landing, run the end-to-end compose → winner → shipping flow with `--npm-pack`, generate fresh lessons via the miner, and record key follow-ups in `docs/meta-history.md`.

---

# Implementation Briefs — Wave 5 (C11–C12)

Wave 5 tightens the compose/deploy feedback loop: introduce an override file for last‑mile adjustments and polish the CI pipeline so packaging telemetry and caches keep runs fast. Treat C11 and C12 as a single BO4 prompt so overrides and CI wiring ship together.

---

## C11–C12 — Compose Overrides · CI Polish

- **Objective**: allow intent owners to fine-tune composed plans via override files while keeping CI lean, cached, and event-rich.
- **Key files**: `tm.mjs`, `docs/composer.md`, `.github/workflows/ci.yml`, `docs/tests.md` (CI notes), `docs/meta-history.md` (post-run record), `examples/` compose fixtures.
- **Implementation steps**:
  1. **Override ingestion** (`tm.mjs compose --overrides <file>`):
     - Parse an overrides JSON file relative to the cwd; support absolute paths.
     - Merge with the base compose file before validation/build:
       - `modules[]`: treat `id` as the key; replace matching entries, append new ones.
       - `wiring[]`: treat `{from,to}` pairs as keys; replace matches, append new wiring segments.
       - `constraints[]`: start from the base list, append new unique strings, allow overrides to remove entries by prefixing with `-constraint-name`.
     - Emit `COMPOSE_OVERRIDES_APPLIED` event summarising which sections changed. Preserve deterministic ordering (modules sorted by `id`, wiring by `{from,to}`) so repeated runs are stable.
     - Validation must still run after merging; refuse to continue if the override file is missing or invalid JSON (surface `E_COMPOSE_OVERRIDES`).
  2. **Docs & fixtures**:
     - Extend `docs/composer.md` with an “Overrides” section covering file shape, merge semantics, examples (swapping a provider, adding/removing constraints), and interaction with winner outputs.
     - Add a lightweight fixture under `examples/compose.overrides/` (base compose + overrides + resulting plan) that the docs reference.
     - Update `docs/tests.md` CI section with a note that overrides must be exercised locally before handing off to CI.
  3. **Workflow split & caching** (`.github/workflows/ci.yml`):
     - Split into jobs `schemas`, `composer_gates`, and `rust_check`. Ensure `composer_gates` depends on `schemas` when schema generation feeds compose/gates.
     - Cache `~/.npm`/`node_modules` and Cargo (`~/.cargo`, `target`) keyed by `package-lock.json`/`Cargo.lock`.
     - In `composer_gates`, run:
       ```bash
       node tm.mjs compose --compose examples/compose.greedy.json --modules-root examples/modules --overrides examples/compose.overrides/overrides.json --out examples/winner
       node tm.mjs gates shipping --compose examples/compose.greedy.json --modules-root examples/modules --emit-events --events-out artifacts/events.ndjson --strict-events
       ```
       Pipe events through `jq -c . >/dev/null` to ensure clean NDJSON.
     - Upload `artifacts/events.ndjson` and any override diff artifacts as job artifacts.
     - Add job summaries or log groups so key timings are obvious in GitHub UI.
  4. **Event hygiene**:
     - Extend the event schema (if needed) so overriding emits consistent telemetry (`detail`: `{ added: { modules: [...] }, replaced: [...], removed_constraints: [...] }`).
     - Ensure CI still fails fast when `--strict-events` finds schema violations; caches must not hide failures.
  5. **Validation checklist**:
     - Locally run the compose command with `--overrides` against the fixtures and confirm the resulting plan reflects replacements/removals as intended.
     - Run the split CI workflow via `act` or targeted GitHub Actions dispatch to verify caching hits and artifacts upload.
     - After BO4 winner selection and merge, append the cycle summary (winner, borrowed imports, gaps, residual risks, follow-ups) to `docs/meta-history.md`.
- **Acceptance**:
  - `tm.mjs compose --overrides …` deterministically merges modules, wiring, and constraints, failing with actionable errors when inputs are missing or invalid.
  - Docs illustrate override usage and the example files mirror the described behavior.
  - CI workflow runs the three split jobs with caches, emits events, uploads artifacts, and completes faster than the previous monolithic job.
  - Event telemetry remains schema-compliant and highlights override activity for auditors.
  - Meta history reflects the wave’s outcomes once the run completes.

---

# Implementation Briefs — Wave 6 (C13–C14)

Wave 6 closes out the first loop by exposing `tm` through an MCP façade and publishing a contributor playbook. Ship both pieces together so automation and human onboarding stay aligned.

---

## C13–C14 — MCP Façade · Contributor Playbook

- **Objective**: expose core `tm` capabilities via MCP so agents can orchestrate workflows programmatically, and document the end-to-end contributor loop for humans.
- **Key files**: `mcp/server.mjs` (new), `docs/mcp.md` (new), `docs/contributor-playbook.md` (new), `package.json` (scripts/dev deps as needed), `docs/tests.md` (link MCP + playbook), `README.md` (pointer).
- **Implementation steps**:
  1. **MCP server scaffolding**:
     - Author `mcp/server.mjs` using the official MCP Node SDK. Register three tools:
       - `tm.meta(coverage)` → runs `node tm.mjs meta --coverage <tmpFile> --out <tmpCompose>` and returns the parsed compose JSON.
       - `tm.compose(compose, modulesRoot)` → runs `node tm.mjs compose --compose <tmpCompose> --modules-root <modulesRoot> --out <tmpWinner>` and returns the scaffold winner report (bill of materials + wiring).
       - `tm.gates(mode, compose, modulesRoot)` → runs `node tm.mjs gates <mode> --compose <tmpCompose> --modules-root <modulesRoot> --emit-events --events-out <tmpEvents>` and returns `{ pass: boolean, events: [...] }`.
     - Use per-request temp directories under `os.tmpdir()`; clean them up even on failure.
     - Stream stderr/stdout to MCP logs. Propagate failures with structured error codes mirroring the CLI (`E_REQUIRE_UNSAT`, `npm_pack_failed`, etc.).
     - Gate network or filesystem access tightly (no implicit writes outside temp dirs).
  2. **CLI and packaging**:
     - Add an npm script (`"mcp:server": "node mcp/server.mjs"`) and, if the SDK requires, add dependencies (e.g., `@modelcontextprotocol/sdk`) to `package.json`.
     - Document environment variables/config knobs (e.g., `TM_MCP_MODULES_ROOT`) so callers can supply module roots without hard-coding.
  3. **MCP docs** (`docs/mcp.md`):
     - Outline prerequisites (Node version, installing the MCP SDK).
     - Provide sample `~/.mcp/clients/tm.json` configuration for at least one client (VS Code, Claude Desktop, or the generic MCP CLI).
     - Walk through invoking each tool with example payloads and their JSON responses.
     - Include troubleshooting tips for common errors (missing modules root, schema validation failure, gate errors).
  4. **Contributor playbook** (`docs/contributor-playbook.md`):
     - Structure the doc as a checklist-driven guide: “Plan → Implement → Validate → PR”.
     - Cover module scaffolding, local testing (`tm compose`, `tm gates shipping --emit-events --strict-events`), evidence expectations, and CI artifact inspection.
     - Link to the MCP doc for automation hand-offs and to existing specs (`docs/tests.md`, `docs/meta-history.md`, `docs/ports-conformance.md`).
     - Add a concise “Common snags” appendix (schema failures, cross-module imports, missing evidence) with remediation steps.
  5. **Doc & README integration**:
     - Update `docs/tests.md` in the contributor checklist section to reference both the MCP façade (for automation) and the playbook (for human loops).
     - Add a short blurb in `README.md` pointing newcomers to `docs/contributor-playbook.md`.
  6. **Validation checklist**:
     - Run the MCP server locally and exercise each tool using a minimal MCP client script; capture sample responses in `docs/mcp.md`.
     - Confirm cleanup leaves no stray temp directories under `/tmp`.
     - Walk through the playbook end-to-end while composing `examples/compose.greedy.json` and running shipping gates; ensure every referenced command exists.
- **Acceptance**:
  - MCP tools wrap the existing CLI faithfully, return JSON payloads on success, and surface CLI errors with clear MCP error codes.
  - Documentation provides a working setup guide and sample requests/responses; all links resolve.
  - The contributor playbook walks a new module author from repo checkout to PR with actionable troubleshooting notes.
  - README/tests docs reference the new materials without duplicating content.

---

## E1–E3 — Meta Scorer v1 · Events Validate/Replay

**Objective**: make meta selection deterministic (feasible-greedy with weights/profiles) and formalize event integrity + replayable timelines.

**Key files**: `tm.mjs`, `meta/weights.json` (new), `docs/meta-scorer.md` (new), `spec/events.schema.json` (already present), `docs/events.md` (extend), `scripts/events-validate.mjs` (new), `scripts/events-replay.mjs` (new), CI workflow.

**Implementation steps**:

1. **Meta scorer**

   * Implement feasible-greedy in `tm mjs meta`:

     * Features per module: `coverage_contribution`, `evidence_strength`, `risk`, `delta_cost`, `hygiene`.
     * Feasibility: `requires[]` satisfied, duplicate providers resolved.
   * Add weights profiles in `meta/weights.json` (`conservative`, `fast`, `evidence-heavy`); flags: `--profile <name>` or `--weights <file>`.
   * Emit `META_PICK` events with `{module, gain, drivers}`; deterministic tiebreakers (evidence↓, risk↑, delta↑, id lexicographic).
   * Docs: short explainer + examples.

2. **Events validate**

   * `tm events validate --in artifacts/events.ndjson --strict`:

     * Validate each NDJSON line against `tm-events@1`, enforce monotonic `seq`, and match `context.compose_sha256` if present.
     * Exit with `E_EVENT_SCHEMA` on first violation; print offending line number.

3. **Events replay**

   * `tm events replay --in artifacts/events.ndjson` → timeline:

     * Summarize starts, picks, gate durations, first failures with `detail.code`.
     * Output to stdout and `artifacts/timeline.txt`.

4. **CI**

   * Add steps: validate + replay on example runs; upload `events.ndjson` and `timeline.txt`.

**Acceptance**:

* Same inputs + weights profile ⇒ identical `compose.json` across runs.
* `validate` fails on any malformed event; `replay` prints a stable timeline.
* Docs link to flags and show one minimal before/after example.

---

## E2 — Headless Codex Cloud Kit (watch · harvest · meta · compose · gates · apply)

**Objective**: run the BO4 loop end-to-end headlessly with durable artifacts and zero TUI dependency.

**Key files**: `scripts/codex-watch.mjs` (new), `scripts/bo4-harvest.mjs` (new), `scripts/bo4-meta-run.mjs` (new), `scripts/bo4-compose.mjs` (new), `scripts/bo4-apply.sh` (new), `runs/<date-slug>/run.json` (manifest), `docs/headless-cloud.md` (new), CI job.

**Implementation steps**:

1. **Watcher** (`codex-watch.mjs`)

   * Poll `codex cloud list --json` for `task_id`; write **tm-events@1** heartbeats to `runs/.../artifacts/events.ndjson`; exit on `ready|error`.

2. **Harvest** (`bo4-harvest.mjs`)

   * `codex cloud export/show/diff` to `runs/.../variants/varN/`.
   * Enforce **True Module** deliverables; if missing, exit `E_VARIANT_NO_MODULES`.

3. **Meta** (`bo4-meta-run.mjs`)

   * Invoke local meta (or cloud reviewer) → `runs/.../meta/{coverage.json,compose.json,report.json}`.
   * Compute and record `compose_sha256` in `run.json`.

4. **Compose + Gates** (`bo4-compose.mjs`)

   * Call composer → `runs/.../winner`; run `tm gates shipping --emit-events --events-out ... --strict-events`.
   * On failure, print the first actionable error + artifact pointer (tsc/lint log).

5. **Apply** (`bo4-apply.sh`)

   * If single variant chosen: `codex cloud apply ... --preflight`.
   * Else: create `bo4/<task_id>/winner` branch, commit `winner/`, push PR.

6. **Docs & CI**

   * `docs/headless-cloud.md` with the 10-step loop and run tree.
   * CI job that runs a miniature headless loop on examples.

**Acceptance**:

* One command (or make target) executes watcher→harvest→meta→compose→gates; artifacts written and uploaded.
* Non-module variants fail early with `E_VARIANT_NO_MODULES`.
* Manifest `run.json` populated with `task_id`, hashes, artifacts pointers.

---

## E4–E5 — Oracles + Side-Effects Enforcement

- **Objective**: guarantee deterministic behaviour and enforce declared side effects.
- **Key files**: `oracles/specs/*.json` (new), `tm.mjs` (oracle runner, gate toggle, side-effect wrapper), `docs/oracles.md` (new).
- **Implementation steps**:
  1. **Oracle runner**: `tm oracles run --modules-root <dir> --spec oracles/**.json` to execute determinism/idempotence checks; ship example specs covering repeatable I/O.
  2. **Gate integration**: wire `tm gates shipping --with-oracles` to emit `ORACLE_START/PASS/FAIL` with module/case detail.
  3. **Side-effects guard**: instrument filesystem writes and process spawns during gates; compare to `module.json.side_effects`, failing with `E_SIDEEFFECTS_DECLARATION` or `E_SIDEEFFECTS_FORBIDDEN` as appropriate.
- **Acceptance**:
  - Known nondeterministic fixtures fail with the new oracle error codes; accurately declared modules pass.
  - `--with-oracles` succeeds on the examples; documentation explains how to author new specs and declare side effects.

---

## E6–E7–E8 — Port Version Negotiation · SafetyPort Deep Suite · Performance & Caching

**Objective**: safe multi-major ports, hardened platform edges, faster loops.

**Key files**: `runtimes/ts/composer/index.mjs`, `docs/composer.md` (extend), `examples/modules/safety.validation/tests/*` (expand), `tm.mjs` (durations, caches), CI.

**Implementation steps**:

1. **Port version negotiation**

   * Provider identity = `PortName@major`. If multiple majors present, follow policy:

     * Prefer `compose.constraints.preferred_providers["Port@major"]` or explicit wiring; else error `E_PORT_VERSION_AMBIG`.
   * `--explain` prints chosen providers + rule (wired/preferred/sole).

2. **Safety deep suite**

   * Add tests for path normalization nuances (case-insensitive FS, symlinks, UNC/WSL specifics).
   * Conditional runners emit `TEST_SKIPPED` events on unsupported OS; PASS overall.

3. **Performance & caching**

   * ESLint cache + TypeScript incremental on shipping gates.
   * Composer smart copy (hash compare) for `winner/`.
   * Emit `detail.dur_ms` per major phase and show a per-gate summary; CI compares baseline (2nd run ≥30% faster on examples).

**Acceptance**:

* Mixed majors without policy → `E_PORT_VERSION_AMBIG` (non-zero exit); with constraints/wiring → pass.
* Safety suite passes on Linux/mac; executes real assertions on Windows.
* 2nd run on unchanged examples shows measurable speedup; durations visible in events and CI logs.

---


## F1–F2 — MCP Integration Tests · Python Shim

**Objective**: guarantee the MCP façade stays in lock-step with the CLI, and give non-Node agents a thin Python wrapper.

**Key files**:
`mcp/tests/smoke.mjs` (new), `.github/workflows/mcp-smoke.yml` (new) · `python/tm_cli.py` (new), `python/README.md` (new) · minor updates in `package.json`, `docs/mcp.md`, `README.md`.

**Implementation steps**:

1. **MCP smoke test**

   * Script `mcp/tests/smoke.mjs`:

     * Boot `node mcp/server.mjs` on stdio (ephemeral tmp dir).
     * Call three tools with minimal payloads:

       * `tm.meta({ coverage })` → assert JSON shape + schema.
       * `tm.compose({ compose, modulesRoot })` → assert BoM.
       * `tm.gates({ mode, compose, modulesRoot })` → assert `{ pass: boolean }` and events exist.
     * Ensure temp dirs cleaned; server process exited.
   * CI job `mcp-smoke.yml`:

     * Install deps → run smoke script → upload sample responses under `artifacts/mcp/`.

2. **Python shim**

   * `python/tm_cli.py`:

     * Subprocess wrapper around `node tm.mjs` for `meta/compose/gates`.
     * STDIN/STDOUT pure JSON; return non-zero on CLI error, propagate error code fields.
   * `python/README.md`:

     * Usage examples (venv/pipx), sample calls, error handling patterns.

**Acceptance**:

* CI `mcp-smoke` passes and publishes example payloads.
* `python/tm_cli.py` can run `gates shipping` on the examples and prints JSON identical in structure to Node.
* Docs updated with quick start links; `README` points to MCP + Python sections.

---

## F3–F4 — `tm doctor` · `tm init` · Winner Publish (npm-pack)

**Objective**: one-shot environment diagnostics + repo bootstrap, and an optional publishable winner artifact.

**Key files**:
`tm.mjs` (new commands), `templates/init/**` (new), `docs/contributor-playbook.md` (update), `docs/composer.md` (update), CI workflow extension.

**Implementation steps**:

1. **`tm doctor`**

   * Checks: Node/Rust versions, `typescript`/`eslint` availability, AJV compile, file perms, `git` present.
   * Output: human + machine-readable JSON (`--json`), actionable hints, and `doctor.json` under `--artifacts` (default `artifacts/`).

2. **`tm init`**

   * Drops a minimal skeleton: `modules/`, example module, `spec/`, CI file, `docs/links.md`.
   * Optional flags: `--ts` to add TS config; `--mcp` to add façade stub wiring.

3. **Winner publish path**

   * `gates shipping --npm-pack`: pack `winner/` into a tarball; store at `artifacts/winner.tgz`.
   * On failure, exit with `E_NPM_PACK`; include artifact log pointer.
   * `docs/composer.md`: short “pack smoke” section and consumption notes.

4. **CI**

   * Add `doctor` step (non-blocking warn mode) and a `npm-pack` smoke on examples.

**Acceptance**:

* `tm doctor` detects missing tools and prints remediation; `--json` returns a stable schema.
* `tm init` repo passes **conceptual** gates OOTB; instructions link to the playbook.
* `--npm-pack` creates `artifacts/winner.tgz` on examples; failure blocks shipping gates with clear code.

---

## F5–F6 — Events Summary/Viz · Auto Lessons Hook

**Objective**: turn events into actionable dashboards and keep organizational memory fresh automatically.

**Key files**:
`scripts/events-summarize.mjs` (new), `tm.mjs` (`events summary` subcommand, new) · `scripts/lessons-auto.sh` (new), `.github/workflows/lessons.yml` (new) · `docs/events.md`, `docs/lessons.md` (update).

**Implementation steps**:

1. **Summaries & viz**

   * `scripts/events-summarize.mjs`:

     * Read NDJSON → compute: gate durations, fail codes histogram, slowest tests, pass/fail by module.
     * Emit `artifacts/summary.json` + `artifacts/summary.md` (TTY table).
   * `tm events summary --in <ndjson>`: thin wrapper to the script (prints to stdout).

2. **Auto lessons**

   * `scripts/lessons-auto.sh`:

     * Run `tm lessons mine --from "**/report.json" --out lessons.json`.
     * Option A: commit changes on merge (bot user); Option B: upload artifact (no write).
   * CI workflow `lessons.yml`:

     * Trigger: `push` to `main` → mine → (commit or artifact).

3. **Docs**

   * `docs/events.md`: add “How to read the summary” with examples.
   * `docs/lessons.md`: recommend seeding next prompts from `lessons.json`.

**Acceptance**:

* Running `tm events summary --in artifacts/events.ndjson` prints a concise table and writes both summary files.
* CI publishes `summary.*` and `lessons.json` as artifacts; commit option (if chosen) updates `lessons.json` on main without conflicts.

---

### Hand-off tips

* Keep **stdout** machine-readable where applicable; route human summaries to **stderr** when `--emit-events` is active.
* Emit stable **error codes** on all new failure paths (`E_NPM_PACK`, `E_SUMMARY_PARSE`, `E_LESSONS_WRITE`).
* Prefer **append-safe** file sinks under `artifacts/` and deterministic filenames.

---

## UI-Console — Implement Workflow Orchestrator Console

- **Objective**: Deliver the operator console defined in the AMR canon (`amr/architecture.json`, `amr/schemas.json`, `amr/acceptance.json`, `amr/traceability.map.json`). The UI must visualize the AMR→Bo4 workflow, allow pre-flight configuration, embed Codex assistance, and persist run history with replay/export.

- **Key files**:
  - Front-end surfaces: `apps/workflow-console/src/ui/{shell.tsx, workflow-surface.tsx, run-configurator.tsx, codex-composer.tsx, history-timeline.tsx}`
  - Service adapters: `apps/workflow-console/src/services/{session-facade.ts, run-state-gateway.ts, run-configuration.ts, codex-adapter.ts, history-store.ts, cli-bridge.ts}`
  - Canon types generated from `amr/schemas.json` → `apps/workflow-console/src/types/`
  - API routes/backends: `apps/workflow-console/api/**` (or extend existing orchestration service)
  - Acceptance harness: `apps/workflow-console/tests/acceptance/ui-console.spec.ts` (covers T-UI-01…T-UI-04)

- **Implementation steps**:
  1. **Canon hydration**  
     - Generate TypeScript types from `amr/schemas.json` (e.g., `typescript-json-schema`, `ajv`).  
     - Scaffold module shells respecting `amr/architecture.json` (interfaces, invariants as comments).
  2. **Workflow surface (REQ-UI-1)**  
     - Render swimlanes with status badges, dependency tooltips, artifact cards.  
     - Subscribe to `RunStateGateway.subscribeUpdates`; ensure UI refresh ≤2s after snapshot changes.  
     - Provide artifact inspection modal via `HistoryStore.fetchTimeline` + `WorkflowSurface.inspectArtifact`.
  3. **Run configurator (REQ-UI-2)**  
     - Implement form with validation against `ConfigSubmission`/`RunManifest`; support reviewer bots, follow-up policy.  
     - Invoke `RunConfigurationService.prepareManifest` + `CLIBridge.validateManifest`; display manifest preview and errors.  
     - Persist defaults via `RunConfigurationService.persistDefaults` for replay seeding.
  4. **Codex composer (REQ-UI-3)**  
     - Integrate Codex proxy with streaming suggestions, policy guardrails (`CodexAdapter.generate/redact`), audit logs persisted in `HistoryStore`.  
     - Provide draft validation/publish flow mirroring `CodexComposer.publishDraft`.
  5. **History timeline (REQ-UI-4)**  
     - Persist completed runs (`HistoryStore.appendRun`), render table, support replay/export actions.  
     - Freeze live workflow updates while replay is active; show replay banner and export controls.
  6. **CLI status/telemetry**  
     - Implement `CLI.status` handshake in `svc.cli_bridge` and surface progress / error logs in the UI.  
     - Emit `tm-events@1` events for key actions (config submit, kickoff, replay, Codex request) using existing event pipeline.
  7. **Acceptance tests**  
     - Translate T-UI-01..T-UI-04 into Cypress/Playwright specs.  
     - Provide stubs for `seed_run_state`, `seed_history`, `simulate_stage_update`, etc., and ensure tests run headless in CI.
  8. **Docs & onboarding**  
     - Add operator guide (`docs/ui-console.md` or update `docs/cloud-headless.md`) covering console usage, replay, Codex workflows.  
     - Mention new commands/flags (e.g., CLI status, replay export) in the contributor playbook if applicable.

- **Acceptance**:
  - UI displays the full AMR→Bo4 workflow with live status, dependency cues, and artifact inspection (REQ-UI-1).  
  - Operators configure variant counts, brief depth, reviewer bots, follow-up policy, and see validated manifests + CLI status (REQ-UI-2).  
  - Codex composer offers inline drafting with policy feedback and persistence to history (REQ-UI-3).  
  - Run history persists completed runs, supports replay/export, and freezes live updates during replay (REQ-UI-4).  
  - Tests T-UI-01…T-UI-04 pass locally and in CI; gate failures surface clear error codes.  
  - Implementation matches the AMR canon (module names, interfaces, invariants); deviations must be justified via updated canon + AMR gates.

- **Tests**:
  ```bash
  # Generate/validate schemas & types
  npm run schema:compile

  # Unit/component suites
  npm run test --workspace apps/workflow-console

  # Acceptance (choose Cypress or Playwright)
  npx playwright test apps/workflow-console/tests/acceptance/ui-console.spec.ts
  # or
  npx cypress run --spec apps/workflow-console/tests/acceptance/ui-console.cy.ts

  # Gates & canon verification
  node scripts/rcm-ssd-check.mjs --rcm rcm/rcm.json --trace amr/traceability.map.json --slates amr/slates --out amr/ssd.json --fail-low 0.75
  node scripts/tm-amr-verify.mjs --canon amr/architecture.json --acceptance amr/acceptance.json --rcm rcm/rcm.json --trace amr/traceability.map.json
  tm mjs gates conceptual --compose ./compose.json --modules-root ./modules
  tm mjs gates shipping --compose ./compose.json --modules-root ./modules --emit-events --events-out artifacts/events.ndjson --strict-events
  ```
