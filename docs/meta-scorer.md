# Meta scorer (feasible greedy)

`tm meta` selects a deterministic compose plan from a coverage matrix by
combining coverage gain, evidence quality, risk, cost, and hygiene signals.
The scorer loads `coverage.json`, enforces module feasibility (all
`requires[]` satisfied without duplicate providers), and then applies a
feasible-greedy search until every goal is covered or no positive gain remains.

## Feature model

Each candidate bundle (a module plus any required providers) is evaluated with
these features:

| Feature | Description |
| --- | --- |
| `coverage_contribution` | Sum of uncovered goal weights unlocked by the bundle. |
| `evidence_strength` | Average `evidence_strength` from `coverage.json`. |
| `risk` | Average `risk` across modules in the bundle. |
| `delta_cost` | Sum of `delta_cost` (defaults to `1` when omitted). |
| `hygiene` | Average `hygiene` score (defaults to `0.5`). |

Weights for these features are loaded from `meta/weights.json`. Pick one of the
built-in profiles with `--profile` (`conservative`, `fast`, `evidence-heavy`)
or supply a custom JSON mapping via `--weights <file>`. Custom files can either
mirror the profile structure or contain a simple `{ feature: weight }` object.

Tie-breakers are deterministic: higher gain first, then higher evidence,
lower risk, lower delta cost, and finally lexicographic module id. For each
selection the scorer records the bundle that was added so downstream tooling can
replay the decision.

## Telemetry

When `--emit-events` (and optional `--events-out`) is enabled the scorer emits
`META_PICK` entries to the standard telemetry stream. Each event reports the
module id, gain, profile, and a `drivers` map with:

- `coverage_contribution` — cumulative uncovered goal weight unlocked.
- `coverage_goals` — goal identifiers newly satisfied by the bundle.
- `evidence_strength`, `risk`, `delta_cost`, `hygiene` — aggregated feature
  values after applying profile weights.
- `bundle` — the selected module plus any additional providers required for
  feasibility.

The events respect `--strict-events`; validation failures raise
`E_EVENT_SCHEMA` before any files are written. Recorded streams can be checked
with `tm events validate` and replayed with `tm events replay` to produce a
timeline suitable for CI artifacts.

## Example

```bash
node tm.mjs meta \
  --coverage examples/coverage.json \
  --profile fast \
  --out artifacts/compose.greedy.json \
  --emit-events \
  --events-out artifacts/meta.ndjson \
  --strict-events
```

Running the command above produces a deterministic `compose.greedy.json`,
records each pick as `META_PICK`, and stores the event stream in
`artifacts/meta.ndjson`. Re-running with the same coverage matrix and profile
will yield identical output.

## Determinism check

CI enforces determinism by running the scorer twice and diffing the resulting
compose plans. The same approach is available locally:

```bash
node tm.mjs meta \
  --coverage examples/coverage.json \
  --profile conservative \
  --out artifacts/meta.compose.first.json \
  --emit-events \
  --events-out artifacts/meta.events.ndjson \
  --strict-events
node tm.mjs meta \
  --coverage examples/coverage.json \
  --profile conservative \
  --out artifacts/meta.compose.second.json \
  --strict-events
diff -u artifacts/meta.compose.first.json artifacts/meta.compose.second.json
```

If the diff exits cleanly the run is deterministic. The saved
`artifacts/meta.events.ndjson` can then be validated with
`node tm.mjs events validate --in artifacts/meta.events.ndjson --strict` or
replayed to inspect the `META_PICK` timeline.
