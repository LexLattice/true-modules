#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <pr-number>" >&2
  exit 64
fi

PR_NUMBER="$1"
OWNER="LexLattice"
REPO="true-modules"

QUERY=$'query($number:Int!){repository(owner:"'"$OWNER"'",name:"'"$REPO"'"){pullRequest(number:$number){reviewThreads(first:100){nodes{path comments(first:100){nodes{author{login}body url createdAt diffHunk}}}}}}}'

data=$(gh api graphql -f query="$QUERY" -F number="$PR_NUMBER")

echo "$data" | jq -r '
  .data.repository.pullRequest.reviewThreads.nodes[]
  | {path, comments: (.comments.nodes // [] | map(select((.diffHunk // "") != "")))}
  | select(.comments | length > 0)
  | .path
  + "\n"
  + ( .comments | map("  [" + .author.login + "] " + .createdAt + "\n" + (.body | gsub("\r";"")) + "\n  " + .url) | join("\n\n") )
  + "\n"
'
