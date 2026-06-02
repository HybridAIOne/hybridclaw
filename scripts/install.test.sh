#!/usr/bin/env bash
#
# Offline unit tests for scripts/install.sh.
#
#   bash scripts/install.test.sh
#
# These are fast, deterministic, and need no network: install.sh is sourced as
# a library (HYBRIDCLAW_INSTALL_LIB=1 skips main), and external commands such as
# uname/curl/ls/have are stubbed to drive each code path. The full end-to-end
# matrix (alpine/debian/node:22 in Docker) is documented in the PR.
#
# The stub functions below override commands the sourced install.sh functions
# call indirectly, which shellcheck's reachability pass can't see (SC2317); it
# also can't follow the runtime source of install.sh (SC1091). Silence both
# false positives file-wide so `shellcheck install.test.sh` stays clean.
# shellcheck disable=SC2317,SC1091

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

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

echo "== version_ge =="
for case in "11.10.0 11.10.0 0" "11.10.1 11.10.0 0" "12.0.0 11.10.0 0" \
            "10.9.0 11.10.0 1" "11.9.9 11.10.0 1" "22.22.3 22.20.0 0"; do
  # shellcheck disable=SC2086 # intentional split of the space-separated triple
  set -- $case
  version_ge "$1" "$2"
  expect_rc "version_ge $1 >= $2" "$3" "$?"
done

echo "== sha256_of =="
tmp="$(mktemp)"; printf 'hybridclaw' >"$tmp"
expect_eq "sha256_of known string" \
  "c1b0e433aa7b46071b1c5a5e6470a2e473a7dbc4d9909a38ca16cca9732beac0" \
  "$(sha256_of "$tmp")"
rm -f "$tmp"

echo "== detect_platform =="
# desc | uname -s | uname -m | expected "os arch libc"
plat() { # stubs uname, runs detect_platform in a subshell, echoes result
  local s="$1" m="$2"
  ( uname() { case "$1" in -s) echo "$s" ;; -m) echo "$m" ;; esac; }
    detect_platform
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
tmp="$(mktemp)"; printf 'pretend-node-tarball' >"$tmp"
good="$(sha256_of "$tmp")"
fn="node-vTEST-linux-x64.tar.xz"

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
rm -f "$tmp"

echo "== check_build_prereqs =="
out="$( ( have() { return 0; } # all tools present
          check_build_prereqs ) 2>&1 )"
expect_eq "no warning when toolchain present" "" "$out"

out="$( ( have() { return 1; } # nothing present
          check_build_prereqs ) 2>&1 )"
expect_contains "warns when toolchain missing" "Build tools may be missing" "$out"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
