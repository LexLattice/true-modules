# Oracles and Side-Effect Guards

True Modules now ships a determinism oracle runner and a side-effect guard that are available both as a standalone CLI entry point and as an optional shipping gate. The goal is to guarantee that repeatable behaviour stays repeatable, and that modules accurately declare every privileged capability they exercise.

## Running oracles manually

Use the new `tm oracles run` command to execute oracle specs:

```sh
# Run every oracle spec under the repository's oracles/specs/ folder
node tm.mjs oracles run --modules-root examples/modules
```

The command resolves one or more glob patterns (defaults to `oracles/specs/**/*.json`), loads each JSON spec, validates it against `spec/oracle.schema.json`, and repeatedly executes the declared cases. Every run is executed under the side-effect guard, so filesystem writes and spawned processes are recorded and validated against the module's `module.json.side_effects` declaration. When any attempt exits non-zero, emits different output, or produces divergent captured artifacts, the runner raises `E_ORACLE_EXEC`/`E_ORACLE_NONDETERMINISM` with details about the failing case. If no specs match the requested patterns the CLI prints a skip notice and exits successfully.

### Spec format

Oracle specs live in `oracles/specs/*.json`, are validated by `spec/oracle.schema.json`, and contain a module identifier with an array of cases:

```jsonc
{
  "module": "git.diff.core",
  "cases": [
    {
      "name": "repeatable-io",
      "entry": "tests/oracle_repeatable.mjs",   // Node entry point relative to the module root
      "cwd": "tests",                            // optional working directory (defaults to module root)
      "args": ["--moduleRoot", "."],            // forwarded to the script
      "repeat": 3,                               // minimum attempts; defaults to 2
      "reset": ["oracle-output.txt"],           // files/dirs (relative to cwd) removed before each attempt
      "capture": {
        "stdout": true,                          // capture stdout (default: true)
        "stderr": true,                          // capture stderr (default: true)
        "files": ["oracle-output.txt"],         // files to snapshot after each run (base64 encoded)
        "side_effects": true                    // compare side-effect transcripts (default: true)
      }
    }
  ]
}
```

Each case is executed at least twice (or `repeat` times if larger). After every attempt the runner captures stdout/stderr, requested files, and the observed side-effects. If any subsequent run differs from the first in any captured dimension, the oracle fails with `E_ORACLE_NONDETERMINISM`. Specs can be organised however you like; pass multiple `--spec` flags to merge globs. Malformed specs fail fast with `E_ORACLE_SPEC` before any scripts execute, reporting the schema validation errors that must be addressed.

## Shipping gate integration

`tm gates shipping` gained a `--with-oracles` flag that executes all oracle cases whose `module` matches the active compose plan. You can override the spec glob with repeated `--oracle-spec` flags:

```sh
node tm.mjs gates shipping \
  --compose examples/compose.json \
  --modules-root examples/modules \
  --with-oracles \
  --oracle-spec "oracles/specs/**/*.json"
```

During shipping gates we emit the following telemetry:

- `ORACLE_START` / `ORACLE_PASS` / `ORACLE_FAIL` for each case.
- `TEST_PASS` / `TEST_FAIL` events include a `side_effects` payload summarising observed filesystem writes and spawned processes for the test run.
- `SIDEEFFECTS_SUMMARY` is emitted once per module after all shipping tests complete, and the gate summary now contains a `side_effects.modules[<module>]` block with declared operations, observed categories, whether any writes escaped the module root, and sample paths/commands.
- On success we add an `oracles` summary block with total cases/attempts/specs; on failure the gate terminates with the oracle's error code.

If no specs matched the selected modules the gates log a skip and continue.

## Side-effect guard & new error codes

Every module test and oracle attempt runs under a side-effect guard that wraps Node's filesystem and child-process APIs. The guard records:

- Filesystem writes/removes (writeFile, appendFile, rm, rename, mkdir, createWriteStream, etc.).
- Process launches (`spawn`, `exec`, `execFile`, `fork`, …) with the resolved command.

After each run we compare the transcript against the module manifest and record the results in the telemetry + gate summary:

- `E_SIDEEFFECTS_DECLARATION` — the module wrote to disk or spawned a process without declaring the corresponding capability (e.g. missing `FS:write` or `Process:shell`).
- `E_SIDEEFFECTS_FORBIDDEN` — the module wrote outside its own root directory.

For passing tests the guard still reports which side effects were observed so operators can audit manifest declarations. These checks run for both regular shipping tests and oracle attempts, so failing to declare a side effect will break both flows. Remember to add `FS:write` or the appropriate `Process:*` entry to `module.json` when your code needs it.

## Example specs

Two example specs ship with the repository:

- `git.diff.core` includes deterministic cases and a repeatable file-write oracle to demonstrate success.
- `git.diff.alt` includes a deliberately nondeterministic oracle that fails with `E_ORACLE_NONDETERMINISM`, illustrating how to catch flaky behaviour.

Use these examples as templates when authoring new oracles for modules under test.
