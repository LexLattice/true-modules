#!/usr/bin/env bash
# Usage: codex-cloud-apply.sh <task_id> <base_branch>
set -euo pipefail
TASK=${1:?"task id required"}
BASE=${2:?"base branch required"}
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree dirty; please commit or stash changes before running." >&2
  exit 1
fi
VARIANTS=$(codex cloud show "$TASK" --json | jq -r '.variants[] | select(.status=="completed") | .variant_index' )
if [ -z "$VARIANTS" ]; then
  echo "No completed variants found for $TASK" >&2
  exit 1
fi
mkdir -p "variants/${TASK}"
for VAR in $VARIANTS; do
  BRANCH="cloud/${TASK}/var${VAR}"
  if git show-ref --quiet --verify "refs/heads/$BRANCH"; then
    echo "Branch $BRANCH already exists; skipping export"
    continue
  fi
  git checkout "$BASE"
  git checkout -b "$BRANCH"
  OUTDIR="variants/${TASK}/var${VAR}"
  rm -rf "$OUTDIR"
  mkdir -p "$OUTDIR"
  codex cloud export --variant "$VAR" --dir "$OUTDIR" "$TASK"
  if [ -f "$OUTDIR/patch.diff" ]; then
    git apply "$OUTDIR/patch.diff"
  fi
  if [ -f package.json ]; then
    npm install >/dev/null 2>&1 || true
    if [ -f package-lock.json ]; then
      npm test > "$OUTDIR/test.log" 2>&1 || true
    fi
  fi
  git status -sb
  echo "Created branch $BRANCH"
  git checkout "$BASE"
done
