# Notes

## Assumptions
- Operator authentication and role mapping are provided by existing platform SSO; `ui.shell` only enforces the access token gating.
- CLI scripts (`tm.mjs`, `scripts/rcm-ssd-check.mjs`) expose idempotent entry points that accept structured arguments; adapter can wrap them without major rewrites.
- Codex API quota is sufficient for burst loads when multiple operators collaborate, provided rate limiting at gateway is enforced.
- Front-end can leverage WebSockets (or SSE) supplied by `service.run_controller` for live workflow updates.

## UX / Technical Risks
- Latency between CLI script completion and UI artifact availability could exceed the 2s rendering target; may require artifact cache warming.
- Codex drafts could include disallowed content despite filters; need rapid feedback loops and clear user messaging on blocked outputs.
- Run history volume might grow quickly, stressing persistence backing store if replay snapshots are large.
- Complex dependency visualization may overwhelm operators if too many concurrent stages exist; require progressive disclosure or clustering.

## Timing Considerations
- Initial milestone prioritizes REQ-UI-1..3; history persistence (REQ-UI-4) can land in second sprint once baseline UI stabilized.
- Integration testing with CLI scripts must align with nightly Bo4 pipeline windows to avoid conflicting scheduled runs.
- Codex gateway monitoring needs to be wired before launch to ensure traceability from day one.

## Open Questions
- What authorization model governs replay exports? Need clarity on cross-team visibility policies.
- Should Codex prompts be retained indefinitely for audit, or subject to data retention limits?
- Are there existing telemetry pipelines we can reuse for workflow status metrics, or do we build dedicated instrumentation?
- Do operators require offline access to run histories, necessitating export formats beyond JSON (e.g., PDF briefs bundle)?
