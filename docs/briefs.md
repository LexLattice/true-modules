## C1 — Add Type-Safe Shipping (TS compile in gates)

**Why:** catch broken types in the winner workspace, not just schema/test issues.
**Deliverables:**

* `winner/tsconfig.json` (minimal, strict `--noEmit`)
* `tm.mjs`: in `gates shipping`, detect TS sources and run `tsc --noEmit`
* `docs/tests.md`: short “type-check” subsection
  **Acceptance:**
* If any `winner/modules/**.ts` exists, `gates shipping` fails on TS errors.
* CI step runs `tsc --noEmit` on the example winner (currently passes).

**Test:**

```bash
node runtimes/ts/composer/index.mjs --compose ./examples/compose.json --modules-root ./examples/modules --out ./examples/winner
node tm.mjs gates shipping --compose ./examples/compose.json --modules-root ./examples/winner/modules
```

---

## C2 — Replace regex import checks with ESLint rule

**Why:** AST-based cross-import linting is more reliable than regex.
**Deliverables:**

* `.eslintrc.cjs` with a custom rule or config to forbid imports across `modules/*`
* `scripts/eslint-run.mjs`
* `tm.mjs`: `gates conceptual` prefers ESLint; fallback to current lint if ESLint not found
  **Acceptance:**
* Cross-module import violation in any `modules/*` yields deterministic ESLint error.
* Examples remain green.

**Test:**

```bash
node scripts/eslint-run.mjs ./examples/winner/modules
```

---

## C3 — Port Conformance (code-level)

**Why:** a module that claims `provides: ["DiffPort@1"]` must actually export the expected shape.
**Deliverables:**

* `runtimes/ts/ports/index.d.ts` (emittable .d.ts for Ports@1)
* `tm.mjs`: in `gates shipping`, load TS, check each provider has an export matching the interface (shape check via `tsc --noEmit` with an auto-generated harness)
* `docs/ports-conformance.md`
  **Acceptance:**
* Declaring `DiffPort@1` without implementing it fails shipping gates with a clear message.
* Examples pass without extra code changes (stubs ok).

---

## C4 — Composer: strict duplicate-provider policy

**Why:** avoid ambiguous wiring when multiple modules provide the same port.
**Deliverables:**

* `runtimes/ts/composer/index.mjs`: detect duplicate providers; require either:

  * explicit `compose.wiring[]` choosing a provider, or
  * `compose.constraints[]` containing `prefer:<port>=<module>`
* Error messages and docs in `docs/composer.md`
  **Acceptance:**
* Ambiguous duplicates fail; explicit wiring/constraint passes.

---

## C5 — Event Schema + file sink

**Why:** stabilize BO4 ingestion and enable artifact capture.
**Deliverables:**

* `spec/events.schema.json` (LD-JSON event records)
* `tm.mjs`: `--events-out <file>` to tee LD-JSON to file (stdout remains LD-JSON when `--emit-events`)
* `docs/events.md` detailing fields (run_id, mode, durations, module/test)
  **Acceptance:**
* Event lines validate against schema; file contains the same stream.
* Examples: event file written and schema-valid.

---

## C6 — Implementer Prompt Pack

**Why:** make implementers deliver consistent modules.
**Deliverables:**

* `implementer/prompts/implementer.md` (clear: produce `modules/<id>/module.json`, tests, evidence; no cross-imports)
* Mini checklist `implementer/CHECKLIST.md`
  **Acceptance:**
* Prompt includes all schema-required fields, invariants guidance, evidence examples.
* Links to `/spec/module.schema.json` and `/docs/evidence-bindings.md`.

---

## C7 — Meta Prompt Pack++

**Why:** improve plan quality before BO4.
**Deliverables:**

* `meta/prompts/meta.md` updated: consider `requires[]`, duplicate providers, confidence per goal
* `tm.mjs meta`: optional `--respect-requires` flag; adjusts scoring to penalize modules with unmet requires
  **Acceptance:**
* With `--respect-requires`, `compose.greedy.json` avoids unfulfillable picks.
* Examples still generate a valid plan.

---

## C8 — Lessons Miner

**Why:** roll residual risks/followups into durable memory.
**Deliverables:**

* `tm.mjs lessons mine --from <glob...> --out lessons.json`

  * Inputs: any `report.json` (implementer/meta/winner)
  * Output: `{followups[], residual_risks[]}` merged & deduped
* `docs/lessons.md`
  **Acceptance:**
* Running miner over examples yields a normalized `lessons.json`.
* Idempotent: re-running doesn’t duplicate entries.

---

## C9 — SafetyPort test pack

**Why:** harden platform edges (Windows/WSL/path).
**Deliverables:**

* `examples/modules/safety.validation/tests/spec_paths_windows.json`
* `examples/modules/safety.validation/tests/run_win_cases.mjs` (skips if not on Windows; returns pass on non-Windows to keep CI green)
* Guidance in `docs/tests.md` for platform-conditional tests
  **Acceptance:**
