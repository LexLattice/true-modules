# Architecture Meta-Review (AMR)

**Purpose.** Freeze a single Canon (architecture + schemas + acceptance) *before* coding, so Bo4-I implements one target.

**Artifacts**
- `rcm/rcm.json` — Requirement Coverage Matrix
- `amr/slates/var*/` — 3–4 slates (no code)
- `amr/ssd.json` — spec density summary per slate
- `amr/traceability.map.json` — REQ → modules/interfaces/tests
- `amr/architecture.json|schemas.json|acceptance.json` — merged Canon
- `amr/amr_winner.md` — rationale

**Gates**
- `node scripts/rcm-ssd-check.mjs --rcm rcm/rcm.json --trace amr/traceability.map.json --slates amr/slates --out amr/ssd.json --fail-low 0.75`
- `node scripts/tm-amr-verify.mjs --canon amr/architecture.json --acceptance amr/acceptance.json --rcm rcm/rcm.json --trace amr/traceability.map.json`
- Fail if any `must:true` uncovered or any layer SSD < 0.75 (unless `amr/risk_acceptance.md` exists).

**Runbook integration**
- Add a pre-phase: Bo4-A (architect slates) → AMR merge (canon) → Bo4-I implementation.
- Record hashes & events in your run manifest.

*Generated: 2025-10-15T17:41:22.479052Z*
