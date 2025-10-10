# Getting started

- Install Node.js ≥18 and (optionally) Rust stable.
- `npm ci`
- `npm run schema:compile` to verify schemas.
- Explore the example modules in `/examples/modules`.
- Try composition: `npm run compose`.

## Writing a module

1. Create a folder under your app repo: `modules/<id>`.
2. Add `module.json` following `/spec/module.schema.json`.
3. Implement code behind the port(s) you declare in `provides`.
4. Include tests and evidence bindings in `module.json`.
5. Keep coupling via **ports** only (no cross-imports).

## Compose plan

- Author or auto-generate `compose.json` (see `/spec/compose.schema.json`).
- Use `tm compose` to validate and emit a scaffold winner report.
- Materialize the workspace: `node runtimes/ts/composer/index.mjs --compose ./compose.json --modules-root ./modules --out ./winner`.
