# Headless Codex Cloud Loop

The `bo4` toolchain runs the best-of-four pipeline without opening the Codex
TUI.  Everything lands inside a timestamped run directory under `runs/`.  The
loop is safe to run from CI, emits strict `tm-events@1`, and keeps a manifest
(`run.json`) with stable pointers to artifacts.

## 10-step checklist

1. **Bootstrap a run directory** – pick a task id and create a slug: the helper
   (`scripts/bo4-loop.mjs`) does this automatically.
2. **Watch Codex Cloud** – `scripts/codex-watch.mjs` polls `codex cloud list` and
   appends heartbeat events into `artifacts/events.ndjson` until the task is
   `ready` or `error`.
3. **Persist manifest state** – every stage updates `runs/<slug>/run.json` with
   timestamps, chosen variant and artifact paths.
4. **Harvest variants** – `scripts/bo4-harvest.mjs` pulls each ready variant via
   `codex cloud export`, stores metadata (`variant.json`) and the diff patch, and
   fails fast with `E_VARIANT_NO_MODULES` when `modules/` is missing.
5. **Snapshot coverage** – copy `coverage.json` into `meta/coverage.json` so the
   run directory stays self-contained.
6. **Run meta scoring** – `scripts/bo4-meta-run.mjs` invokes `tm meta`, records
   `meta/compose.json`, emits meta events, and computes `compose_sha256` for the
   manifest (rewriting watch events so the context matches the final compose
   hash and run id).
7. **Compose winner scaffolding** – `tm compose` assembles `runs/<slug>/winner/`
   using the harvested module tree for the selected variant.
8. **Ship gates headlessly** – `tm gates shipping --emit-events` writes
   `artifacts/events.gates.ndjson`; the compose helper merges these with the
   earlier watch heartbeats into a resequenced `artifacts/events.ndjson`.
9. **Inspect the manifest** – `run.json` tracks `task_id`, `compose_sha256`,
   selected variant, gate status, and paths (relative to the repo root) for
   every artifact.
10. **Apply or branch** – `scripts/bo4-apply.sh` either triggers
    `codex cloud apply ... --preflight` (single variant) or creates a
    `bo4/<task>/winner` git branch with the `winner/` tree staged for review.

## Run directory layout

A successful headless run ends up with the following tree:

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
    var0/
      diff.patch
      modules/
        ...
      variant.json
  winner/
    README.md
    report.json
```

Every path stored inside `run.json` is relative to the repository root so CI
jobs can upload artifacts directly.

## One-shot loop command

Run the entire watcher→harvest→meta→compose→gates pipeline in one command.  For
local development you can point `CODEX_BIN` at the stub shipped in this repo.

```bash
CODEX_BIN="node scripts/tests/codex-cloud-stub.mjs" \
node scripts/bo4-loop.mjs \
  --task demo-headless \
  --coverage examples/coverage.json
```

The command prints grouped logs for each stage and finishes with the manifest
location, ready for inspection or artifact upload.