* Shipping gates pass on Linux/macOS; script gracefully reports skip on non-Windows.
* On Windows dev boxes, the runner executes real assertions.

---

## C10 — Winner packaging smoke

**Why:** ensure the winner is packable for downstream consumption.
**Deliverables:**

* `runtimes/ts/composer/index.mjs`: emit `winner/package.json` (private: true)
* `tm.mjs gates shipping`: optional `--npm-pack` flag → run `npm pack` in `winner/` and delete the tarball after
* `docs/composer.md` add “pack smoke” notes
  **Acceptance:**
* `--npm-pack` succeeds in examples; failure blocks gates.

---

## C11 — Compose overrides

**Why:** let humans tweak a generated plan without editing the original compose file.
**Deliverables:**

* `tm.mjs compose --overrides <file>`:

  * Merge-in fields: replace/append `modules[]`, `wiring[]`, `constraints[]`
* `docs/composer.md` section “overrides”
  **Acceptance:**
* Overrides file can swap a module provider or add a constraint; validation still enforced.

---

## C12 — CI polish & speed

**Why:** keep PR signal fast and crisp.
**Deliverables:**

* `.github/workflows/ci.yml`:

  * split jobs: `schemas`, `composer+gates`, `rust-check`
  * cache Node modules and Cargo
  * add a step: `node tm.mjs gates shipping --emit-events --events-out artifacts/events.ndjson | jq -c . >/dev/null`
* Upload `artifacts/events.ndjson` on PRs
  **Acceptance:**
* CI time reduced vs current run; artifacts visible in PR checks.

---

## C13 — (Optional) MCP server façade for `tm`

**Why:** let agents call `tm` as a service.
**Deliverables:**

* `mcp/server.mjs` implementing tools:

  * `tm.meta(coverage) → compose`
  * `tm.compose(compose, modulesRoot) → report`
  * `tm.gates(mode, compose, modulesRoot)` → {pass/fail, events}
* `docs/mcp.md` quick wiring
  **Acceptance:**
* Local MCP client can call these and get JSON responses; mirrors CLI.

---

## C14 — Docs: “Contributor Playbook”

---

## AMR-UI — Workflow Console & Orchestrator

**Why:** give operators a visual cockpit for the AMR → Bo4 pipeline, with Codex-assisted authoring so they can tune the process without leaving the UI.

**Deliverables:**

* `rcm/rcm.json` updated with UI-centric requirements (visual workflow, configurable variant counts, Codex-assisted authoring, run history).
* Bo4-A slates (`amr/slates/var1..var4/`) proposing architecture, schemas, acceptance loops, and UX notes for the console.
* `docs/amr.md` appendix capturing UI-specific gates/telemetry expectations.

**Acceptance:**

* UI surfaces every stage of AMR/Bo4 with status, prerequisites, and artifacts.
* Operators can adjust variant count, brief depth, reviewer bots, and follow-up policy before kickoff.
* Codex embeds into the UI so users can draft briefs/requirements and push updates back to the canon.
* Run history persists so past attempts (config + results + risks) can be replayed or reused.

**Test:**

1. Capture a fresh RCM + slates for the UI console and run `node scripts/rcm-ssd-check.mjs --rcm rcm/rcm.json --trace amr/traceability.map.json --slates amr/slates --out amr/ssd.json --fail-low 0.75`.
2. Once a canon is frozen, ensure the UI mock consumes the resulting `amr/architecture.json` and renders the workflow swimlane end-to-end.

**Why:** lower friction for new contributors.
**Deliverables:**

* `docs/contributor-playbook.md` end-to-end:

  * add module → run conceptual → run shipping → open PR
  * common errors & how to fix (schema, ports, tests, lint)
    **Acceptance:**
* Document links validated; referenced commands exist.

---

### Suggested order to hand to Codex CLI

1. **C1, C2, C3** (type-safe shipping, ESLint lint, port conformance)
2. **C4, C5** (composer stricter + event schema/sink)
3. **C6, C7** (prompt packs)
4. **C8, C9, C10** (lessons miner, safety pack, winner pack smoke)
5. **C11, C12** (overrides + CI polish)
6. **C13, C14** (MCP façade + playbook)

---

## E1 — Meta Scorer v1 (+ Profiles)

**Why:** replace the simple greedy scorer with a weighted, deterministic selector.

**Deliverables:**

- `tm.mjs meta`: feasible-greedy scoring that considers coverage contribution, evidence strength, risk, delta cost, and hygiene while enforcing `requires[]` and duplicate-provider feasibility.
- `meta/weights.json`: named profiles (`conservative`, `fast`, `evidence-heavy`) plus CLI switches `--profile` / `--weights`.
- Event telemetry: emit `META_PICK` with `{ module, gain, drivers }` and document usage.

**Acceptance:**

