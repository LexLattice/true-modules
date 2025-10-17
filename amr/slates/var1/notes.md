# AMR → Bo4 Workflow Console Slate Notes

## Assumptions
- Operators authenticate through existing Bo4 SSO; session context provides role/permissions consumed by `ui.shell`.
- Run telemetry (stage transitions, artifacts) is exposed via existing Bo4 orchestrator APIs or tm.mjs streaming hooks and can be normalized by `svc.run_state_gateway`.
- Codex access follows platform-approved prompt/response guardrails; rate limit budgets allow bursty authoring during kickoff without additional quotas.
- Persistence for run history can target the same store used by runs/ artifacts (e.g., S3 + Dynamo) without new infra approvals.

## UX & Technical Risks
- Timeline rendering may struggle with long-running or highly parallel runs; need virtualization to avoid DOM thrash.
- Codex suggestions might leak outdated manifests if history replay injects stale context; require freshness checks on prompts.
- CLI bridge failures (tm.mjs errors) could stall kickoff; need clear surfaced logs and retry affordances in UI.
- Replay operations risk overwriting live configuration if operators mis-click; require confirmation modals and diff previews.

## Timing Considerations
- Expect ~2 weeks for UI shell + workflow visualization (component library integration, data polling).
- Additional 1 week for Codex composer (prompt templates, moderation feedback loops).
- Persistence wiring (history store, replay) likely 1.5 weeks including schema migration and audit controls.
- Integration testing with tm.mjs and scripts/rcm-ssd-check.mjs should be scheduled before enabling kickoff in production.

## Open Questions
1. What granularity of artifact previews do operators need (raw text, diff, download links)?
2. Should Codex drafts be versioned alongside human edits for auditability?
3. Do replayed runs require manual approval before launching in shared environments?
4. How does access control differentiate observers vs operators for run history export?
5. What retention policy applies to Codex drafts and stored run manifests?
