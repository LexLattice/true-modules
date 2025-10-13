# MCP façade for the True Modules CLI

The `mcp/server.mjs` entry point exposes `tm` commands as Model Context Protocol tools so agents can drive greedy compose planning, winner validation, and shipping gates without shelling out.

## Prerequisites

- Node.js ≥18.
- Install repo dependencies:
  ```bash
  npm install
  ```
- (Optional) Install the official MCP SDK when you have network access:
  ```bash
  npm install @modelcontextprotocol/sdk
  ```
  Without the SDK the façade automatically falls back to `mcp/sdk-stub.mjs`, which logs a warning but still lets you smoke-test the tools locally.
- Point the façade at your modules checkout via an environment variable (overridable per call):
  ```bash
  export TM_MCP_MODULES_ROOT="/abs/path/to/true-modules/examples/modules"
  ```

## Launching the server

```bash
npm run mcp:server
```

You should see a startup notice listing the registered tools. The façade creates per-request temp directories under `os.tmpdir()` and removes them even if a command fails, so `/tmp` remains clean between calls.

## Client configuration

Create `~/.mcp/clients/tm.json` (works with the generic MCP CLI and compatible shells):

```json
{
  "name": "true-modules",
  "description": "True Modules CLI façade",
  "command": "node",
  "args": ["/absolute/path/to/true-modules/mcp/server.mjs"],
  "env": {
    "TM_MCP_MODULES_ROOT": "/absolute/path/to/true-modules/examples/modules"
  }
}
```

Restart your MCP client after saving the file. Override `TM_MCP_MODULES_ROOT` (or provide `modulesRoot` per request) when you want to target a different workspace.

## Tools

Each handler accepts JSON objects **or** JSON strings so agents can forward raw payloads. CLI stdout/stderr stream into MCP logs, and errors preserve the original `tm` exit codes (`E_REQUIRE_UNSAT`, `npm_pack_failed`, etc.) alongside the façade-specific diagnostics described below.

### `tm.meta`

Generate a greedy compose plan from coverage data. Set `respectRequires` to forward `--respect-requires` when you want the solver to obey module `requires` constraints during selection.

**Request**

```json
{
  "tool": "tm.meta",
  "arguments": {
    "coverage": {
      "goals": ["worktree"],
      "provides": ["git.diff"],
      "weights": { "worktree": 1 }
    },
    "respectRequires": true
  }
}
```

**Response**

```json
{
  "compose": {
    "run_id": "2025-10-13T14:44:05.795Z",
    "modules": [
      { "id": "worktree.manager", "version": "0.1.0" },
      { "id": "git.diff.core", "version": "0.1.0" }
    ],
    "constraints": ["no-cross-imports", "ports-only-coupling"]
  }
}
```

### `tm.compose`

Validate a compose plan against the manifests under `modulesRoot` (defaults to `$TM_MCP_MODULES_ROOT`). Supply `overrides` to forward a JSON overrides file via `--overrides`.

**Request**

```json
{
  "tool": "tm.compose",
  "arguments": {
    "compose": { "modules": [{ "id": "git.diff.core" }] },
    "modulesRoot": "./examples/modules",
    "overrides": {
      "modules": ["-git.diff.core", { "id": "git.diff.alt", "version": "0.1.0" }],
      "constraints": ["-ports-only-coupling"]
    }
  }
}
```

**Response**

```json
{
  "report": {
    "context": {
      "run_id": "2025-10-12T15:42:05.765Z",
      "composer": "tm (scaffold)"
    },
    "bill_of_materials": [
      { "id": "git.diff.core", "version": "0.1.0" },
      { "id": "git.index.controller", "version": "0.1.0" },
      { "id": "safety.validation", "version": "0.1.0" }
    ],
    "constraints": ["no-cross-imports", "ports-only-coupling"]
  }
}
```

### `tm.gates`