- Identical coverage inputs and profile flags produce the same `compose.json`.
- Switching profiles changes selection as documented; events stream highlights scoring drivers.

---

## E2 — Headless Codex Cloud Kit (Integrated)

**Why:** automate the BO4 loop (watch → harvest → meta → compose → gates → apply) with durable artifacts.

**Deliverables:**

- Scripts: `codex-watch.mjs`, `bo4-harvest.mjs`, `bo4-meta-run.mjs`, `bo4-compose.mjs`, `bo4-apply.sh`.
- Run manifest: `runs/<task_id>/run.json` capturing task metadata, hashes, and artifact pointers.
- Documentation: `docs/headless-cloud.md` describing the 10-step loop and run directory.
- CI job that exercises the miniature headless flow on the examples.

**Acceptance:**

- A single command executes watch→harvest→meta→compose→gates and persists artifacts under `runs/<task_id>/`.
- Variants missing module deliverables fail early with `E_VARIANT_NO_MODULES`.
- CI exposes stored artifacts (events, reports, winner) together with the manifest.

---

## E3 — Events Validator & Replay

**Why:** guarantee telemetry integrity and enable replayable timelines.

**Deliverables:**

- `tm events validate --in artifacts/events.ndjson --strict`: schema + monotonic `seq` + hash verification.
- `tm events replay --in artifacts/events.ndjson`: concise timeline (starts, picks, durations, failures) written to stdout and `artifacts/timeline.txt`.
- CI steps to validate and replay the example runs.

**Acceptance:**

- Malformed or out-of-order events raise `E_EVENT_SCHEMA` with line context.
- Replay output is deterministic; CI uploads both `events.ndjson` and `timeline.txt`.

---

## E4 — Oracles: Determinism & Idempotence (Opt-in Gate)

**Why:** detect non-deterministic behaviour before shipping.

**Deliverables:**

- Oracle specs under `oracles/specs/*.json` plus guidance in `docs/oracles.md`.
- `tm oracles run --modules-root <dir> --spec oracles/**.json` for determinism/idempotence checks.
- Gate hook: `tm gates shipping --with-oracles` emitting `ORACLE_START/PASS/FAIL` events.

**Acceptance:**

- Flaky fixtures fail with `E_ORACLE_DETERMINISM`/`E_ORACLE_IDEMPOTENCE`; deterministic modules pass.
- Examples succeed when oracles are enabled; docs explain how to add new specs.

---

## E5 — Side-Effects Enforcement

**Why:** ensure modules only perform declared side effects.

**Deliverables:**

- Runtime wrapper that records filesystem writes and process spawns during gates.
- Comparison against `module.json.side_effects`, failing with `E_SIDEEFFECTS_DECLARATION` / `E_SIDEEFFECTS_FORBIDDEN` when mismatched.
- Documentation describing declarations, violations, and remediation steps.

**Acceptance:**

- Modules that produce side effects without declaring them fail shipping gates with the new error codes.
- Properly declared modules continue to pass.

---

## E6 — Port Version Negotiation

**Why:** support multiple port majors safely.

**Deliverables:**

- Composer policy resolving providers by `PortName@major`, honouring `preferred_providers`/wiring, and emitting `E_PORT_VERSION_AMBIG` when unresolved.
- `--explain` output listing chosen providers and rationale.
- Documentation updates in `docs/composer.md`.

**Acceptance:**

- Mixed majors without explicit preferences fail with `E_PORT_VERSION_AMBIG`.
- Plans that specify wiring/constraints pass with clear explain output.

---

## E7 — SafetyPort Deep Suite

**Why:** harden SafetyPort across Windows/WSL/macOS/Linux edge cases.

**Deliverables:**

- Expanded fixtures in `examples/modules/safety.validation/tests/` (UNC paths, symlinks, case-insensitive FS, etc.).
- Conditional runners emitting `TEST_SKIPPED` events when a platform cannot execute specific cases.
- Documentation in `docs/tests.md` covering execution and skip semantics.

**Acceptance:**

- Shipping gates pass on Linux/macOS while real assertions run on Windows.
- Skip events appear in telemetry when a platform lacks support; overall verdict remains PASS.

---

## E8 — Performance & Caching

**Why:** keep validation fast as the repo scales.

**Deliverables:**

- ESLint caching and TypeScript incremental builds wired into shipping gates.
- Composer smart copy (hash compare) for `winner/`.
- Event durations (`detail.dur_ms`) plus per-gate summaries; CI baseline comparisons.

**Acceptance:**

- A second run on unchanged examples is at least 30 % faster thanks to caching.
- Events and CI logs show duration metrics without regressing gate behaviour.

### Implementation briefs stage

Before handing cards to cloud implementers, Codex CLI now produces a concrete implementation brief per wave: scope, file touchpoints, acceptance criteria, event expectations, and coordination notes. See `docs/implementation-briefs.md` for the current wave.
