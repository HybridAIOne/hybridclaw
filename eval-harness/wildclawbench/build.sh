#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
read_manifest() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$here/manifest.json" "$1"
}
git -C "$repo" merge-base --is-ancestor "$(read_manifest hybridclaw_commit)" HEAD || {
  echo "HybridClaw source must descend from the recorded baseline" >&2
  exit 1
}
# Every build input must belong to the recorded source revision.
[[ -z "$(git -C "$repo" status --porcelain --untracked-files=all)" ]] || {
  echo "Build from a clean checkout, including untracked files" >&2
  exit 1
}
base="$(read_manifest base_image)"
docker image inspect "$base" >/dev/null
platform="$(docker image inspect "$base" --format '{{.Os}}/{{.Architecture}}')"
node_version="$(python3 -c 'import json,sys,re; print(re.search(r">=([0-9.]+)",json.load(open(sys.argv[1]))["engines"]["node"])[1])' "$repo/package.json")"
source_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$repo/package.json")"
docker build --platform "$platform" -f "$here/Dockerfile" --build-arg "BASE_IMAGE=$base" \
  --build-arg "NODE_VERSION=$node_version" --build-arg "SOURCE_COMMIT=$(git -C "$repo" rev-parse HEAD)" --build-arg "SOURCE_VERSION=$source_version" -t "$(read_manifest agent_image)" "$repo"
