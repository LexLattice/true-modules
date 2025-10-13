#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GET_MANIFEST_PROP="$SCRIPT_DIR/lib/get-manifest-prop.mjs"

usage() {
  cat <<USAGE
Usage: $0 --run-dir <dir> --base <branch> [--task <id>] [--push]
USAGE
  exit 1
}

RUN_DIR=""
BASE_BRANCH=""
TASK_OVERRIDE=""
PUSH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-dir)
      RUN_DIR=$2
      shift 2
      ;;
    --base)
      BASE_BRANCH=$2
      shift 2
      ;;
    --task)
      TASK_OVERRIDE=$2
      shift 2
      ;;
    --push)
      PUSH=1
      shift
      ;;
    --help)
      usage
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      ;;
  esac
done

[[ -n "$RUN_DIR" && -n "$BASE_BRANCH" ]] || usage

RUN_DIR=$(realpath "$RUN_DIR")
MANIFEST="$RUN_DIR/run.json"
[[ -f "$MANIFEST" ]] || { echo "run.json not found in $RUN_DIR" >&2; exit 1; }

info_from_manifest() {
  node "$GET_MANIFEST_PROP" "$MANIFEST" "$1"
}

TASK_ID="$TASK_OVERRIDE"
if [[ -z "$TASK_ID" ]]; then
  TASK_ID=$(info_from_manifest task_id 2>/dev/null || true)
fi
if [[ -z "$TASK_ID" ]]; then
  echo "Task id not found; use --task" >&2
  exit 1
fi

VARIANT=$(info_from_manifest selection.variant 2>/dev/null || true)
if [[ -z "$VARIANT" ]]; then
  echo "Selected variant not found in manifest; run bo4-meta-run before apply" >&2
  exit 1
fi

VARIANT_COUNT=$(node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync('$MANIFEST','utf8'));console.log(Array.isArray(data.variants)?data.variants.length:0);")
WINNER_REL=$(info_from_manifest winner.dir 2>/dev/null || true)
if [[ -z "$WINNER_REL" ]]; then
  WINNER_REL="$(realpath --relative-to="$(git rev-parse --show-toplevel)" "$RUN_DIR/winner")"
fi
WINNER_ABS=$(realpath "$RUN_DIR/winner")

CODEX_BIN=${CODEX_BIN:-codex}

if [[ $VARIANT_COUNT -le 1 ]]; then
  echo "Single variant; running codex cloud apply --preflight"
  "$CODEX_BIN" cloud apply "$TASK_ID" --variant "$VARIANT" --preflight
  exit 0
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

if [[ -n $(git status --porcelain) ]]; then
  echo "Working tree dirty; commit or stash changes first" >&2
  exit 1
fi

git checkout "$BASE_BRANCH"
BRANCH="bo4/$TASK_ID/winner"
if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  git switch "$BRANCH"
else
  git switch -c "$BRANCH"
fi

git add "$WINNER_REL"
if git diff --cached --quiet; then
  echo "No changes to commit from $WINNER_REL"
else
  git commit -m "chore: codex cloud $TASK_ID winner"
fi

if [[ $PUSH -eq 1 ]]; then
  git push -u origin "$BRANCH"
fi

echo "Branch ready: $BRANCH"
