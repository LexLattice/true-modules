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
