#!/usr/bin/env bash
# Helper for managing Codex Cloud Best-of runs.
# Usage:
#   scripts/cloud-bo4.sh <task_id> status
#   scripts/cloud-bo4.sh <task_id> export
#   scripts/cloud-bo4.sh <task_id> apply <base_branch> [--run-tests] [--no-commit]
# Environment:
#   CODEX_CLOUD_EXPORT_ROOT=/absolute/path (defaults to ~/.codex-cloud)
set -euo pipefail

usage() {
  cat <<USAGE
Usage:
  $0 <task_id> status
  $0 <task_id> export
  $0 <task_id> apply <base_branch> [--run-tests] [--no-commit]
USAGE
  exit 1
}

if [[ $# -lt 2 ]]; then
  usage
fi

TASK=$1; shift
COMMAND=$1; shift
EXPORT_ROOT=${CODEX_CLOUD_EXPORT_ROOT:-$HOME/.codex-cloud}
LOG(){ printf '[%s] %s\n' "$COMMAND" "$*"; }
VARIANT_DIR="$EXPORT_ROOT/variants/$TASK"

completed_variants() {
  codex cloud show "$TASK" --json --all | jq -r '.variants[] | select(.status=="completed") | .variant_index'
}

flatten_variant_dir() {
  local outdir=$1
  [[ -d "$outdir" ]] || return 0
  local entries=()
  while IFS= read -r entry; do
    entries+=("$entry")
  done < <(find "$outdir" -mindepth 1 -maxdepth 1 -print)
  if [[ ${#entries[@]} -ne 1 ]]; then
    return 0
  fi
  local nested="${entries[0]}"
  [[ -d "$nested" ]] || return 0
  shopt -s dotglob nullglob
  local contents=("$nested"/*)
  if [[ ${#contents[@]} -gt 0 ]]; then
    mv "${contents[@]}" "$outdir"/
  fi
  shopt -u dotglob nullglob
  rmdir "$nested"
}

variant_patch_path() {
  local outdir=$1
  if [[ -f "$outdir/patch.diff" ]]; then
    echo "$outdir/patch.diff"
  else
    find "$outdir" -maxdepth 2 -path "*/patch.diff" -print -quit
  fi
}

do_status() {
  codex cloud show "$TASK" --json --all |
    jq '.variants[] | {variant: .variant_index, status: .status, error: .error}'
}

do_export() {
  mkdir -p "$VARIANT_DIR"
  local exported=0
  for VAR in $(completed_variants); do
    local outdir="$VARIANT_DIR/var$VAR"
    rm -rf "$outdir"
    mkdir -p "$outdir"
    LOG "exporting variant $VAR to $outdir"
    codex cloud export --variant "$VAR" --dir "$outdir" "$TASK"
    flatten_variant_dir "$outdir"
    exported=1
  done
  if [[ $exported -eq 0 ]]; then
    LOG "no completed variants to export"
  fi
}

do_apply() {
  if [[ $# -lt 1 ]]; then
    usage
  fi
  local base=$1; shift
  local run_tests=0
  local auto_commit=1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --run-tests)
        run_tests=1
        shift
        ;;
      --no-commit)
        auto_commit=0
        shift
        ;;
      *)
        usage
        ;;
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
      LOG "exporting variant $VAR to $outdir"
      codex cloud export --variant "$VAR" --dir "$outdir" "$TASK"
      flatten_variant_dir "$outdir"
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
      logdir=$(dirname "$patch")
      npm run --if-present test >"$logdir/test.log" 2>&1 || true
    fi
    if [[ $auto_commit -eq 1 ]]; then
      git add -A
      if git diff --cached --quiet; then
        LOG "no changes staged for variant $VAR; skipping commit"
      else
        local commit_msg="chore: codex cloud $TASK var$VAR"
        if git commit -m "$commit_msg"; then
          LOG "committed variant $VAR with message: $commit_msg"
        else
          LOG "commit failed for variant $VAR"
          git reset --hard HEAD
          git checkout "$base"
          git branch -D "$branch"
          exit 1
        fi
      fi
    else
      LOG "auto-commit disabled; leaving applied changes unstaged"
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
