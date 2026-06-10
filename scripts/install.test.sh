#!/usr/bin/env bash
#
# Offline unit tests for scripts/install.sh.
#
#   bash scripts/install.test.sh
#
# These are fast, deterministic, and need no network: install.sh is sourced as
# a library (HYBRIDCLAW_INSTALL_LIB=1 skips main), and external commands such as
# uname/curl/ls/have are stubbed to drive each code path. The full end-to-end
# matrix (ubuntu/node:22/alpine in Docker) lives in
# tests/install-script.install-e2e.test.ts (npm run test:install-e2e).
#
# The stub functions below override commands the sourced install.sh functions
# call indirectly, which shellcheck's reachability pass can't see (SC2317); it
# also can't follow the runtime source of install.sh (SC1091). Silence both
# false positives file-wide so `shellcheck install.test.sh` stays clean.
# shellcheck disable=SC2317,SC1091

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

# All temp artifacts live under one root so an interrupted run leaks nothing;
# the chmod undoes the read-only fixture before rm for non-root users.
TEST_TMPDIR="$(mktemp -d)"
trap 'chmod -R u+w "$TEST_TMPDIR" 2>/dev/null; rm -rf "$TEST_TMPDIR"' EXIT

# Load install.sh's functions without running it. Clear positional params so
# its argument parser sees nothing.
set --
HYBRIDCLAW_INSTALL_LIB=1 NO_COLOR=1 source "$HERE/install.sh"
set +eu +o pipefail # the tests below manage their own exit-status checks

PASS=0
FAIL=0
ok()  { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL   %s\n' "$1"; FAIL=$((FAIL + 1)); }

expect_eq() { # desc expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi
}
expect_rc() { # desc expected_rc actual_rc
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — expected rc $2, got $3"; fi
}
expect_contains() { # desc needle haystack
  case "$3" in
    *"$2"*) ok "$1" ;;
    *) bad "$1 — output missing [$2]" ;;
  esac
}

echo "== package.json consistency =="
# Tolerates key order and range prefixes (">=22") inside the engines block.
engines_major="$(tr -d ' \t\n' < "$HERE/../package.json" \
  | sed -n 's/.*"engines":{[^}]*"node":"[^0-9"]*\([0-9][0-9]*\).*/\1/p')"
expect_eq "REQUIRED_NODE_MAJOR matches engines.node" "$engines_major" "$REQUIRED_NODE_MAJOR"

echo "== is_truthy / NO_PROMPT derivation =="
is_truthy 1 && is_truthy true && is_truthy YES && is_truthy On
expect_rc "is_truthy accepts 1/true/yes/on" 0 "$?"
! is_truthy 0 && ! is_truthy false && ! is_truthy "" && ! is_truthy maybe
expect_rc "is_truthy rejects 0/false/empty/garbage" 0 "$?"
# The derivation runs at source time, so re-source in a clean env per case.
no_prompt_for() { # [VAR=val ...] -> echoes the derived NO_PROMPT
  env -i HOME="$HOME" PATH="$PATH" "$@" bash -c \
    'set --; HYBRIDCLAW_INSTALL_LIB=1 NO_COLOR=1 source "$0"; echo "$NO_PROMPT"' \
    "$HERE/install.sh"
}
expect_eq "CI=false stays interactive"          "0" "$(no_prompt_for CI=false)"
expect_eq "CI=true goes headless"               "1" "$(no_prompt_for CI=true)"
expect_eq "NO_PROMPT=0 stays interactive"       "0" "$(no_prompt_for NO_PROMPT=0)"
expect_eq "HYBRIDCLAW_NO_PROMPT=yes goes headless" "1" "$(no_prompt_for HYBRIDCLAW_NO_PROMPT=yes)"
expect_eq "no env stays interactive"            "0" "$(no_prompt_for)"

echo "== argument parsing =="
parse_args() { # args... -> sources install.sh with them, echoes INSTALL_VERSION
  env -i HOME="$HOME" PATH="$PATH" bash -c \
    'HYBRIDCLAW_INSTALL_LIB=1 NO_COLOR=1 source "$0"; echo "$INSTALL_VERSION"' \
    "$HERE/install.sh" "$@"
}
expect_eq "--version <ver> form" "1.2.3" "$(parse_args --version 1.2.3)"
expect_eq "--version=<ver> form" "9.9.9" "$(parse_args --version=9.9.9)"
out="$(parse_args --bogus 2>&1)"
expect_rc "unknown option dies" 1 "$?"
expect_contains "unknown option message" "unknown option" "$out"
out="$(parse_args --help 2>&1)"
expect_rc "--help exits 0" 0 "$?"
expect_contains "--help prints usage" "HybridClaw installer" "$out"

echo "== resolve_node_version =="
v="$( ( curl() { return 1; }; resolve_node_version; echo "$NODE_VERSION" ) )"
expect_eq "offline -> pinned fallback" "$NODE_VERSION_FALLBACK" "$v"
v="$( ( curl() { printf 'abc1  node-v22.31.4-linux-x64.tar.gz\nabc2  node-v22.31.4-darwin-arm64.tar.gz\n'; }
        resolve_node_version; echo "$NODE_VERSION" ) )"
