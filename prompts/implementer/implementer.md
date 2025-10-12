# Implementer Prompt Pack

## Overview
- Work inside your app repo under `modules/<module-id>`.
- Keep `module.json` as the source of truth for schema, ports, tests, and evidence bindings.
- Use the shipping gates to validate modules end-to-end during implementation.

## Workflow
1. **Prepare environment**
   - Install dependencies:
     ```bash
     npm ci
     ```
   - Compile schemas or other prereqs as needed:
     ```bash
     npm run schema:compile
     ```
2. **Implement the module**
   - Create or update `modules/<module-id>/module.json`.
   - Flesh out port implementations in your app (respect port contracts in `provides` and `consumes`).
   - Add or update module tests under `modules/<module-id>/tests/`.
   - Bind evidence in `module.json` and gather artifacts while coding.
3. **Validate**
   - Run shipping gates frequently:
     ```bash
     node tm.mjs gates shipping --emit-events --strict-events
     ```
   - Fix any schema, lint, or runtime regressions before proceeding.

## Deliverables
- `modules/<module-id>/module.json` conforms to [`/spec/module.schema.json`](../../spec/module.schema.json).
- Test coverage and harnesses follow [`/docs/tests.md`](../../docs/tests.md).
- Evidence bindings reference artifacts documented in [`/docs/evidence-bindings.md`](../../docs/evidence-bindings.md).
- Include updated source/tests/evidence artifacts necessary for the module to ship.

## Guardrails
- Run `npm ci` before gating to ensure a clean dependency graph.
- Respect `requires[]` dependencies declared by the module; verify they exist and are satisfied.
- Avoid cross-module imports—communicate only through declared ports.
- Keep port contracts intact: preserve shapes, error semantics, and versioning constraints.
- Do not remove gates or skip tests; rerun the full shipping suite locally via `node tm.mjs gates shipping --emit-events --strict-events`.
- When updating evidence, ensure citations map to actual artifacts and are version-stable.

## Output Contract
When you finish implementing:
- Summarize the change set (modules touched, new behaviors, fixes).
- List every test and gate you ran, with outcomes.
- Call out remaining risks, mitigations, and follow-up tasks.
- Include evidence citations for every binding and any new artifacts.
- Confirm that `requires[]` constraints remain satisfied and no new cross-imports were introduced.

Keep these notes in your PR description, status update, or delivery handoff so reviewers can verify quickly.
