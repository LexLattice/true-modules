#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

usage() {
  cat <<'USAGE'
Usage: scripts/lessons-auto.sh [--commit] [--out <file>]

Options:
  --commit       Commit updated lessons output when changes are detected.
  --out <file>   Override the lessons output path (defaults to lessons.json).
  --help         Show this help message.
USAGE
}

MODE="artifact"
OUT_PATH_INPUT="lessons.json"
COMMIT_MESSAGE=${LESSONS_COMMIT_MESSAGE:-"chore: refresh lessons index"}

default_git_user() {
  echo "true-modules-bot"
}

default_git_email() {
  echo "true-modules-bot@users.noreply.github.com"
}

resolve_path() {
  node -e "const path=require('path'); process.stdout.write(path.resolve(process.argv[2]));" -- "$1"
}

relative_to_repo() {
  node -e "const path=require('path'); const repo=path.resolve(process.argv[2]); const target=path.resolve(process.argv[3]); const rel=path.relative(repo, target); process.stdout.write(rel || target);" -- "$REPO_ROOT" "$1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit)
      MODE="commit"
      shift
      ;;
    --out)
      [[ $# -ge 2 ]] || { echo "--out requires a file path" >&2; exit 1; }
      OUT_PATH_INPUT="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

cd "$REPO_ROOT"

OUT_FILE=$(resolve_path "$OUT_PATH_INPUT")
run_tm() {
  node "$REPO_ROOT/tm.mjs" "$@"
}

mkdir -p "$(dirname "$OUT_FILE")"

run_tm lessons mine --from '**/report.json' --out "$OUT_FILE"

REL_OUT=$(relative_to_repo "$OUT_FILE")

echo "lessons-auto: mined lessons → $REL_OUT"

if [[ "$MODE" == "commit" ]]; then
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    git config user.name "${LESSONS_GIT_USER:-$(default_git_user)}"
    git config user.email "${LESSONS_GIT_EMAIL:-$(default_git_email)}"
  fi
  git add "$REL_OUT"
  if git diff --cached --quiet -- "$REL_OUT"; then
    echo "lessons-auto: no changes detected; skipping commit"
    exit 0
  fi
  git commit -m "$COMMIT_MESSAGE"
  echo "lessons-auto: committed $REL_OUT"
fi
