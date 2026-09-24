#!/bin/sh
set -eu

# Upstream's GNU/Linux build requires glibc 2.39; the pinned Node image has 2.36.
version=0.22.5
case "${1:-}" in
  amd64)
    target=x86_64
    checksum=4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920
    ;;
  arm64)
    target=aarch64
    checksum=e700fe63524932b10ec2130b47ece90aa850e66005fe52ccfc4cf8767bf9919a
    ;;
  *)
    echo "Unsupported gws architecture: ${1:-unset}" >&2
    exit 1
    ;;
esac

archive="google-workspace-cli-${target}-unknown-linux-musl.tar.gz"
url="https://github.com/googleworkspace/cli/releases/download/v${version}/${archive}"
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
curl -fsSL "$url" -o "$temp_dir/$archive"
printf '%s  %s\n' "$checksum" "$temp_dir/$archive" | sha256sum -c -
tar -xzf "$temp_dir/$archive" -C "$temp_dir" ./gws
install -m 0755 "$temp_dir/gws" "${2:-/usr/local/bin}/gws"
"${2:-/usr/local/bin}/gws" --help >/dev/null
