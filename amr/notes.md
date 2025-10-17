# AMR → Bo4 Workflow Console Canon Notes

## Chosen Variant & Imports
- **Base slate:** `var1` (strong module decomposition, clear CLI bridge integration, complete acceptance coverage for REQ-UI-1..4).
- **Imports pulled:**
  - `SessionFacade` security boundary and optimistic locking semantics from `var3`.
  - Codex audit trail and configuration route gating patterns from `var2`.
  - Artifact inspection hook and replay safeguards from `var4`.
  - History timeline pane distilled from the collective variants to make REQ-UI-4 first-class.

This merge keeps the concise module graph from `var1` while grafting risk mitigations and UX affordances surfaced across the other slates.

## Assumptions
- Existing Bo4 identity provider exposes `userId`, roles, and permissions (`bo4:view`, `bo4:run`) consumable by `SessionFacade`.
- Run telemetry (stages, artifacts, manifests) is already emitted by the orchestrator/CLI bridge and can be normalized by `RunStateGateway` without new upstream schema work.
- Codex access is provisioned through an org-approved proxy that supports prompt sanitization, rate limits (≤10 calls/min/operator), and audit logs.
- History storage can reuse current append-only storage (e.g., Dynamo + S3) with envelope encryption; no new infra exceptions required.

## UX & Technical Risks
- **Timeline scalability:** visualizing >8 concurrent stages will require virtualization or clustering; spike during UI implementation.
- **Codex dependency:** upstream outages block inline authoring. Composer must degrade gracefully to canned templates with clear messaging.
- **Configuration contention:** concurrent edits could race; rely on `SessionFacade.saveConfig` lock-versioning plus optimistic UI hints.
- **Replay clarity:** freeze live updates while replaying history and display a banner to avoid confusing operators about real-time status.
- **CLI bridge latency:** serialized `tm.mjs` invocations can exceed the 2s freshness target; consider async notifications + progress indicators.

## Timing Expectations
- Shell + workflow surface (visualization, snapshot stream wiring): **2 weeks**.
- Run configurator (validation, follow-up policy enforcement, CLI handshake): **1.5 weeks**.
- Codex composer integration (prompt templates, policy feedback loops): **1 week** including security review.
- History timeline + replay/export flows: **1.5 weeks** once storage schemas finalized.

## Open Questions
1. What retention policy governs Codex drafts and run manifests? Who owns purge automation?
2. Are replay actions audited differently from live kickoffs (e.g., approvals or dual control)?
3. Do operators require offline exports (PDF / CSV) beyond JSON artifacts captured via history replay?
4. Should UI expose real-time CLI logs or link to external observability tools?
5. How does rate limiting behave when multiple operators collaborate on the same run?
