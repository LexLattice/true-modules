# Gate Event Stream (`tm-events@1`)

Shipping automation relies on a structured telemetry stream emitted by
`tm gates`. When `--emit-events` is enabled the CLI writes line-delimited JSON to
stdout and (optionally) to a file sink via `--events-out`.

Each event conforms to `spec/events.schema.json` and carries a common envelope:

```json
{
  "schema": "tm-events@1",
  "event": "TEST_PASS",
  "ts": "2024-06-22T17:05:13.102Z",
  "seq": 12,
  "source": { "cli": "tm", "version": "0.1.0" },
  "context": {
    "run_id": "demo-run",
    "mode": "shipping",
    "compose_sha256": "3a6ce7..."
  },
  "detail": {
    "module": "git.diff.core",
    "test": "script:tests/run.mjs",
    "dur_ms": 942
  }
}
```

Events are emitted in a single monotonic sequence. Typical envelopes include:

- `GATES_START`/`GATES_PASS`/`GATES_FAIL` summarising the run (with `dur_ms`,
  `passed`, `failed`, and `code` when errors occur).
- `LINT_*`, `TEST_*`, and `TSC_*` capturing lint/test/type-check progress with
  durations and failure codes (`E_LINT`, `E_TEST`, `E_TSC`).
- `PORT_CHECK_*` tracing TypeScript harness generation for runtime ports.

## Strict validation

Use `--strict-events` to enforce schema compliance at emit-time. Violations
immediately abort the run with `E_EVENT_SCHEMA` so the pipeline never records
invalid telemetry. CI enables strict mode and validates the resulting NDJSON
artifact against `spec/events.schema.json`.

When strict mode is disabled (`--no-strict-events`), events are still emitted but
schema failures are ignored—handy for interactive debugging.

## File sink

`--events-out <file>` records the same NDJSON stream to disk. The file is
appended by default; add `--events-truncate` to overwrite instead. Directories
are created automatically, making it easy to stash events under `artifacts/`:

```bash
mkdir -p artifacts
node tm.mjs gates shipping \
  --compose compose.json \
  --modules-root modules \
  --emit-events \
  --events-out artifacts/events.ndjson \
  --strict-events
```

Each event may include an `artifact` pointer (for example the TypeScript log) so
automation can upload supporting evidence alongside the NDJSON file.

## META_PICK events

`tm meta` now emits `META_PICK` when greedy selection chooses a bundle. The
`detail` payload contains the module id, gain, profile, and driver stats so the
run can be replayed or analysed offline. CI validates this stream alongside the
gate telemetry to guarantee the meta scorer remains deterministic.

Example:

```json
{
  "event": "META_PICK",
  "detail": {
    "module": "git.diff.core@var4",
    "gain": 2.35,
    "profile": "fast",
    "drivers": {
      "coverage_contribution": 2,
      "coverage_goals": ["P3"],
      "evidence_strength": 0.8,
      "risk": 0.2,
      "delta_cost": 1,
      "hygiene": 0.5,
      "bundle": ["git.diff.core@var4", "safety.validation@var2"]
    }
  }
}
```

## Validating and replaying events

Two helper commands operate on the recorded NDJSON streams:

- `tm events validate --in <file> [--strict]` parses each line, enforces
  monotonic (or contiguous with `--strict`) `seq` values, and verifies that all
  entries share the same `context.compose_sha256`. The command fails fast with
  `E_EVENT_SCHEMA` and prints the offending line number.
- `tm events replay --in <file> [--out timeline.txt]` renders a stable
  human-readable timeline summarising starts, picks, gate durations, and the
  first failure per event type. The output is printed to stdout and written to
  the specified file (default `artifacts/timeline.txt`).

Example usage:

```bash
node tm.mjs events validate --in artifacts/events.ndjson --strict
node tm.mjs events replay --in artifacts/events.ndjson --out artifacts/timeline.txt
```

The replay output is ideal for CI artifacts and quick run diagnostics. Apply the
same commands to `artifacts/meta.events.ndjson` to review the `META_PICK`
timeline captured during composition.

## How to read the summary

`tm events summary --in artifacts/events.ndjson` computes aggregated metrics and
persists them to `artifacts/summary.json` and `artifacts/summary.md`. The CLI
also prints a compact TTY table so you can skim the highlights directly from
logs. Metrics include:

- **Gate durations** – total elapsed time along with lint, test, TypeScript, and
  port-check subtotals derived from the event stream.
- **Failure codes** – a histogram of `*_FAIL` codes for quick triage.
- **Slowest tests** – the top offenders by `dur_ms`, useful for spotting noisy
  regression suites.
- **Module results** – pass/fail counts per module covering tests and port
  checks.

Example output:

```text
# Gate Summary
## Gate durations

+-------------+---------------+
| Stage       | Duration (ms) |
+-------------+---------------+
| Total       | 3,276         |
| Lint        | 775           |
| Tests       | 1,371         |
| TypeScript  | 999           |
| Port checks | 0             |
| Other       | 0             |
+-------------+---------------+
```

CI workflows can upload `summary.md`, `summary.json`, and `events.ndjson` as
artifacts so anyone on the team can drill into the run without rerunning gates.
