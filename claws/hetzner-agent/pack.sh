#!/usr/bin/env bash
# Build hetzner-agent.claw: bundle the three Hetzner skills from the repo and zip.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_skills="$here/../../skills"
out="$here/hetzner-agent.claw"
skills=(hetzner-cloud hetzner-dns hetzner-storage-box)

build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT

cp "$here/manifest.json" "$build/manifest.json"
cp -R "$here/workspace" "$build/workspace"
mkdir -p "$build/skills"
for s in "${skills[@]}"; do
  if [ ! -d "$repo_skills/$s" ]; then
    echo "missing skill: $repo_skills/$s" >&2
    exit 1
  fi
  cp -R "$repo_skills/$s" "$build/skills/$s"
done

rm -f "$out"
( cd "$build" && zip -r -q "$out" . -x '*.DS_Store' )
echo "built $out"
