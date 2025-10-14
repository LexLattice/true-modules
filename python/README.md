# Python shim for the `tm` CLI

The `python/tm_cli.py` wrapper lets Python-based agents call `tm.mjs` without
learning Node.js argument conventions. It mirrors the Model Context Protocol
façade: read a JSON payload from **STDIN**, invoke the CLI in a temp workspace,
and print structured JSON to **STDOUT**.

## Requirements

- Python 3.9+
- Node.js ≥18 (available on `PATH` or via `TM_NODE_BIN`)
- This repository checked out locally

No third-party Python dependencies are required.

## Quick start

```bash
# Optionally activate a virtualenv (helps when shipping via pipx)
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip

# Smoke-test the shim
cat <<'JSON' | python python/tm_cli.py meta
{"coverage": {"goals": ["worktree"], "provides": ["git.diff"], "weights": {"worktree": 1}}}
JSON
```

For agents, wrap calls so the request JSON is written to STDIN and the response
JSON is parsed from STDOUT. Human-readable `tm` output (progress bars, checkmark
lines, NDJSON events) is forwarded to **STDERR** so machine consumers get clean
STDOUT payloads.

## Commands

### `meta`

```
echo '{"coverage": {"goals": ["worktree"], "provides": ["git.diff.core"]}}' \
  | python python/tm_cli.py meta
```

Response:

```json
{"compose": {"modules": [...], "constraints": [...]}}
```

Set `respect_requires: true` in the request JSON to forward `--respect-requires`.

### `compose`

```
echo '{
  "compose": {"modules": [{"id": "git.diff.core"}]},
  "modules_root": "./examples/modules"
}' | python python/tm_cli.py compose
```

Response includes the scaffold winner report:

```json
{"report": {"bill_of_materials": [...], "constraints": [...]}}
```

Pass `overrides` to mimic `--overrides`. If `modules_root` is omitted the shim
consults `$TM_MCP_MODULES_ROOT` or `$TM_MODULES_ROOT`.

### `gates`

```
python python/tm_cli.py gates --modules-root ./examples/modules <<'JSON'
{
  "mode": "shipping",
  "compose": {"modules": [{"id": "git.diff.core"}]},
  "strict_events": true
}
JSON
```

The shim enforces `--emit-events` and emits:

```json
{"pass": true, "events": [{"event": "GATES_START", ...}]}
```

On failure the process exits with the underlying `tm` exit code and prints:

```json
{
  "error": {
    "code": "E_REQUIRE_UNSAT",
    "message": "Unsatisfied requires: ...",
    "data": {
      "exit_code": 1,
      "stdout": "",
      "stderr": "tm error: E_REQUIRE_UNSAT ...",
      "args": ["gates", "shipping", ...],
      "pass": false,
      "events": [...],
      "events_error": {"code": "E_EVENTS_PARSE", ...}
    }
  }
}
```

The wrapper always attempts to parse `events.ndjson`; parse failures show up in
`error.data.events_error` while preserving the CLI failure mode.

## Integration tips

- Use `--node-bin` or `TM_NODE_BIN` to point at a specific Node.js executable.
- `modules_root` values resolve relative to the repo root when not absolute.
- All temporary files live under `tempfile.TemporaryDirectory` contexts and are
  cleaned automatically once the command exits.
- When chaining commands, prefer `subprocess.run([...], capture_output=True)` to
  pipe STDOUT into a JSON parser directly.
