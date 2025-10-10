#!/usr/bin/env bash
set -euo pipefail
ID="${1:-}"
if [[ -z "$ID" ]]; then
  echo "usage: scaffold/make_module.sh <module.id>"; exit 1
fi
DIR="modules/${ID}"
mkdir -p "$DIR/src" "$DIR/tests"
cat > "${DIR}/module.json" <<'JSON'
{
  "id": "%ID%",
  "version": "0.1.0",
  "summary": "New module",
  "provides": ["ExamplePort@1"],
  "requires": [],
  "inputs": {},
  "outputs": {},
  "side_effects": [],
  "invariants": ["deterministic(outputs | inputs)"],
  "tests": ["tests/spec_example.json"],
  "evidence": [
    {"kind":"file","file":"src/lib.rs","lines":"1-1","note":"placeholder"}
  ]
}
JSON
sed -i.bak "s/%ID%/${ID}/g" "${DIR}/module.json" && rm -f "${DIR}/module.json.bak"
touch "${DIR}/src/lib.rs"
echo '{"name":"spec example"}' > "${DIR}/tests/spec_example.json"
echo "Created ${DIR}"