expect_eq "parses latest from SHASUMS256.txt" "22.31.4" "$v"
v="$( ( curl() { printf 'abc1  node-v22.31.4-linux-x64.tar.gz\n'; }
        HYBRIDCLAW_NODE_VERSION=22.11.0 resolve_node_version; echo "$NODE_VERSION" ) )"
expect_eq "explicit HYBRIDCLAW_NODE_VERSION pin wins" "22.11.0" "$v"
# The stubs above ignore curl's arguments; pin the actual URLs requested.
url_log="$TEST_TMPDIR/urls"
url_capturing_curl() { # records https URLs to $url_log, then fails the fetch
  local a
  for a in "$@"; do case "$a" in https://*) echo "$a" >>"$url_log" ;; esac; done
  return 1
}
: >"$url_log"
( curl() { url_capturing_curl "$@"; }
  resolve_node_version )
expect_contains "resolve fetches the latest-v<major> SHASUMS" \
  "https://nodejs.org/dist/latest-v${REQUIRED_NODE_MAJOR}.x/SHASUMS256.txt" "$(cat "$url_log")"

echo "== install_managed_node (dry-run) =="
# Pins the .tar.gz download contract: a regression back to .tar.xz would break
# minimal Debian/Ubuntu images without xz (previously caught only by the
# Docker e2e suite).
out="$( ( curl() { return 1; }
        DRY_RUN=1; PLATFORM_OS=linux; PLATFORM_ARCH=x64; PLATFORM_LIBC=glibc
        install_managed_node ) 2>&1 )"
expect_contains "managed-node URL uses .tar.gz" "node-v${NODE_VERSION_FALLBACK}-linux-x64.tar.gz" "$out"

echo "== sha256_of =="
tmp="$(mktemp "$TEST_TMPDIR/f.XXXXXX")"; printf 'hybridclaw' >"$tmp"
expect_eq "sha256_of known string" \
  "c1b0e433aa7b46071b1c5a5e6470a2e473a7dbc4d9909a38ca16cca9732beac0" \
  "$(sha256_of "$tmp")"
rm -f "$tmp"

echo "== detect_platform =="
# desc | uname -s | uname -m | expected "os arch libc"
plat() { # stubs uname, runs detect_platform in a subshell, echoes result
  local s="$1" m="$2"
  ( uname() { case "$1" in -s) echo "$s" ;; -m) echo "$m" ;; esac; }
    detect_platform 2>/dev/null # silence the armv7l limited-support warning
    echo "$PLATFORM_OS $PLATFORM_ARCH $PLATFORM_LIBC" )
}
expect_eq "linux/x86_64 -> x64 glibc"  "linux x64 glibc"    "$(plat Linux x86_64)"
expect_eq "linux/aarch64 -> arm64"     "linux arm64 glibc"  "$(plat Linux aarch64)"
expect_eq "linux/armv7l"               "linux armv7l glibc" "$(plat Linux armv7l)"
expect_eq "darwin/arm64"               "darwin arm64 glibc" "$(plat Darwin arm64)"

# musl detection: stub `ls` so the ld-musl glob "matches".
musl_libc="$(
  ( uname() { case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac; }
    ls() { return 0; }
    detect_platform
    echo "$PLATFORM_LIBC" )
)"
expect_eq "musl loader present -> musl" "musl" "$musl_libc"

# unsupported arch and Windows must die loudly.
out="$( ( uname() { case "$1" in -s) echo Linux ;; -m) echo ppc64 ;; esac; }
        detect_platform ) 2>&1 )"
expect_rc "unsupported arch dies" 1 "$?"
expect_contains "unsupported arch message" "unsupported architecture" "$out"

