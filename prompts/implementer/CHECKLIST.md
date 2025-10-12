# Implementer Checklist

Use this checklist while implementing a module. The items marked **MUST** are required before you hand off work.

## Schema & Contracts
- [ ] **MUST** `modules/<module-id>/module.json` is complete and valid against [`/spec/module.schema.json`](../../spec/module.schema.json).
- [ ] **MUST** All declared ports keep their input/output contracts and error semantics intact.
- [ ] **MUST** Every entry in `requires[]` is satisfied by available modules and evidence.

## Tests & Gates
- [ ] **MUST** Added or updated tests documented in [`/docs/tests.md`](../../docs/tests.md) exist and pass locally.
- [ ] **MUST** Shipping gates executed:
  ```bash
  node tm.mjs gates shipping --emit-events --strict-events
  ```
- [ ] **MUST** Record additional validation commands (e.g., `npm run lint`) and confirm green results.

## Evidence & Documentation
- [ ] **MUST** Evidence bindings are present and mapped to artifacts per [`/docs/evidence-bindings.md`](../../docs/evidence-bindings.md).
- [ ] **MUST** Every artifact is cited with stable references in the delivery notes.

## Risks & Follow-ups
- [ ] **MUST** Document residual risks, mitigations, and open questions.
- [ ] **MUST** Capture follow-up tasks or debt created by this change.

## Before you submit
- [ ] Summarize module changes and affected surfaces.
- [ ] List all tests/gates run with outcomes.
- [ ] Include evidence citations inline with your summary.
- [ ] Reconfirm that `requires[]` is satisfied and no cross-imports were introduced.
