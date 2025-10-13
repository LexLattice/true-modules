# Meta History

Records of tournament outcomes and review insights once a pull request wraps. Each entry captures the winning variant, the key rationale, notable imports, and review feedback so we can reuse what worked (and avoid what didn’t) on future waves.

## C7 — Meta Prompt Pack++
- **Winner**: `var4` (branch `var4-base`, commit `d06a547d95f0f1bce33158ccacecc0bbb095ba0b`)
- **Why it won**:
  - Enforced port-level dependency checks in the greedy solver, matching the updated prompt expectations.
  - Added explicit confidence, residual risk, and rejection tracking across the rubric, schema, and templates.
  - Preserved coverage/examples so meta reviewers can run `node tm.mjs meta --respect-requires` without manual edits.
- **Imports pulled in**:
  - From `var1`: richer scorecard fields (facet rationales, default `rejected_alternatives` entries).
  - From `var2`: dependency bundling logic to auto-include required providers.
  - From `var3`: deduplication guard to avoid emitting the same module ID twice.
- **Why other variants fell short**:
  - `var1` matched `requires[]` against module IDs instead of ports, so dependencies never resolved.
  - `var2` abandoned candidates when multiple providers existed; it also relied on module-name resolution, so port requirements still failed.
  - `var3` normalized dependency checks to base module names, leading to false negatives and schema mismatches (`follow_ups` typo).
- **Review feedback addressed**:
  - *Codex*: Updated `spec/report.schema.json` so `rejected_alternatives` accepts `{variant, reason, confidence}` objects.
  - *Gemini*: Adjusted solver to choose the best provider (risk/evidence heuristic) instead of failing on ambiguity, and added duplicate-provider penalties during gain calculation.
- **Tradeoffs**: Skipping modules until dependencies are satisfied may leave certain goals uncovered without additional providers, but keeps plans dependency-safe.
- **Open questions**: Should the planner automatically discover manifests when coverage omits provides_ports metadata?
- **Residual risks**: Coverage producers that omit provides_ports/requires will see their modules dropped under --respect-requires.
- **Follow-ups / TODOs**: Consider adding manifest discovery so the meta solver can infer dependencies when annotations are missing.

## C8–C10 — Lessons Miner · SafetyPort Pack · Winner Pack Smoke
- **Winner**: `var1` (branch `var1-base`, commit `c2e593c38202cc4072f4a79a352a25d3a99f49a2`)
- **Why it won**:
  - Shipped the new `tm lessons mine` CLI plus docs/fixtures so follow-ups and residual risks collapse into a deterministic JSON feed.
  - Hardened the SafetyPort example for Windows (normalisation + reserved-device guards) and added the platform-specific harness that exercises real cases on Windows but skips cleanly elsewhere.
  - Added optional `--npm-pack` smoke in shipping gates and taught the TypeScript composer to emit winner/package.json, keeping packaging checks fast and cleanup automatic.
- **Imports pulled in**:
  - From `var2`: richer npm-pack telemetry (NPM_PACK_* events, summary wiring, tarball cleanup) and the improved Windows harness that locates the module via `__dirname`.
- **Why other variants fell short**:
  - `var2` mixed in a second lessons implementation that depended on the `glob` package and left dead CLI helpers behind.
  - `var3` only normalised Windows paths; its `isSafe` logic still allowed UNC/relative inputs, so Windows tests never caught unsafe cases.
  - `var4` skipped the SafetyPort changes entirely, so the Windows fixtures wouldn’t validate anything.
- **Review feedback addressed**:
  - Removed the duplicate lessons-helper block and the unused `npmPackSmoke` stub (Gemini caught both) and dropped the `glob` dependency.
  - Outstanding: tighten `globHasWildcards` to match the supported syntax and trim the unreachable check in the SafetyPort path logic (tracked for the next patch).
- **Tradeoffs**: Custom glob expansion avoids new dependencies, but only supports `*`/`?`; more complex patterns still require manual curation.
- **Open questions**: Confirm npm-pack smoke and the Windows harness on a native Windows runner, and decide if lessons should attribute follow-ups to source reports.
- **Residual risks**: npm-pack smoke skips when npm is absent, so packaging gaps can hide on stripped environments.
- **Follow-ups / TODOs**:
  - Exercise the Windows SafetyPort pack in CI (docs/report.json).
  - Extend the lessons miner with source attribution for follow-ups/residual risks.
  - Align the glob helper and SafetyPort guard per outstanding review notes.

## C11–C12 — Compose Overrides · CI Polish
- **Winner**: `codex/add-override-file-support-for-composed-plans` (commit `15479f3116585ceb08476fdd8e65e3d3ec007455`)
- **Why it won**:
  - Added `--overrides` support end-to-end (`tm compose` + `tm gates`), including module/wiring removal, deterministic ordering, winner `compose.merged.json`, and `COMPOSE_OVERRIDES_APPLIED` telemetry that stays on stderr when events stream.
  - Documented override semantics, shipped the `examples/compose.overrides/` fixture, and ensured winner reports mirror the merged plan.
  - Split CI into `schemas`, `composer_gates`, and `rust_check` jobs with dependency-aware caching for Node (`~/.npm`, `node_modules`) and Cargo (`~/.cargo`, `target`).
  - Restored the duplicate-provider failure/resolution checks and TypeScript composer scaffold inside CI, while validating override/gates NDJSON streams and exporting a parsed override summary artifact.
- **Imports pulled in**: N/A (feature work on mainline scaffolds).
- **Why other variants fell short**: N/A (single-track delivery).
- **Review feedback addressed**:
  - Routed override summaries through the event emitter’s `info` channel so NDJSON output stays clean under `--emit-events`.
  - Added artifact capture for override details and regrouped CI logging for easier audit review.
- **Tradeoffs**: Override removals still use ad-hoc markers (`"-module"` strings, `{remove:true}` wiring flags); a future schema might expose first-class delete semantics.
- **Open questions**: Should overrides eventually cover glue/run metadata, and do we surface override diffs directly in winner artifacts beyond the CI summary?
- **Residual risks**: Cached `node_modules`/Cargo targets can drift if lockfiles change without cache busting; ensure keys stay aligned.
- **Follow-ups / TODOs**:
  - Monitor override usage patterns to decide whether CLI should emit a structured diff artifact (beyond CI) or accept layered override files.
