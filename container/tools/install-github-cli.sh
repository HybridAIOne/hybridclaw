#!/bin/sh
# Installs the GitHub CLI into both agent images and lets git ask it for
# github.com credentials; both use the GH_TOKEN shell commands receive.
# 2.102.1 (2026-10-20): the newest release past a two-week age gate on 2026-11-05.
set -eu
version=2.102.1
arch=$(dpkg --print-architecture)
case "$arch" in
  amd64) sha=77b9e297e94c50336823d0f84de7ef1be60cba704601fa0d98f129f47a94987b ;;
  arm64) sha=5019b3cc6e8a03bb4d88600f8dbda2add8e6407705c159b0c63151036e77a1af ;;
  *) echo "no GitHub CLI build for $arch" >&2; exit 1 ;;
esac
curl -fsSL -o /tmp/gh.tar.gz \
  "https://github.com/cli/cli/releases/download/v${version}/gh_${version}_linux_${arch}.tar.gz"
echo "${sha}  /tmp/gh.tar.gz" | sha256sum -c -
tar -xzf /tmp/gh.tar.gz -C /usr/local --strip-components=1 \
  "gh_${version}_linux_${arch}/bin/gh"
rm -f /tmp/gh.tar.gz
git config --system credential.https://github.com.helper '!gh auth git-credential'
gh --version
