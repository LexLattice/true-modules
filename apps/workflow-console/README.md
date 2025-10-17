# Workflow Console

This package hosts the AMR → Bo4 workflow console. It is a Vite-powered React
application that mirrors the canon module layout (workflow surface, run
configuration, Codex composer, and history timeline).

## Scripts

```bash
npm run dev        # start the console at http://127.0.0.1:5173
npm run build      # type-check and produce a production bundle in dist/
npm run lint       # eslint over src/**/*.{ts,tsx}
npm run preview    # serve the built bundle locally
```

## Environment variables

The in-memory services do not require environment variables. When integrating
with production services, add any required secrets via `.env` and reference them
in `vite.config.ts`.

## Telemetry

The console emits `tm-events@1` telemetry for configuration submissions, run
kickoff, Codex requests, and replay mode. During development the in-memory log
can be inspected via `window.__tmTelemetry` or exported from the UI using the
**Export events** button.