out="$( ( uname() { case "$1" in -s) echo MINGW64_NT ;; -m) echo x86_64 ;; esac; }
        detect_platform ) 2>&1 )"
expect_rc "windows dies" 1 "$?"
expect_contains "windows -> WSL2 hint" "WSL2" "$out"

echo "== verify_node_checksum =="
tmp="$(mktemp "$TEST_TMPDIR/f.XXXXXX")"; printf 'pretend-node-tarball' >"$tmp"
good="$(sha256_of "$tmp")"
fn="node-vTEST-linux-x64.tar.gz"

# Matching checksum -> succeeds quietly.
( curl() { printf '%s  %s\n' "$good" "$fn"; }
  verify_node_checksum "$tmp" TEST "$fn" ) >/dev/null 2>&1
expect_rc "matching checksum passes" 0 "$?"

# Mismatched checksum -> dies, refusing the download.
out="$( ( curl() { printf '%s  %s\n' deadbeefdeadbeef "$fn"; }
          verify_node_checksum "$tmp" TEST "$fn" ) 2>&1 )"
expect_rc "mismatched checksum dies" 1 "$?"
expect_contains "mismatch message" "Checksum mismatch" "$out"

# No published checksum available -> warns and skips (non-fatal).
out="$( ( curl() { printf ''; }
          verify_node_checksum "$tmp" TEST "$fn" ) 2>&1 )"
expect_rc "absent checksum is non-fatal" 0 "$?"
expect_contains "absent checksum warns" "skipping verification" "$out"

# The per-version fetch must hit the version's own SHASUMS URL.
: >"$url_log"
( curl() { url_capturing_curl "$@"; }
  verify_node_checksum "$tmp" 22.0.0 "$fn" ) >/dev/null 2>&1
expect_contains "verify fetches the per-version SHASUMS" \
  "https://nodejs.org/dist/v22.0.0/SHASUMS256.txt" "$(cat "$url_log")"

echo "== verify_node_checksum (NODE_SHASUMS cache) =="
# Cache hit wins: curl serves a WRONG sum, the cached body the right one.
( curl() { printf '%s  %s\n' deadbeefdeadbeef "$fn"; }
  NODE_SHASUMS="$good  $fn"
  verify_node_checksum "$tmp" CACHE "$fn" ) >/dev/null 2>&1
expect_rc "cached SHASUMS verifies without fetching" 0 "$?"
# Cached mismatch dies even though a refetch would have returned the good sum.
out="$( ( curl() { printf '%s  %s\n' "$good" "$fn"; }
          NODE_SHASUMS="deadbeefdeadbeef  $fn"
          verify_node_checksum "$tmp" CACHE "$fn" ) 2>&1 )"
expect_rc "cached mismatch dies" 1 "$?"
# Filename absent from the cache falls through to the fetch.
( curl() { printf '%s  %s\n' "$good" "$fn"; }
  NODE_SHASUMS="aaaa  some-other-file.tar.gz"
  verify_node_checksum "$tmp" CACHE "$fn" ) >/dev/null 2>&1
expect_rc "cache miss falls through to fetch" 0 "$?"
rm -f "$tmp"

echo "== dir_writable =="
writable_dir="$(mktemp -d "$TEST_TMPDIR/d.XXXXXX")"
dir_writable "$writable_dir"
expect_rc "writable existing dir" 0 "$?"
# A path under a writable parent that does not exist yet is still creatable.
dir_writable "$writable_dir/lib/node_modules"
expect_rc "creatable under writable parent" 0 "$?"
# A read-only directory's children are not creatable. Root bypasses permission
# bits, so this case is only meaningful (and only run) for an unprivileged user.
ro_dir="$writable_dir/ro"; mkdir -p "$ro_dir"; chmod a-w "$ro_dir"
if [ "$(id -u)" != 0 ] && [ ! -w "$ro_dir" ]; then
  dir_writable "$ro_dir/node_modules"
  expect_rc "non-writable parent rejected" 1 "$?"
else
  ok "non-writable parent rejected (skipped: running as root bypasses perms)"
fi
chmod u+w "$ro_dir" 2>/dev/null; rm -rf "$writable_dir"

echo "== check_build_prereqs =="
out="$( ( have() { return 0; } # all tools present
          check_build_prereqs ) 2>&1 )"
expect_eq "no warning when toolchain present" "" "$out"

out="$( ( have() { return 1; } # nothing present
          check_build_prereqs ) 2>&1 )"
expect_contains "warns when toolchain missing" "Build tools may be missing" "$out"

