#!/usr/bin/env bash
# Usage:
#   scripts/codex-cloud-apply.sh <task_id> status
#   scripts/codex-cloud-apply.sh <task_id> export
#   scripts/codex-cloud-apply.sh <task_id> apply <base_branch> [--run-tests]
set -euo pipefail

usage() {
  cat <<USAGE
Usage:
  $0 <task_id> status
  $0 <task_id> export
  $0 <task_id> apply <base_branch> [--run-tests]
USAGE
  exit 1
}

if [ $# -lt 2 ]; then
  usage
fi

TASK=$1
shift
COMMAND=$1
shift

ROOT=$(git rev-parse --show-toplevel)
log() { echo "[$COMMAND] $*"; }

list_completed_variants() {
  codex cloud show "$TASK" --json --all |
    jq -r '.variants[] | select(.status=="completed") | .variant_index'
}

cmd_status() {
  codex cloud show "$TASK" --json --all |
    jq '.variants[] | {variant: .variant_index, status: .status, error: .error}'
}

cmd_export() {
  mkdir -p "$ROOT/variants/$TASK"
  local exported=0
  for VAR in $(list_completed_variants); do
    local outdir="$ROOT/variants/$TASK/var$VAR"
    rm -rf "$outdir"
    mkdir -p "$outdir"
    log "Exporting variant $VAR to $outdir"
    codex cloud export --variant "$VAR" --dir "$outdir" "$TASK"
    exported=1
  done
  if [ "$exported" -eq 0 ]; then
    log "No completed variants to export"
  fi
}

cmd_apply() {
  if [ $# -lt 1 ]; then
    usage
  fi
  local base=$1
  shift
  local run_tests=0
  while [ $# -gt 0 ]; do
    case $1 in
      --run-tests) run_tests=1; shift ;;
      *) usage ;;
    esac
  done

  if [ -n "$(git status --porcelain)" ]; then
    echo "Working tree dirty; please commit or stash changes before running." >&2
    exit 1
  fi

  mkdir -p "$ROOT/variants/$TASK"
  local summary=""
  for VAR in $(list_completed_variants); do
    local branch="cloud/${TASK}/var${VAR}"
    local outdir="$ROOT/variants/$TASK/var$VAR"
    if [ ! -d "$outdir" ]; then
      mkdir -p "$outdir"
      log "Exporting variant $VAR before apply"
      codex cloud export --variant "$VAR" --dir "$outdir" "$TASK"
    fi
    if git show-ref --quiet --verify "refs/heads/$branch"; then
      log "Branch $branch already exists; skipping"
      summary+="$branch already exists\n"
      continue
    fi
    log "Creating branch $branch from $base"
    git checkout "$base"
    git checkout -b "$branch"
    patch="$outdir/var$VAR/patch.diff"
    if [ -f "$patch" ]; then
      if git apply --3way "$patch"; then
        log "Applied diff for variant $VAR"
      else
        log "Failed to apply diff for variant $VAR"
        summary+="$branch: apply failed\n"
        git checkout "$base"
        git branch -D "$branch"
        continue
      fi
    else
      log "No patch found for variant $VAR"
    fi
    if [ $run_tests -eq 1 ]; then
      if [ -f package.json ]; then
        npm run --if-present test > "$outdir/var$VAR/test.log" 2>&1 || true
      fi
    fi
    git status -sb
    summary+="$branch: applied\n"
    git checkout "$base"
  done
  printf "%s" "$summary"
}

case "$COMMAND" in
  status) cmd_status ;;
  export) cmd_export ;;
  apply) cmd_apply "$@" ;;
  *) usage ;;
esac
