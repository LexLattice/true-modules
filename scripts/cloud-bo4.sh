#!/usr/bin/env bash
# Helper for managing Codex Cloud Best-of runs.
# Usage:
#   scripts/cloud-bo4.sh <task_id> status
#   scripts/cloud-bo4.sh <task_id> export
#   scripts/cloud-bo4.sh <task_id> apply <base_branch> [--run-tests]
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

[[ $# -ge 2 ]] || usage

TASK=$1; shift
COMMAND=$1; shift
ROOT=$(git rev-parse --show-toplevel)
LOG(){ printf '[%s] %s\n' "$COMMAND" "$*"; }
VARIANT_DIR="$ROOT/variants/$TASK"

completed_variants() {
  codex cloud show "$TASK" --json --all | jq -r '.variants[] | select(.status=="completed") | .variant_index'
}

do_status() {
  codex cloud show "$TASK" --json --all |
    jq '.variants[] | {variant: .variant_index, status: .status, error: .error}'
}

variant_patch_path() {
  local outdir=$1
  if [[ -f "$outdir/patch.diff" ]]; then
    echo "$outdir/patch.diff"
  elif [[ -f "$outdir"/var*/patch.diff ]]; then
    # Grab the first child directory (export layout varN/patch.diff)
    find "$outdir" -maxdepth 2 -path "*/patch.diff" -print -quit
  else
    echo ""; return 1
  fi
}

do_export() {
  mkdir -p "$VARIANT_DIR"
  local found=0
  for VAR in $(completed_variants); do
    local outdir="$VARIANT_DIR/var$VAR"
    rm -rf "$outdir"
    mkdir -p "$outdir"
    LOG "exporting variant $VAR"
    codex cloud export --variant "$VAR" --dir "$outdir" "$TASK"
    found=1
  done
  [[ $found -eq 1 ]] || LOG "no completed variants to export"
}

do_apply() {
  [[ $# -ge 1 ]] || usage
  local base=$1; shift
  local run_tests=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --run-tests) run_tests=1; shift ;;
      *) usage ;;
    esac
  done

  if [[ -n $(git status --porcelain) ]]; then
    echo "Working tree dirty; commit or stash first" >&2
    exit 1
  fi

  mkdir -p "$VARIANT_DIR"
  for VAR in $(completed_variants); do
    local branch="cloud/$TASK/var$VAR"
    local outdir="$VARIANT_DIR/var$VAR"
    if [[ ! -d "$outdir" ]]; then
      mkdir -p "$outdir"
      LOG "exporting variant $VAR"
      codex cloud export --variant "$VAR" --dir "$outdir" "$TASK"
    fi
    if git show-ref --quiet --verify "refs/heads/$branch"; then
      LOG "branch $branch already exists, skipping"
      continue
    fi
    local patch
    patch=$(variant_patch_path "$outdir") || {
      LOG "no patch for variant $VAR, branch skipped"; continue; }

    LOG "creating branch $branch from $base"
    git checkout "$base"
    git checkout -b "$branch"
    if git apply --3way "$patch"; then
      LOG "applied diff for variant $VAR"
    else
      LOG "failed to apply diff for variant $VAR"
      git checkout "$base"
      git branch -D "$branch"
      continue
    fi
    if [[ $run_tests -eq 1 && -f package.json ]]; then
      local logdir
      if [[ -d "$outdir/var$VAR" ]]; then logdir="$outdir/var$VAR"; else logdir="$outdir"; fi
      npm run --if-present test >"$logdir/test.log" 2>&1 || true
    fi
    git status -sb
    git checkout "$base"
  done
}

case "$COMMAND" in
  status) do_status ;;
  export) do_export ;;
  apply) do_apply "$@" ;;
  *) usage ;;
esac