# Argument-aware stubs: the probe must name exactly what is missing.
out="$( ( have() { [ "$1" = make ] && return 1; return 0; }
          check_build_prereqs ) 2>&1 )"
expect_contains "only make listed missing" "missing: make." "$out"
out="$( ( have() { case "$1" in g++|clang++|c++) return 1 ;; *) return 0 ;; esac; }
          check_build_prereqs ) 2>&1 )"
expect_contains "compiler alternatives all probed" "missing: a C/C++ compiler (g++)." "$out"

echo "== ensure_node =="
# Matching major short-circuits; the managed install must not run.
out="$( ( have() { [ "$1" = node ]; }
          node() { echo "v${REQUIRED_NODE_MAJOR}.4.0"; }
          install_managed_node() { echo "MANAGED_INSTALL_CALLED"; }
          ensure_node ) 2>&1 )"
expect_contains "matching major detected" "v${REQUIRED_NODE_MAJOR}.4.0 detected" "$out"
case "$out" in
  *MANAGED_INSTALL_CALLED*) bad "matching major skips managed install" ;;
  *) ok "matching major skips managed install" ;;
esac
# Wrong major with --skip-node dies, naming the found version.
out="$( ( have() { [ "$1" = node ]; }
          node() { echo "v20.1.0"; }
          MANAGE_NODE=0
          ensure_node ) 2>&1 )"
expect_rc "wrong major with --skip-node dies" 1 "$?"
expect_contains "skip-node die names found version" "v20.1.0" "$out"
# Missing node with --skip-node dies.
( have() { return 1; }
  MANAGE_NODE=0
  ensure_node ) >/dev/null 2>&1
expect_rc "missing node with --skip-node dies" 1 "$?"
# A node that fails --version falls through to the managed install.
out="$( ( have() { [ "$1" = node ]; }
          node() { return 1; }
          install_managed_node() { echo "MANAGED_INSTALL_CALLED"; }
          ensure_node ) 2>&1 )"
expect_contains "broken node falls through to managed install" "MANAGED_INSTALL_CALLED" "$out"

echo "== npm_global_bin =="
out="$( ( NPM_PREFIX="/cached/prefix"
          npm() { echo /wrong; }
          npm_global_bin ) )"
expect_eq "uses cached NPM_PREFIX without asking npm" "/cached/prefix/bin" "$out"
out="$( ( NPM_PREFIX=""
          npm() { echo /from/npm; }
          npm_global_bin ) )"
expect_eq "falls back to npm prefix -g" "/from/npm/bin" "$out"

echo "== add_to_path =="
fake_home="$(mktemp -d "$TEST_TMPDIR/home.XXXXXX")"
# zsh with no rc files: the login rc is created with the export line.
( HOME="$fake_home"; SHELL=/bin/zsh; add_to_path /opt/hc/bin )
expect_contains "zsh login rc created with export line" \
  'export PATH="/opt/hc/bin:$PATH" # added by HybridClaw installer' \
  "$(cat "$fake_home/.zshrc" 2>/dev/null)"
# Re-runs must not duplicate the line.
( HOME="$fake_home"; SHELL=/bin/zsh; add_to_path /opt/hc/bin; add_to_path /opt/hc/bin )
expect_eq "re-runs do not duplicate the line" "1" \
  "$(grep -c 'added by HybridClaw installer' "$fake_home/.zshrc")"
# An existing ~/.bash_profile is updated (macOS bash login shells skip .profile).
fake_home="$(mktemp -d "$TEST_TMPDIR/home.XXXXXX")"
touch "$fake_home/.bash_profile"
( HOME="$fake_home"; SHELL=/bin/bash; add_to_path /opt/hc/bin )
grep -q 'added by HybridClaw installer' "$fake_home/.bash_profile"
expect_rc "existing .bash_profile updated" 0 "$?"
# fish gets fish syntax in config.fish and no POSIX rc files.
fake_home="$(mktemp -d "$TEST_TMPDIR/home.XXXXXX")"
( HOME="$fake_home"; SHELL=/usr/bin/fish; XDG_CONFIG_HOME=""; add_to_path /opt/hc/bin )
expect_contains "fish config gets fish_add_path" \
  'fish_add_path --prepend "/opt/hc/bin"' \
  "$(cat "$fake_home/.config/fish/config.fish" 2>/dev/null)"
[ ! -e "$fake_home/.profile" ]
expect_rc "fish writes no POSIX rc file" 0 "$?"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
