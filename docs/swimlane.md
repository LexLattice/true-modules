# End-to-end swimlane (True Modules)

Actors: Intent author → Implementers (BO4) → Meta reviewer → Composer/Orchestrator → QA/Approver

> For the Codex CLI ↔ Codex Cloud loop (headless BO4 runs) see `docs/cloud-headless.md`.

1) Intent author: define goals (P1..Pn), seed examples.
2) Implementers: deliver modules under `modules/<id>/` with `module.json`, tests, evidence.
3) Meta reviewer: emit `coverage.json` (with optional `risk` and `evidence_strength`), `compose.json`, and a meta `report.json`.
4) Composer: validate and generate winner BoM/report.
5) Gates: conceptual (schema + invariants/tests/evidence + no cross-imports); shipping (extends conceptual; add builds/tests later).
