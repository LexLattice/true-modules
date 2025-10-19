#!/usr/bin/env bash
set -euo pipefail

COMPOSE=${1:-runs/current/meta/compose.json}
LOCK=${2:-amr/canon.lock.json}
MODROOT=${3:-modules}
ARTIFACTS_DIR=${4:-artifacts}

echo ">>> Canon check ..."
if [[ ! -f "$COMPOSE" ]]; then
  echo "Compose file not found: $COMPOSE" >&2
  exit 1
fi
if [[ ! -f "$LOCK" ]]; then
  echo "Canon lock not found: $LOCK" >&2
  exit 1
fi
if [[ ! -d "$MODROOT" ]]; then
  echo "Modules root not found: $MODROOT" >&2
  exit 1
fi

mkdir -p "$ARTIFACTS_DIR"

EVENTS_FILE="${ARTIFACTS_DIR%/}/events.ndjson"

node tm.mjs gates shipping \
  --compose "$COMPOSE" \
  --modules-root "$MODROOT" \
  --emit-events \
  --events-out "$EVENTS_FILE" \
  --events-truncate \
  --strict-events

node scripts/canon-verify.mjs \
  --lock "$LOCK" \
  --modules-root "$MODROOT" \
  --compose "$COMPOSE"

echo ">>> PASS: Canon stamp verified."
