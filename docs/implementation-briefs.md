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
