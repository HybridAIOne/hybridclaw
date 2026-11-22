#!/usr/bin/env bash
# Builds the runtime archive hybridclaw_harbor.py uploads into each sandbox,
# and the manifest it checks the archive against.
# Usage (repo root, dependencies installed): build-runtime.sh <output-dir>
set -euo pipefail

out=${1:?usage: build-runtime.sh <output-dir>}
here=$(cd "$(dirname "$0")" && pwd)
context=$(mktemp -d)
trap 'rm -rf "$context"' EXIT
mkdir -p "$out"

npm run build
node "$here/build-api.mjs"
# --ignore-scripts: prepack would clean dist/ and drop the adapter entry.
package=$(npm pack --ignore-scripts --pack-destination "$context" --json |
  node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0, "utf8"))[0].filename)')
mv "$context/$package" "$context/package.tgz"
cp "$here/runtime.Dockerfile" "$context/Dockerfile"

image=hybridclaw-harbor-runtime
docker build --build-arg "NODE_VERSION=$(cat .nvmrc)" -t "$image" "$context"
docker run --rm --platform linux/amd64 "$image" \
  tar -czf - -C / opt/hybridclaw-node opt/hybridclaw-install \
  >"$out/hybridclaw-runtime.tgz"

node -e '
  const fs = require("node:fs");
  const { execSync } = require("node:child_process");
  const [archive] = process.argv.slice(1);
  const git = (args) => execSync(`git ${args}`, { encoding: "utf8" }).trim();
  fs.writeFileSync(
    archive.replace(/\.tgz$/, ".json"),
    `${JSON.stringify(
      {
        version: require("./package.json").version,
        gitCommit: git("rev-parse HEAD"),
        dirty: git("status --porcelain") !== "",
        sha256: require("node:crypto")
          .createHash("sha256")
          .update(fs.readFileSync(archive))
          .digest("hex"),
      },
      null,
      2,
    )}\n`,
  );
' "$out/hybridclaw-runtime.tgz"
echo "Runtime archive: $out/hybridclaw-runtime.tgz"
