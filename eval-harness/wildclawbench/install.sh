#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bench="$(cd "${1:?Usage: install.sh /path/to/WildClawBench}" && pwd)"
expected="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["wildclawbench_commit"])' "$here/manifest.json")"
[[ "$(git -C "$bench" rev-parse HEAD)" == "$expected" ]] || {
  echo "WildClawBench commit differs from the pinned comparison checkout" >&2
  exit 1
}
[[ ! -e "$bench/src/agents/hybridclaw" ]] || {
  echo "HybridClaw adapter already exists; inspect it before replacing" >&2
  exit 1
}
git -C "$bench" apply --check "$here/integration.patch"
git -C "$bench" apply "$here/integration.patch"
mkdir -p "$bench/src/agents/hybridclaw"
cp "$here/runner.py" "$here/evidence.py" "$here/manifest.json" "$bench/src/agents/hybridclaw/"
touch "$bench/src/agents/hybridclaw/__init__.py"
