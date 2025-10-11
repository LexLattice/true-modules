# Headless Codex Cloud Loop (Codex CLI + BO4)

This note documents the workflow we use when Codex CLI (acting as the orchestrator) launches Best‑of‑4 tournaments on Codex Cloud. The loop keeps the entire flow deterministic and observable without relying on the interactive TUI.

## Roles involved

1. **Intent author** – prepares the prompt, target environment, base ref, and `best_of` count.
2. **Codex CLI (you + me)** – runs the headless loop below, coordinating with Codex Cloud.
3. **Codex Cloud** – executes the BO4 runs and returns variants.
4. **Meta reviewer (Codex Cloud coders + Codex CLI)** – evaluates variants, applies preflight checks, summarizes findings.

## Required tooling

- `codex cloud` CLI (part of the `codex-rs` repo, see `cli/src/cloud`).
- Access to the target Codex Cloud environment (you’ll need the environment ID or label).

## Loop overview

1. **Kickoff**
   ```bash
   codex cloud new \
     --env ENV_ID_OR_LABEL \
     --base main \
     --best-of 4 \
     --prompt "$(cat prompt.txt)"
   ```
   The command prints a `task_id` (e.g., `task_abc123`). Record it for the watcher.

2. **Watcher**
   - Start a background loop that polls `codex cloud list --json` every minute.
   - Filter for the target `task_id`.
   - Exit when the task reaches `ready` (success) or `error` (failed). On error, log and stop the loop.

3. **Harvest**
   ```bash
   codex cloud show task_abc123
   codex cloud diff task_abc123 --variant 2
   codex cloud export task_abc123 --variant 2 --out variants/var2
   ```
   - Inspect each returned variant (the CLI supports `--variant`, `--all`, and JSON output).
   - Collect diff, reports, and metadata for local review.

4. **Meta-review**
   - Feed the promising variant(s) into the local review pipeline:
     - Run diff analyzers / evidence checks.
     - Optionally run `codex cloud apply task_abc123 --variant 2 --preflight` to validate the patch.
     - Summarize findings (pass/fail, followups, residual risk) and pass them back to the intent owner.

5. **Rinse / retry**
   - If multiple variants look viable, repeat the meta-review step per variant before choosing one to apply.
   - If the task failed or needs iteration, adjust the prompt or environment and rerun `codex cloud new`.

## Automation tips

- **Watchdog script** – Codex CLI can run a simple shell loop or use a small Rust/Node helper to poll `codex cloud list --json` until completion.
- **Artifacts** – When harvesting variants, use `codex cloud export` to capture `patch.diff`, `report.json`, and `meta.json`. Version them under `variants/varN/`.
- **Integration with MCP** – Future iterations can expose this loop via the MCP server so ChatGPT can trigger Codex CLI tasks directly.
- ** Runbook log** – After kickoff, append a record to `.codex/bo4_runs.jsonl` in the repo with `{ "task_id": "...", "env": "...", "base": "...", "best_of": N, "prompt_file": "..." }`. This metadata drives downstream automation like branch creation and scoring scripts.

## Automation flow snapshot

1. **Kickoff**: prepare the intent doc (prompt, base, best-of) → `codex cloud new --best-of 4 …` and record the task ID/base branch in `.codex/bo4_runs.jsonl`.
2. **Watch**: poll `codex cloud list --json` periodically until the task status moves from `pending`/`in_progress` to `ready` or `error`.
3. **Variants sweep**: once `ready`, run `codex cloud show --json --all`; if any variant still reports `pending`/`in_progress`, keep polling `show --json --all` until every variant is terminal (`completed`/`failed`/`cancelled`).
4. **Branch prep**: for each completed variant, create a local branch from the recorded base and export/cache its diff.
5. **Apply**: apply each completed variant’s diff (or use `codex cloud diff/apply --variant N`), logging failures separately and skipping failed/cancelled variants.
6. **Handoff**: emit a brief report summarizing variant statuses, branch names, and apply outcomes; hand off to meta-review for deeper analysis/tests.


## References

- Codex Cloud headless commands live under `codex-rs/cli/src/cloud`.
- Run `codex cloud --help` for the full command tree and options.
