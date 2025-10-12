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

Refer to the [Implementer Checklist](../prompts/implementer/CHECKLIST.md) for the MUST-have validation steps. Checking those boxes ensures your local runs of `node tm.mjs gates shipping --emit-events --strict-events` produce the telemetry events (`gate_passed`, `test_passed`, `evidence_linked`) that downstream tooling expects.

## Type-checking (TypeScript)

When `.ts`/`.tsx` files are present under `modules/` or `glue/`:

1. Install `typescript@^5.6` locally (`npm i -D typescript`).
2. Ensure the winner workspace has a `tsconfig.json` whose `"include"` covers only `modules` and `glue`.
3. Fix missing typings, invalid imports, or path alias issues flagged by the compiler.
4. Re-run shipping gates (`node tm.mjs gates shipping ... --emit-events`). On failure, inspect `winner/.tm/tsc.log` for full diagnostics (first 10 messages appear inline).

## Cross-import linting

Shipping relies on a local ESLint rule that forbids module-to-module imports. Install `eslint` and `@typescript-eslint/parser` in your workspace (`npm i -D eslint @typescript-eslint/parser`). `tm gates` prefers ESLint and emits `lint_failed` errors when violations occur. If ESLint is unavailable, gates fall back to the legacy regex scan and emit a warning (`eslint_unavailable`); fix the reported import path and rerun.
