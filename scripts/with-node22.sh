#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
nvm_dir="${NVM_DIR:-$HOME/.nvm}"

if [[ ! -s "$nvm_dir/nvm.sh" ]]; then
  echo "HybridClaw requires Node.js 22.x via nvm, but $nvm_dir/nvm.sh was not found." >&2
  echo "Install/source nvm, then run: nvm install 22 && nvm use 22" >&2
  exit 1
fi

# shellcheck source=/dev/null
. "$nvm_dir/nvm.sh"
nvm use 22 >/dev/null

actual_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$actual_major" != "22" ]]; then
  echo "HybridClaw requires Node.js 22.x, but this process is running $(node -p process.version)." >&2
  exit 1
fi

cd "$repo_root"
exec "$@"
