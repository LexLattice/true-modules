# Lessons miner

The lessons miner aggregates follow-ups and residual risks captured in shipping and
postmortem reports into a durable JSON artifact. Use it to surface the highest
priority cleanup items after every run and to backfill `docs/meta-history.md`
with links to notable incidents.

Before drafting the next automation prompt, skim the latest `lessons.json` and
seed the brief with any open follow-ups. Replaying how past regressions were
resolved keeps the next iteration focused on high-signal fixes instead of
rediscovering the same pitfalls.

## Command

Run the miner with one or more glob patterns and an output file:

```bash
node tm.mjs lessons mine --from "docs/**/*.json winner/report.json" --out lessons.json
```

- `--from` accepts one or many glob patterns (space separated or repeated) and
  resolves each to matching `report.json` files.
- `--out` writes a normalized JSON document. Existing directories are created as
  needed.
- Missing or malformed reports emit warnings; the command only fails when no
  readable reports remain after filtering.

You can also wire a convenience script:

```jsonc
{
  "scripts": {
    "lessons": "node tm.mjs lessons mine --from \\\"docs/**/*.json winner/report.json\\\" --out lessons.json"
  }
}
```

## Output shape

The merged artifact is stable and deterministic so downstream automation can
version-control it safely:

```jsonc
{
  "followups": [
    { "title": "Backfill Windows SafetyPort gaps", "priority": "P1", "owner": "platform", "pointer": "docs/meta-history.md#2024-11-10" }
  ],
  "residual_risks": [
    "SafetyPort normalization accepts UNC paths"
  ]
}
```

- Follow-ups retain `title`, `priority`, `owner`, and `pointer` fields. Entries
  are deduplicated and sorted by priority, then by title.
- Residual risks are whitespace-normalized strings sorted alphabetically.

Cross-link the mined lessons to `docs/meta-history.md` to preserve context on
why each follow-up matters, especially when multiple reports highlight the same
risk.

## Automated mining

`scripts/lessons-auto.sh` wraps the miner so CI can refresh `lessons.json`
whenever `main` shifts. The `lessons.yml` workflow runs on every push, executes
`tm lessons mine --from "**/report.json" --out lessons.json`, and publishes the
result as an artifact (or commits it via a bot user if that option is enabled).

Treat the freshly mined file as required reading before you draft new AMR slates
or BO4 briefs:

- Pull high-priority follow-ups directly into the next brief or `rcm/rcm.json`.
- Convert lingering residual risks into acceptance criteria or explicit tests.
- Archive resolved entries in `docs/meta-history.md` so the miner stays focused
  on current gaps.

## Examples

Sample fixture reports live under `examples/lessons/` alongside the aggregated
`lessons.merged.json` output. Run the miner against that directory to verify
deduplication locally:

```bash
node tm.mjs lessons mine --from "examples/lessons/**/*.json" --out examples/lessons/lessons.merged.json
```

Re-running the command with the same inputs yields byte-identical output.
