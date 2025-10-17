# Bo4-AMR Console Slate Notes

## Assumptions
- Operators authenticate via existing IAM and permissions mirror CLI roles (`bo4:view`, `bo4:run`).
- Workflow snapshots are supplied by existing Bo4 orchestration manifests without schema change.
- Codex access is provisioned with organizational rate limits compatible with proxy throttling (10 calls/min/operator).
- History persistence can reuse current datastore (likely DynamoDB or Postgres) with append-only semantics.

## UX & Technical Risks
- **Status freshness:** polling cadence may miss sub-minute stage flips; consider WebSocket subscription to reduce latency.
- **Codex dependency:** upstream Codex outages will block inline drafting; require graceful degradation and canned templates.
- **Configuration contention:** concurrent edits could lead to lock conflicts; need optimistic UI with lock-version awareness.
- **Replay accuracy:** restoring historical configs demands manifest compatibility checks to avoid drift errors.

## Timing Considerations
- Initial milestone targets visualization + configuration (REQ-UI-1/2/3); persistence (REQ-UI-4) can ship in phase two.
- Codex proxy integration requires security review before production rollout; schedule buffer for audit logging implementation.
- Visual regression harness (for swimlane rendering) should be ready before beta to capture stage layout changes.

## Open Questions
- What retention policy governs run history, and who administers purges?
- Should Codex drafts be stored as artifacts for compliance or discarded after validation?
- Are there SLA expectations for orchestrator refresh that influence polling/WebSocket design?
- How will access control extend to external collaborators (read-only vs. run privileges)?
