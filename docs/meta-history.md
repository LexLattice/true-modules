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

## C13–C14 — MCP Façade · Contributor Playbook (Follow-up)
- **Winner**: `codex/implement-mcp-facade-documentation-and-tools` (commit `9e5f75dac4f1646c543caf8e6316a51c35234315`)
- **Why it won**:
  - Extended `mcp/server.mjs` with optional `respectRequires`, overrides, and `strictEvents`, aligning agent workflows with CLI behavior.
  - Hardened error handling so responses always include CLI context, structured error codes, and gate events—even when commands fail.
  - Published detailed façade docs (`docs/mcp.md`) and a four-phase contributor playbook so humans and agents share the same validation loop.
- **Imports pulled in**: N/A (iteration on the Wave 6 façade).
- **Why other variants fell short**:
  - `var2` required the MCP SDK during offline `npm ci`, breaking sandbox installs.
  - `var3` returned bare compose JSON from `tm.meta`, violating the documented `{ compose: … }` envelope.
  - `var4` reimplemented MCP framing manually, diverging from the official SDK’s transport and schema validation.
- **Review feedback addressed**:
  - Clarified docs/tests that strict events are opt-in and tightened messaging about the SDK fallback.
  - Updated the stub server to store tool definitions so schema issues surface during offline testing.
- **Tradeoffs**: Exposing CLI args/stdout/stderr in MCP errors accelerates debugging but can leak absolute paths in agent logs.
- **Open questions**: Should we add automated MCP integration tests once the SDK is vendored, and do we want to emit override diff artifacts outside CI summaries?
- **Residual risks**: Agents still need to install the real SDK when network access returns; stub mode can mask transport mismatches until then.
- **Follow-ups / TODOs**:
  - Land a lightweight MCP smoke test (docs or CI) to keep `respectRequires`/`overrides`/`strictEvents` exercised.
  - Evaluate vendoring or pinning the MCP SDK to avoid future install drift.

## E1–E3 — Meta Scorer v1 · Events Validate/Replay
- **Winner**: `codex/implement-deterministic-meta-scorer` (commit `600fce7f8dbf6b6f0cf83f98a4eb2ed1f3fd5d6e`)
- **Why it won**:
  - Refactored `tm meta` into a feasible-greedy scorer with profile-driven weights, deterministic tie breakers, and `META_PICK` telemetry that captures gain drivers.
  - Added `tm events validate`/`tm events replay` commands plus CI checks that diff consecutive runs and publish meta/gate timelines for auditability.
  - Expanded documentation (`docs/meta-scorer.md`, `docs/events.md`) and sample NDJSON so operators and agents can consume the new workflows.
- **Imports pulled in**: Built on the Wave 7 v1 design; no external imports.
- **Why other variants fell short**:
  - `var2` skipped archiving replay output and left documentation light.
  - `var3` lacked the replay helper and didn’t integrate validation with the sample NDJSON.
  - `var4` reverted to manual checks without the new commands or deterministic profiles.
- **Review feedback addressed**: Made the meta `run_id` deterministic so CI diffs pass, per Gemini/Codex review and failing CI logs.
- **Tradeoffs**: Running meta twice adds minor CI time but guarantees deterministic output; verbose errors surface absolute paths in logs.
- **Open questions**: Should we add broader coverage fixtures for determinism tests and retain diffs when failures occur?
- **Residual risks**: The example coverage set may not cover every edge case; future changes must regenerate baselines when behaviour shifts.
- **Follow-ups / TODOs**:
  - Capture additional coverage fixtures for determinism validation.
  - Consider archiving meta diff outputs to ease debugging when CI fails.

## E2 — Headless Codex Cloud Kit
- **Winner**: `codex/implement-headless-bo4-execution-pipeline` (commit `bc2eb7810533c0e596d9bb21bbb9bad03b1e4ec0`)
- **Why it won**:
  - Delivered the full watcher → harvest → meta → compose → gates loop as standalone scripts (`codex-watch.mjs`, `bo4-harvest.mjs`, `bo4-meta-run.mjs`, `bo4-compose.mjs`, `bo4-apply.sh`) with a shared `run.json` manifest and hardened module validation (`E_VARIANT_NO_MODULES` exits).
  - Added an orchestrator (`bo4-loop.mjs`) plus CI coverage (`headless_cloud` job) that runs against a stubbed Codex Cloud (`CODEX_BIN=node scripts/tests/codex-cloud-stub.mjs`) and validates event telemetry.
  - Documented the workflow (`docs/cloud-headless.md`) and clarified that exported variants live under `.codex-cloud/variants/<task_id>/varN/` to keep the repo clean while maintaining durable artifacts.
  - Shored up the CLI after review: removed `shell: true` spawns, introduced `resolveCommand` so multi-word `CODEX_BIN` values work safely, and extracted a reusable manifest helper for the apply script.
- **Imports pulled in**: Borrowed the recursive True Module checks and winner selection rationale from the stronger Wave 8 submissions while retaining var2’s manifest structure and CI job skeleton.
- **Why other variants fell short**:
  - `var1` required a caller-supplied modules path and `rsync`’d the winner into the repo root, making it unsafe for automation.
  - `var3` overwrote watcher telemetry during gates and never recorded `compose_sha256` at the manifest root.
  - `var4` left modules outside the manifest, demanded manual `--modules-root`, and didn’t integrate the headless loop into CI.
- **Review feedback addressed**:
  - Resolved security concerns by eliminating shell-based spawns and adding the new command resolver.
  - Seeded deterministic fixtures under `examples/cloud-stub/variants/var0/` with matching coverage (`examples/coverage.json`) so the CI job stops looping.
  - Updated `.gitignore` and docs to account for the out-of-repo variant archive while still tracking the stub fixtures needed for tests.
- **Tradeoffs**:
  - The command splitter is intentionally simple; complex quoting (nested quotes, environment substitutions) will need future hardening.
  - The stub variant reuses production module sources, increasing fixture surface area but allowing end-to-end smoke tests without Codex Cloud access.
  - Storing artifacts under `.codex-cloud` avoids repo churn at the cost of extra coordination when other tools expect in-repo diffs.
- **Open questions**:
  - Should we add automated cleanup or rotation for `.codex-cloud/variants` to avoid stale artifacts?
  - Do we want richer stub tasks (multiple variants, failure cases) to exercise branching paths in CI?
- **Residual risks**:
  - Changes to module IDs or coverage goals require manual fixture regeneration; CI will fail noisily if the stub drifts.
  - `resolveCommand` currently handles only basic whitespace/quote patterns; unusual shells or Windows paths may still break.
- **Follow-ups / TODOs**:
  - Capture at least one failing/headless gate scenario in fixtures to keep the error-path logic tested.
  - Explore packaging a helper that syncs `.codex-cloud` artifacts to cloud storage for longer-term retention.
  - Consider wiring a smoke test that runs `bo4-apply.sh` in mock mode to verify manifest parsing and branch creation do not regress.
