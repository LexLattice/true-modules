# AMR Meta-Review — UI Workflow Console

| Variant | Coverage (0.35) | SSD (0.25) | Complexity (0.15) | Testability (0.15) | Risk (0.10) | Weighted |
|---------|-----------------|------------|--------------------|--------------------|-------------|----------|
| var1    | 0.90            | 0.80       | 0.70               | 0.80               | 0.70        | **0.81** |
| var2    | 0.85            | 0.75       | 0.65               | 0.75               | 0.65        | 0.76     |
| var3    | 0.82            | 0.75       | 0.60               | 0.72               | 0.78        | 0.75     |
| var4    | 0.80            | 0.75       | 0.68               | 0.68               | 0.70        | 0.74     |

## Canon Selection
**Winner:** `var1` (balanced module graph, explicit CLI integration, comprehensive acceptance deck).

**Imports applied:**
- `SessionFacade` security boundary, optimistic locking, and replay gating from `var3`.
- Codex audit trail + configuration route policy patterns from `var2`.
- Artifact inspection and replay safeguards (freeze live updates during replay) from `var4`.
- Dedicated `ui.history_timeline` pane synthesised from runner-up UX notes to make REQ-UI-4 first-class.

Resulting canon files:
- `amr/architecture.json`
- `amr/schemas.json`
- `amr/acceptance.json`
- `amr/traceability.map.json`
- `amr/notes.md`

## Runner-up Highlights
- **var2:** Strong focus on route gating, scheduler locks, and Codex audit logging. Retained for Config route invariants and assistant policy enforcement.
- **var3:** Introduced `SessionFacade` wrapper and lock-version semantics to keep orchestrator state coherent; carried forward wholesale.
- **var4:** Added artifact inspection flow and replay freeze requirements; merged into workflow surface + history timeline modules.

## Gaps & Follow-ups
1. **CLI surface SSD gap:** All slates lacked explicit CLI surface instrumentation. Canon now tracks CLI bridge invariants, but implementation should add UI affordances (log modal, progress indicators).
2. **History retention policy:** Define purge cadence and compliance owner before storing Codex drafts + manifests long term.
3. **Codex outage plan:** UI needs graceful degradation path (template library, retry guidance) when Codex proxy is unavailable.

## Alignment with RCM
- `REQ-UI-1`: Covered by `ui.shell`, `ui.workflow_surface`, `svc.session_facade`, `svc.run_state_gateway`, acceptance `T-UI-01`.
- `REQ-UI-2`: Covered by `ui.run_configurator`, `svc.run_configuration`, `svc.session_facade`, `svc.cli_bridge`, `svc.history_store`, acceptance `T-UI-02`.
- `REQ-UI-3`: Covered by `ui.codex_composer`, `svc.codex_adapter`, `svc.history_store`, acceptance `T-UI-03`.
- `REQ-UI-4`: Covered by `ui.history_timeline`, `svc.history_store`, `svc.session_facade`, acceptance `T-UI-04`.

## Next Steps
1. Run `node scripts/rcm-ssd-check.mjs --rcm rcm/rcm.json --trace amr/traceability.map.json --slates amr/slates --out amr/ssd.json --fail-low 0.75` to keep per-slate telemetry for posterity.
2. Validate merged canon via `node scripts/tm-amr-verify.mjs --canon amr/architecture.json --acceptance amr/acceptance.json --rcm rcm/rcm.json --trace amr/traceability.map.json`.
3. Hand the canon to the implementation Bo4 brief; ensure the UI workstream uses the new history timeline + Codex guardrails as acceptance targets.
