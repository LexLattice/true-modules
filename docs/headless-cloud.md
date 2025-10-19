# Headless Codex Cloud Loop

This guide documents the headless Best-of-4 (BO4) workflow we run with Codex
Cloud. The goal is to launch tournaments, harvest variants, and drive shipping
gates without ever opening the interactive TUI, keeping the process
deterministic and fully observable from the Codex CLI.

## Roles and prerequisites

The loop touches several personas:

1. **Intent author** prepares the prompt, target environment, base ref, and
   desired `best_of` count.
2. **Codex CLI orchestrator** (you + me) executes the headless loop, supervises
   Codex Cloud, and records artifacts.
3. **Codex Cloud** runs the BO4 attempts and returns variant payloads.
4. **Meta reviewers** (Codex Cloud coders + Codex CLI) evaluate variants, run
   preflight checks, and write the final PR summary.

You will need:

- The `codex cloud` CLI (shipped from the `codex-rs` repo under `cli/src/cloud`).
- Access to the target Codex Cloud environment (environment ID or label).
- This repository’s helper scripts (`scripts/codex-watch.mjs`,
  `scripts/bo4-harvest.mjs`, `scripts/bo4-meta-run.mjs`,
  `scripts/bo4-compose.mjs`, `scripts/bo4-loop.mjs`, and `scripts/bo4-apply.sh`).

## End-to-end workflow

1. **Kickoff**  
   Start a task and capture its identifier:
   ```bash
   codex cloud new \
     --env ENV_ID_OR_LABEL \
     --base main \
     --best-of 4 \
     --prompt "$(cat prompt.txt)"
   ```
   The command prints a `task_id` (for example `task_abc123`). Record that value
   for the watcher, manifest, and later exports. Append the metadata to
   `.codex/bo4_runs.jsonl` so downstream automation knows which prompt, base,
   and `best_of` were used.

2. **Watch Codex Cloud**  
   Poll `codex cloud list --json` (via `scripts/codex-watch.mjs`) until the
   task transitions from `pending`/`in_progress` to a terminal state
   (`ready` or `error`). All heartbeat events should be written to
   `runs/<slug>/artifacts/events.watch.ndjson` and tagged with the final
   `compose_sha256` once the loop completes.

3. **Harvest variants**  
   Once the task reports `ready`, export each completed variant with:
   ```bash
   codex cloud export \
     --variant 2 \
     --dir ../../.codex-cloud/variants/task_abc123 \
     task_abc123
   ```
   > **Important:** The harvest stage must write variant payloads into
   > `.codex-cloud/variants/<task_id>/varN/`, a sibling of the repo root. Keeping
   > exports outside the git checkout prevents dirty worktrees while preserving
   > a durable archive for future review.

   Collect `patch.diff`, `report.json`, and any module trees from that external
   directory. Inside the repo, capture lightweight metadata (variant index,
   selected module list, manifest hash) so the run manifest can reference the
   exported payloads without checking them in.

4. **Meta-review and compose**  
   Feed promising variants into `tm meta` plus local analyzers, optionally run
   `codex cloud apply ... --preflight`, and compose the winner scaffold with
   `scripts/bo4-compose.mjs`.

5. **Ship headless gates**  
   Execute `tm gates shipping` with strict events to verify side effects, lint,
   and TypeScript checks in CI-safe fashion. Capture the events stream and gate
   summary for later replay.

6. **Rinse / retry**  
   If multiple variants succeed, evaluate each before selecting a winner. When
   the task fails or needs to iterate, adjust the prompt or environment and
   re-run `codex cloud new`.

## Operational checklist (10 steps)

The watchers and scripts turn the workflow above into a disciplined loop:

1. **Bootstrap a run directory** – choose a slug (the helper
   `scripts/bo4-loop.mjs` does this automatically) and create `runs/<slug>/`.
2. **Watch Codex Cloud** – `scripts/codex-watch.mjs` polls the API and appends
   heartbeat events to `artifacts/events.watch.ndjson` until the task is ready
   or errors out.
3. **Persist manifest state** – after every stage, update
   `runs/<slug>/run.json` with timestamps, selected variant, and artifact paths.
4. **Harvest variants outside the repo** – `scripts/bo4-harvest.mjs` exports
   each ready variant into `.codex-cloud/variants/<task_id>/varN/`, fails fast
   with `E_VARIANT_NO_MODULES` when the modules tree is missing, and writes
   in-repo metadata pointing at the external location.
5. **Snapshot coverage** – copy `coverage.json` into `runs/<slug>/meta/coverage.json`
   so the run directory remains self-contained for scoring.
6. **Run meta scoring** – `scripts/bo4-meta-run.mjs` invokes `tm meta`, records
   `meta/compose.json`, emits meta events, and rewrites earlier watch events so
   the context matches the final `compose_sha256` and `run_id`.
7. **Compose winner scaffolding** – `tm compose` assembles
   `runs/<slug>/winner/` using the harvested module tree and selected variant.
8. **Ship gates headlessly** – `tm gates shipping --emit-events` produces
   `artifacts/events.gates.ndjson`; the compose helper merges these with the
   watch heartbeats into a resequenced `artifacts/events.ndjson`.
9. **Inspect the manifest** – verify `run.json` captures `task_id`,
   `compose_sha256`, chosen variant, gate status, and relative paths for every
   artifact (including pointers into `.codex-cloud/variants/...`).
10. **Apply or branch** – `scripts/bo4-apply.sh` can trigger
    `codex cloud apply ... --preflight` (single winner) or create a
    `bo4/<task>/winner` git branch with the `winner/` workspace staged for PR
    review.

## Run directory layout

A successful run produces the following structure inside the repo:

```
runs/2024-07-01-demo-headless/
  run.json
  artifacts/
    events.ndjson
    events.gates.ndjson
    events.watch.ndjson
  meta/
    coverage.json
    compose.json
    meta.events.ndjson
    report.json
  variants/
    var1.json      # metadata pointing to ../../.codex-cloud/variants/<task_id>/var1/
  winner/
    README.md
    report.json
```

Variant exports live under `.codex-cloud/variants/<task_id>/varN/` alongside the
repository. The metadata file inside `runs/<slug>/variants/` stores the relative
path so CI jobs can upload summaries without committing large module trees.

## One-shot loop command

Run the entire watcher→harvest→meta→compose→gates pipeline through the helper:

```bash
CODEX_BIN="node scripts/tests/codex-cloud-stub.mjs" \
node scripts/bo4-loop.mjs \
  --task demo-headless \
  --coverage examples/coverage.json
```

The command prints grouped logs for each stage, updates `runs/<slug>/run.json`,
and leaves variant exports under `.codex-cloud/variants/...` ready for meta
review or application.

## Canon preflight hook (optional)

If the Codex Cloud environment supports post-run hooks, wire in the canon
verifier so failed stamps never surface as “ready”:

```bash
node tm.mjs gates shipping \
  --compose runs/<slug>/meta/compose.json \
  --modules-root modules \
  --canon-lock amr/canon.lock.json \
  --emit-events --events-out artifacts/events.ndjson --strict-events
```

The hook exits non-zero on canon or gating violations, keeping headless runs
blocked until the local self-check loop produces a PASS.

## References

- Codex Cloud CLI: run `codex cloud --help` for command trees and flags.
- `.codex/bo4_runs.jsonl` tracks BO4 prompts, bases, and best-of counts.
- Variant archives: `.codex-cloud/variants/<task_id>/varN/` (outside the repo root).