Execute conceptual or shipping gates (`mode` defaults to `shipping`). Attach `overrides` when replaying a compose plan that relies on overrides and toggle `strictEvents` to append `--strict-events`. Regardless of success, the façade reads `events.ndjson` and returns the parsed telemetry so agents can render progress UIs.

**Request**

```json
{
  "tool": "tm.gates",
  "arguments": {
    "mode": "shipping",
    "compose": { "modules": [{ "id": "git.diff.core" }] },
    "modulesRoot": "./examples/modules",
    "strictEvents": true
  }
}
```

**Success response**

```json
{
  "pass": true,
  "events": [
    { "event": "GATES_START", "detail": { "modules_total": 3 } },
    { "event": "LINT_START", "detail": { "lint_tool": "eslint" } },
    { "event": "LINT_PASS", "detail": { "dur_ms": 836 } },
    { "event": "GATES_PASS", "detail": { "passed": 0, "failed": 0 } }
  ]
}
```

**Failure example (`E_REQUIRE_UNSAT`)**

```json
{
  "error": {
    "code": "E_REQUIRE_UNSAT",
    "message": "Unsatisfied requires: module safety.validation is missing evidence",
    "data": {
      "exitCode": 1,
      "stdout": "",
      "stderr": "tm error: E_REQUIRE_UNSAT Unsatisfied requires: module safety.validation is missing evidence",
      "args": [
        "gates",
        "shipping",
        "--compose",
        "/tmp/tm-mcp-123/compose.json",
        "--modules-root",
        "/workspace/true-modules/examples/modules",
        "--emit-events",
        "--events-out",
        "/tmp/tm-mcp-123/events.ndjson",
        "--strict-events"
      ],
      "pass": false,
      "events": [
        { "event": "GATES_START", "detail": { "modules_total": 3 } },
        { "event": "REQUIRES_FAIL", "detail": { "module": "safety.validation" } }
      ]
    }
  }
}
```

### Smoke-test scripts

Run the façade directly with inline payloads to confirm the new arguments end-to-end:

```bash
node - <<'NODE'
import fs from 'node:fs/promises';
import { tools } from './mcp/server.mjs';
const coverage = JSON.parse(await fs.readFile('./examples/coverage.json', 'utf8'));
const composePlan = JSON.parse(await fs.readFile('./examples/compose.greedy.json', 'utf8'));
await tools.meta({ input: { coverage, respectRequires: true } }, { logger: console });
await tools.compose({ input: { compose: composePlan, overrides: { modules: [] }, modulesRoot: './examples/modules' } }, { logger: console });
await tools.gates({ input: { mode: 'conceptual', compose: composePlan, strictEvents: true, modulesRoot: './examples/modules' } }, { logger: console });
NODE
```

## Troubleshooting

| Symptom / code | Likely cause | Fix |
| --- | --- | --- |
| `E_MODULES_ROOT_REQUIRED` | No modules root provided and `TM_MCP_MODULES_ROOT` is unset | Pass `modulesRoot` explicitly or export `TM_MCP_MODULES_ROOT`. |
| `E_MODULES_ROOT` | Provided path does not exist or is not a directory | Double-check the workspace path and ensure the repo is checked out locally. |
| `E_EVENTS_PARSE` | `events.ndjson` contained malformed JSON | Inspect the raw file (emitted under `/tmp/tm-mcp-*`) and file a bug with the emitting gate. |
| `npm_pack_failed` | `--npm-pack` hook surfaced packaging issues | Review the `diagnostics` array in the error payload and rerun `npm pack` manually. |
| `E_SPAWN` | Node failed to launch `tm.mjs` (missing binary, permissions) | Verify `node tm.mjs --help` works locally and that the MCP server runs inside the repo root. |
| CLI output missing | Client filtered stdout/stderr | Check the MCP client log or run `npm run mcp:server` directly to verify streaming. |

If you see `[tm-mcp] Using local MCP stub`, install the official SDK and rerun `npm install` so the server negotiates the real MCP transport.
