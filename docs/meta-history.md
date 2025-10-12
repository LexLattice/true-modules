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

