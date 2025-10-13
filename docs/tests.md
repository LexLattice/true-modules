# Shipping test conventions

In `module.json`, each entry in `tests` maps to one executable check that must pass in *shipping* gates.

Supported forms:

- `script:<path>` — the file at `<path>` is executed with Node.js (`process.execPath`). Exit code `0` is a pass; anything else fails.
- `<path>.json` — declare a JSON spec. Provide `tests/runner.mjs` inside the module; it will be invoked as:

  ```bash
  node tests/runner.mjs --spec <path> --moduleRoot <dir>
  ```

  The runner must exit `0` on success and non-zero otherwise.

Example `tests/runner.mjs` scaffold:

```js
#!/usr/bin/env node
import fs from 'fs/promises';
import process from 'process';

const args = new Map(
  process.argv.slice(2).map((value, idx, arr) => {
    if (!value.startsWith('--')) return null;
    return [value.replace(/^--/, ''), arr[idx + 1]];
  }).filter(Boolean)
);

const specPath = args.get('spec');
if (!specPath) {
  console.error('Missing --spec');
  process.exit(1);
}

const spec = JSON.parse(await fs.readFile(specPath, 'utf8'));
if (!spec.name) {
  console.error('Spec missing "name" field');
  process.exit(1);
}

// TODO: add real expectations
process.exit(0);
```

This simple contract keeps shipping gates portable while allowing richer module-specific assertions as your workflow evolves.

Refer to the [Implementer Checklist](../prompts/implementer/CHECKLIST.md) for the MUST-have validation steps. Checking those boxes ensures your local runs of `node tm.mjs gates shipping --emit-events --strict-events` produce the telemetry events (`gate_passed`, `test_passed`, `evidence_linked`) that downstream tooling expects. For the end-to-end loop, follow the [Contributor Playbook](./contributor-playbook.md) and, when you want automation, lean on the [MCP façade](./mcp.md)—it supports compose/gates overrides, opt-in strict event enforcement, and streaming failure telemetry so agents can mirror the CLI exactly.

When the compose plan relies on an overrides file, run `node tm.mjs compose --overrides <file>` against the fixture (see `examples/compose.overrides/`) before pushing. CI replays the same overrides and will fail fast if the merged plan drifts, and it also enforces the duplicate-provider failure/repair runs plus the TypeScript composer scaffold so regressions surface early.

## Type-checking (TypeScript)

When `.ts`/`.tsx` files are present under `modules/` or `glue/`:

1. Install `typescript@^5.6` locally (`npm i -D typescript`).
2. Ensure the winner workspace has a `tsconfig.json` whose `"include"` covers only `modules` and `glue`.
3. Fix missing typings, invalid imports, or path alias issues flagged by the compiler.
4. Re-run shipping gates (`node tm.mjs gates shipping ... --emit-events`). On failure, inspect `winner/.tm/tsc.log` for full diagnostics (first 10 messages appear inline).

## Cross-import linting

Shipping relies on a local ESLint rule that forbids module-to-module imports. Install `eslint` and `@typescript-eslint/parser` in your workspace (`npm i -D eslint @typescript-eslint/parser`). `tm gates` prefers ESLint and emits `lint_failed` errors when violations occur. If ESLint is unavailable, gates fall back to the legacy regex scan and emit a warning (`eslint_unavailable`); fix the reported import path and rerun.

## Platform-conditional tests

Some modules provide additional packs that only execute on specific platforms. For example, the SafetyPort module ships a Windows-only harness:

```bash
node examples/modules/safety.validation/tests/run_win_cases.mjs
```

When invoked on Linux or macOS, the script prints `SKIP SafetyPort Windows cases (platform: ...)` and exits with status `0` so CI remains green. On Windows machines it transpiles `src/index.ts` on the fly and asserts the path normalization and safety guards declared in `tests/spec_paths_windows.json`.
