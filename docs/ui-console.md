# Workflow Orchestrator Console

The workflow orchestrator console exposes the AMR → Bo4 workflow for operators
and mirrors the interfaces defined in `amr/architecture.json` /
`amr/schemas.json`. The React application lives in `apps/workflow-console` and
is composed of four canon panes:

- **Workflow surface** — renders live run snapshots with dependency badges and
  artifact inspection. The surface freezes automatically while replay is active
  and resumes when operators exit replay.
- **Run configurator** — validates operator input against the CLI bridge,
  streams status telemetry, and persists defaults for the active operator.
- **Codex composer** — embeds Codex drafting with guardrails, redaction, and
  audit logging that is exported alongside events.
- **History timeline** — lists completed runs, supports replay/export, and can
  export `tm-events@1` telemetry for downstream automation.

## Getting started

Install dependencies and launch the dev server from the repository root:

```bash
npm install            # may require internal registry access
npm run dev --workspace apps/workflow-console
```

The console boots at <http://127.0.0.1:5173/> with deterministic in-memory
fixtures. The bootstrap populates two historical runs, seeds run defaults, and
simulates live workflow progression so the UI immediately reflects canon data
flows. Telemetry is exposed at `window.__tmTelemetry` for debugging and the
**Export events** button downloads an `events.ndjson` snapshot of emitted
`tm-events@1` records.

### Commands

```bash
npm run build --workspace apps/workflow-console   # type-check + bundle build
npm run lint --workspace apps/workflow-console    # eslint over src/**/*
npm run test --workspace apps/workflow-console    # Vitest acceptance sweep
```

## Replay & export

History is persisted via `HistoryStore.appendRun`. Selecting **Replay** loads a
deterministic timeline, halts live workflow updates, and surfaces a replay
banner. **Resume live** clears replay mode and rehydrates the live snapshot. The
**Export events** action writes the in-memory `tm-events@1` log to a download so
shipping gates can ingest the session telemetry.

## Codex workflows

The Codex composer integrates with `CodexAdapter.generate` to emit streaming
drafts. Operators can redact drafts (guarding against banned tokens), publish to
the audit trail, and inspect previous Codex audits through the history export.
Publishing fires a `codex.publish` telemetry event that is captured in
`artifacts/events.ndjson` during shipping gates.
