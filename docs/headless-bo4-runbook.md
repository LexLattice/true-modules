# Headless BO4 Operations Runbook

Codifies the tournament-to-merge workflow so every Best-of-4 (BO4) task follows the same script. Use this alongside `docs/headless-cloud.md` (automation mechanics) and `docs/implementation-briefs.md` (prompt source).

## Pre-flight checklist

- Confirm the implementation brief for the current task lives in `docs/implementation-briefs.md` (or supplied external draft) and is finalized.
- Ensure Codex Cloud access and CLI are configured; see `docs/headless-cloud.md` for environment setup.
- Pick or create a run slug under `runs/` and stage the helper scripts (`scripts/bo4-*.mjs`, `scripts/codex-watch.mjs`) if missing.

## Workflow (12 steps)

1. **Author / verify briefs**  
   - Finalize the task cards in `docs/implementation-briefs.md`. These verbatim prompts feed the BO4 kickoff. Keep acceptance criteria concrete (files, events, gating).

2. **Launch BO4 tournament**  
   - Run `codex cloud new` with `--best-of 4`, prompt from the finalized brief, and record the reported `task_id`. Append metadata to `.codex/bo4_runs.jsonl` per `docs/headless-cloud.md`.

3. **Watch task progress**  
   - Use `node scripts/codex-watch.mjs <task_id> --run-dir runs/<slug>` to poll until the task reaches `ready|error`. Events stream into `runs/<slug>/artifacts/events.watch.ndjson`.

4. **Harvest variant payloads**  
   - Run `codex cloud export --variant N --dir ../.codex-cloud/variants/<task_id>/varN/ <task_id>` for each finished attempt. Keep exports outside the repo so the worktree stays clean; inside `runs/<slug>/variants/varN.json` record metadata (variant index, paths, notes).
   - Each export contains `patch.diff` and `report.json`; these are the materials for meta review (ignore the default report from `codex cloud export`).

5. **Stage meta inputs**  
   - Ensure coverage and other scoring inputs exist (e.g., copy `coverage.json` into `runs/<slug>/meta/coverage.json` if not already).

6. **Run meta-review pass**  
   - Invoke `node scripts/bo4-meta-run.mjs <task_id> --run-dir runs/<slug>`. This wraps `tm meta` and writes `runs/<slug>/meta/{coverage.json,compose.json,report.json}`.
   - Evaluate each variant against the original brief: confirm deliverables, check evidence, enforce acceptance criteria. Use the `report.json` inside each harvested variant as the meta reviewer’s payload.
   - Decide the winning variant and note any follow-up imports needed from the other three variants.

7. **Compose winner + gates**  
   - Run `node scripts/bo4-compose.mjs --run-dir runs/<slug> --variant <winner_index>`. This builds `runs/<slug>/winner/` and runs `tm gates shipping --emit-events --strict-events`.
   - If TypeScript/ESLint errors appear, review logs under `runs/<slug>/winner/.tm/`.

8. **Draft follow-up prompt (if imports needed)**  
   - When the winner lacks desirable changes from other variants, craft a follow-up prompt referencing specific files/diffs. Use the implementation brief plus your meta notes as guidance.
   - Record the follow-up text alongside the run (e.g., `runs/<slug>/meta/followup.txt`) for provenance.
   - Phrase the follow-up as a standalone request: describe only the functionality or files that need changes, and avoid mentioning other variants or prior attempts (individual variants are unaware of sibling work).

9. **Trigger turn-2 completion**  
   - Send the follow-up prompt to Codex Cloud using the existing `task_id` (variant continues the same tournament). After the sole turn-2 variant lands, rerun `node scripts/bo4-harvest.mjs <task_id> --run-dir runs/<slug>`; the script overwrites `varN/` with the latest payload so the new diff/report is captured. If manual inspection is needed, call `codex cloud export --turn 2 --variant <winner_index> --dir <path> <task_id>`.
   - Verify the turn-2 payload satisfies the follow-up requirements.

10. **Create and review the PR**  
    - From Codex Cloud, open the PR based on the winning turn-2 variant. Sync the branch locally (`git fetch` the cloud-generated branch).
    - Inspect bot reviews: Codex/Gemini comments arrive as replies to primary review threads. Resolve issues, run `tm gates shipping --emit-events` locally as needed, and apply outstanding fixes.

11. **Update records**  
    - Append an entry to `docs/meta-history.md` summarizing: winning variant ID, rationale, imports pulled, why others fell short, review feedback addressed, tradeoffs, residual risks, follow-ups. Link back to the run slug and any follow-up prompt files.

12. **Finalize and merge**  
    - Push updates, ensure CI passes, respond to remaining review threads, and merge the PR into `main`. Tag the run as complete in `.codex/bo4_runs.jsonl` (if tracked) and archive any local artifacts.

## Quick command recap

```
# Launch
codex cloud new --env ENV --base main --best-of 4 --prompt "$(cat docs/implementation-briefs.md | ...)"  # extract task prompt

# Watch
node scripts/codex-watch.mjs task_abc123 --run-dir runs/2024-07-01-demo

# Harvest
node scripts/bo4-harvest.mjs task_abc123 --run-dir runs/2024-07-01-demo

# Meta
node scripts/bo4-meta-run.mjs task_abc123 --run-dir runs/2024-07-01-demo

# Compose + gates
node scripts/bo4-compose.mjs --run-dir runs/2024-07-01-demo --variant 3

# Follow-up note (example manual)
cat <<'EOF' > runs/2024-07-01-demo/meta/followup.txt
...
EOF
```

## References

- `docs/headless-cloud.md` — automation details for watch/harvest/meta/compose/gates.
- `docs/implementation-briefs.md` — canonical BO4 prompts and acceptance criteria.
- `docs/meta-history.md` — prior tournament decisions and import notes (use for follow-up formatting).
- `.codex-cloud/variants/<task_id>/` — harvested variant payloads (outside repo root).
