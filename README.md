# true-modules

Ports, specs, composer, and scaffolds for the **True Modules** approach — build features as composable modules with explicit ports and manifests.

## Quick start

**Requirements:** Node.js ≥18, npm (or pnpm/yarn), optional Rust toolchain (stable).

```bash
# 1) Install JS deps
npm ci

# 2) Compile schemas (AJV 2020-12)
npm run schema:compile

# 3) Try the example composition (uses ./examples)
npm run compose

# 4) (Optional) Rust crates sanity-check
cd runtimes/rust/ports && cargo check && cd ../composer && cargo check
```

## CLI (scaffold level)
This repo provides a minimal CLI `tm` for schema validation and a basic composition flow:

```bash
# Greedy meta selection (from coverage.json) → compose.json (uses risk/evidence scoring)
node tm.mjs meta --coverage ./examples/coverage.json --out ./examples/compose.greedy.json

# Compose (validate compose.json + module manifests) → winner artifacts
node tm.mjs compose --compose ./examples/compose.json --modules-root ./examples/modules --out ./examples/winner

# Conceptual/Shipping gates (light checks + cross-import lint)
node tm.mjs gates conceptual --compose ./examples/compose.json --modules-root ./examples/modules
node tm.mjs gates shipping   --compose ./examples/compose.json --modules-root ./examples/modules
```

> **Note:** This is a scaffold: the CLI enforces schemas and basic wiring checks; it does not build or link code. The full Composer, Meta solver, and multi-runtime ports live in `/runtimes` as you evolve them.

## Scaffolding a new module

```bash
node tm.mjs module --new safety.validation
# creates ./modules/safety.validation with module.json, src/, tests/
```

See **[End-to-end swimlane](docs/swimlane.md)** for BO4 roles & hand-offs.
Shipping test expectations live in **[docs/tests.md](docs/tests.md)**.

## License
Dual-licensed under **MIT** and **Apache-2.0**. See `LICENSE-MIT` and `LICENSE-APACHE`.
