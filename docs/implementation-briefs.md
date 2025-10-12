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
- **Acceptance**:
  - Updated prompt emphasises requirements checks, duplicate-provider handling, and evidence-backed scoring.
  - With `--respect-requires`, the greedy meta planner no longer selects modules whose `requires[]` cannot be fulfilled by the current goal set.
  - The rubric/template/schema stay consistent with the prompt (confidence, rationale, rejected alternatives fields present).
  - Example coverage run succeeds and produces a valid `compose.greedy.json` without unmet dependencies.
