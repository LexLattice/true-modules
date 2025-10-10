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
