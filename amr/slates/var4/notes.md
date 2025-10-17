# Assumptions
- Console sits behind existing Bo4 auth gateway; UI receives session scopes so RBAC can block kickoff while allowing read-only observers.
- Bo4 orchestrator already emits stage manifests compatible with `WorkflowSnapshot`; we only extend with dependency hashes for staleness detection.
- Codex gateway exposes unified streaming endpoint; retry and cooldown policy are centrally configured.
- Persistence leverages existing ledger service; HistoryStore writes append-only records without schema drift.

# UX & Technical Risks
- Overloaded workflow surface if stage count exceeds layout breakpoints; need adaptive grouping or horizontal scroll.
- Codex responses may violate RCM schema; validation must provide actionable remediation rather than silent rejection.
- Replay mode mixing with live updates could confuse operators; shell must freeze live subscriptions when replay is active.
- CLI bridge failures (tm.mjs) could block kickoff; require fallback manual overrides or cached results.

# Timing Considerations
- Target <2s latency for workflow updates to preserve situational awareness.
- Codex compose interactions should respond within 5s including retries; show progress indicator during generation.
- History replay expected to load within 3s for last 10 sessions via indexed queries.

# Open Questions
1. What persistence layer backs HistoryStore (S3, DynamoDB, internal ledger)?
2. Are there audit requirements for Codex prompt/response storage beyond run correlation IDs?
3. Should CLI exports support incremental artifact diffs or only full bundles?
4. Do operators need offline mode for run configuration drafting?
