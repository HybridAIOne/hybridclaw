#!/usr/bin/env bash
#
# HybridClaw one-line installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/scripts/install.sh | bash
#
# Or with options (note the extra `-s --` to pass flags through the pipe):
#   curl -fsSL https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/scripts/install.sh | bash -s -- --version 0.21.0 --no-onboarding
#
# What it does:
#   1. Detects your OS/arch (Linux + macOS; Windows users are pointed at WSL2).
#   2. Ensures Node.js 22 and npm >= 11.10.0 are available, installing a
#      user-local Node 22 into ~/.hybridclaw/node when no compatible one exists.
#      Downloaded Node tarballs are verified against nodejs.org's published
#      SHA-256 checksum. Alpine/musl needs a system Node (apk add nodejs npm)
#      plus --skip-node, since nodejs.org ships glibc builds only.
#   3. Installs the `hybridclaw` CLI globally from npm.
#   4. Checks for Docker (recommended for the default container sandbox).
#   5. Runs `hybridclaw onboarding` when attached to a terminal.
#
# For CI/headless use, pass --no-prompt; preview the plan with --dry-run; run a
# post-install smoke test with --verify.
#
# The HybridClaw runtime itself never needs root. The installer only touches
# your home directory and the npm global prefix; it never calls sudo.

# Require bash before any bash-only syntax below is parsed.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "This installer needs bash. Re-run with:" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/scripts/install.sh | bash" >&2
  exit 1
fi

# Download guard: bash parses to the matching closing brace at the end of the
# file before executing anything, so a `curl | bash` that is truncated
# mid-transfer fails to parse and runs nothing instead of executing a fragment.
{

set -euo pipefail

# --- Configuration (override via environment) --------------------------------

HYBRIDCLAW_HOME="${HYBRIDCLAW_HOME:-$HOME/.hybridclaw}"
PKG_NAME="@hybridaione/hybridclaw"
INSTALL_VERSION="${HYBRIDCLAW_INSTALL_VERSION:-latest}"
REQUIRED_NODE_MAJOR=22
REQUIRED_NPM="11.10.0"
# Fallback used only when nodejs.org is unreachable for version discovery.
NODE_VERSION_FALLBACK="${HYBRIDCLAW_NODE_VERSION:-22.20.0}"

# --- Flags (env vars provide defaults; CLI flags override below) -------------

RUN_ONBOARDING=1
CHECK_DOCKER=1
MANAGE_NODE=1
DRY_RUN="${HYBRIDCLAW_DRY_RUN:-0}"
VERIFY="${HYBRIDCLAW_VERIFY_INSTALL:-0}"
# Headless when HYBRIDCLAW_NO_PROMPT, the conventional NO_PROMPT, or CI is set.
if [ -n "${HYBRIDCLAW_NO_PROMPT:-}" ] || [ -n "${NO_PROMPT:-}" ] || [ -n "${CI:-}" ]; then
  NO_PROMPT=1
else
  NO_PROMPT=0
fi

# --- Output helpers ----------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_INFO=$'\033[36m'; C_OK=$'\033[32m'
  C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_BOLD=$'\033[1m'
else
  C_RESET=""; C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""; C_BOLD=""
fi

info()  { printf '%s==>%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
ok()    { printf '%s ✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn()  { printf '%s warn:%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
err()   { printf '%serror:%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; }
die()   { err "$@"; exit 1; }

is_dry() { [ "$DRY_RUN" -eq 1 ]; }
have()   { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
HybridClaw installer

Options:
  --version <ver>       Install a specific version (default: latest)
  --no-onboarding       Skip the interactive `hybridclaw onboarding` step
  --no-prompt           Headless/CI mode: never prompt, skip onboarding
  --dry-run             Print the steps without changing anything
  --verify              Run a post-install smoke test (version + doctor)
  --skip-docker-check   Do not warn when Docker is missing
  --skip-node           Use the Node.js already on PATH; never download Node
  -h, --help            Show this help

Environment:
  HYBRIDCLAW_HOME             Install root for managed Node (default: ~/.hybridclaw)
  HYBRIDCLAW_INSTALL_VERSION  Version to install (default: latest)
  HYBRIDCLAW_NODE_VERSION     Node version to fetch if one must be installed
  HYBRIDCLAW_NO_PROMPT=1      Same as --no-prompt (also honors NO_PROMPT / CI)
  HYBRIDCLAW_DRY_RUN=1        Same as --dry-run
  HYBRIDCLAW_VERIFY_INSTALL=1 Same as --verify
  NO_COLOR                    Disable colored output
EOF
}

# --- Argument parsing --------------------------------------------------------

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)        INSTALL_VERSION="${2:?--version requires a value}"; shift 2 ;;
    --version=*)      INSTALL_VERSION="${1#*=}"; shift ;;
    --no-onboarding)  RUN_ONBOARDING=0; shift ;;
    --no-prompt)      NO_PROMPT=1; shift ;;
    --dry-run)        DRY_RUN=1; shift ;;
    --verify)         VERIFY=1; shift ;;
    --skip-docker-check) CHECK_DOCKER=0; shift ;;
    --skip-node)      MANAGE_NODE=0; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                die "unknown option: $1 (try --help)" ;;
  esac
done

# --- Platform detection ------------------------------------------------------

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux)  PLATFORM_OS="linux" ;;
    Darwin) PLATFORM_OS="darwin" ;;
    MINGW*|MSYS*|CYGWIN*)
      die "Windows is not supported directly. Install inside WSL2 (Ubuntu) and re-run this script there." ;;
    *) die "unsupported operating system: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64) PLATFORM_ARCH="x64" ;;
    arm64|aarch64) PLATFORM_ARCH="arm64" ;;
    armv7l) PLATFORM_ARCH="armv7l" ;;
    *) die "unsupported architecture: $arch" ;;
  esac

  # nodejs.org publishes glibc builds only; detect musl (e.g. Alpine) so the
  # managed-Node path can refuse to download an incompatible tarball.
  PLATFORM_LIBC="glibc"
  if [ "$PLATFORM_OS" = "linux" ] && ldd --version 2>&1 | grep -qi musl; then
    PLATFORM_LIBC="musl"
  fi
}

# --- Node.js + npm -----------------------------------------------------------

version_ge() {
  # version_ge A B  -> true when A >= B (dotted numeric compare)
  [ "$1" = "$2" ] && return 0
  local lower
  lower="$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)"
  [ "$lower" = "$2" ]
}

resolve_node_version() {
  local v
  v="$(curl -fsSL --proto '=https' --tlsv1.2 --max-time 15 https://nodejs.org/dist/index.json 2>/dev/null \
        | grep -o '"version":"v22[^"]*"' | head -1 | sed 's/.*"v\(22[^"]*\)".*/\1/')" || true
  if [ -n "$v" ]; then
    printf '%s' "$v"
  else
    printf '%s' "$NODE_VERSION_FALLBACK"
  fi
}

sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 1
  fi
}

# Verify a downloaded Node tarball against nodejs.org's per-release SHASUMS256.
verify_node_checksum() {
  local file="$1" version="$2" filename="$3" expected actual
  expected="$(curl -fsSL --proto '=https' --tlsv1.2 --max-time 30 \
      "https://nodejs.org/dist/v${version}/SHASUMS256.txt" 2>/dev/null \
      | awk -v f="$filename" '$2 == f {print $1}')"
  if [ -z "$expected" ]; then
    warn "Could not fetch published checksum for ${filename}; skipping verification."
    return 0
  fi
  actual="$(sha256_of "$file")" || {
    warn "No sha256 tool (sha256sum/shasum) found; skipping checksum verification."
    return 0
  }
  if [ "$actual" != "$expected" ]; then
    die "Checksum mismatch for ${filename}
  expected ${expected}
  got      ${actual}
Refusing to install a corrupt or tampered Node.js download."
  fi
  ok "Verified Node.js download (sha256)"
}

install_managed_node() {
  local version dir filename url tarball
  if [ "${PLATFORM_LIBC:-glibc}" = "musl" ]; then
    die "Detected musl libc (e.g. Alpine). nodejs.org publishes glibc builds only.
Install Node ${REQUIRED_NODE_MAJOR} with your package manager and re-run with --skip-node:
    apk add --no-cache nodejs npm
    curl -fsSL https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/scripts/install.sh | bash -s -- --skip-node"
  fi

  version="$(resolve_node_version)"
  dir="$HYBRIDCLAW_HOME/node"
  filename="node-v${version}-${PLATFORM_OS}-${PLATFORM_ARCH}.tar.xz"
  url="https://nodejs.org/dist/v${version}/${filename}"

  if is_dry; then
    info "[dry-run] would download ${url}"
    info "[dry-run] would verify its sha256 against nodejs.org/dist/v${version}/SHASUMS256.txt"
    info "[dry-run] would extract Node.js v${version} into ${dir} and add ${dir}/bin to PATH"
    return 0
  fi

  info "Installing Node.js v${version} into ${dir} (no system changes)"
  mkdir -p "$dir"
  tarball="$(mktemp "${TMPDIR:-/tmp}/hybridclaw-node.XXXXXX.tar.xz")"
  trap 'rm -f "$tarball"' EXIT
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 -o "$tarball" "$url" \
    || die "failed to download Node.js from $url"
  verify_node_checksum "$tarball" "$version" "$filename"
  tar -xJf "$tarball" -C "$dir" --strip-components=1
  rm -f "$tarball"
  trap - EXIT

  NODE_BIN_DIR="$dir/bin"
  export PATH="$NODE_BIN_DIR:$PATH"
  persist_path "$NODE_BIN_DIR"
  ok "Node.js $("$NODE_BIN_DIR/node" --version) ready"
}

ensure_node() {
  local node_version major
  if have node; then
    node_version="$(node --version 2>/dev/null)"
    major="${node_version#v}"; major="${major%%.*}"
    if [ "$major" = "$REQUIRED_NODE_MAJOR" ]; then
      ok "Node.js $node_version detected"
      return
    fi
    if [ "$MANAGE_NODE" -eq 0 ]; then
      die "Node.js ${REQUIRED_NODE_MAJOR}.x is required, found $node_version. Switch versions (nvm/fnm) and retry."
    fi
    warn "Node.js $node_version found, but HybridClaw needs ${REQUIRED_NODE_MAJOR}.x"
  elif [ "$MANAGE_NODE" -eq 0 ]; then
    die "Node.js not found on PATH and --skip-node was set."
  fi

  if have fnm || have nvm; then
    warn "A Node version manager (fnm/nvm) is installed. You may prefer:"
    warn "    fnm install 22 && fnm use 22    # or: nvm install 22 && nvm use 22"
    warn "Continuing with a HybridClaw-managed Node 22 in ${HYBRIDCLAW_HOME}/node."
  fi
  install_managed_node
}

ensure_npm() {
  local npm_version
  if is_dry; then
    info "[dry-run] would ensure npm >= ${REQUIRED_NPM} (upgrading via 'npm install -g npm@^11' if needed)"
    return 0
  fi
  have npm || die "npm not found alongside Node.js; reinstall Node 22."
  npm_version="$(npm --version)"
  if version_ge "$npm_version" "$REQUIRED_NPM"; then
    ok "npm ${npm_version} detected"
    return
  fi
  info "Upgrading npm ${npm_version} -> >=${REQUIRED_NPM}"
  npm install -g "npm@^11" >/dev/null 2>&1 \
    || warn "could not upgrade npm automatically; continuing with ${npm_version}"
}

# --- PATH persistence --------------------------------------------------------

persist_path() {
  local dir="$1"
  if is_dry; then
    info "[dry-run] would add ${dir} to PATH in your shell rc files"
    return 0
  fi
  # Append an idempotent PATH export to the user's shell rc files.
  local marker="# added by HybridClaw installer"
  local line="export PATH=\"$dir:\$PATH\" $marker"
  local rc
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    [ -e "$rc" ] || continue
    grep -qsF "$dir $marker" "$rc" 2>/dev/null && continue
    printf '\n%s\n' "$line" >> "$rc"
  done
}

npm_global_bin() {
  local prefix
  prefix="$(npm prefix -g 2>/dev/null)" || return 1
  printf '%s/bin' "$prefix"
}

# --- Docker ------------------------------------------------------------------

check_docker() {
  [ "$CHECK_DOCKER" -eq 1 ] || return 0
  if ! have docker; then
    warn "Docker not found. The default container sandbox will be unavailable."
    warn "Install Docker (https://docs.docker.com/get-docker/) or run with --sandbox=host."
  elif docker info >/dev/null 2>&1; then
    ok "Docker is available (default container sandbox supported)"
  else
    warn "Docker is installed but its daemon is not reachable."
    warn "Start Docker, or run the gateway with --sandbox=host."
  fi
}

# --- Install -----------------------------------------------------------------

install_cli() {
  local spec="$PKG_NAME"
  [ "$INSTALL_VERSION" != "latest" ] && spec="${PKG_NAME}@${INSTALL_VERSION}"
  info "Installing ${spec} globally via npm"
  if is_dry; then
    info "[dry-run] would run: npm install -g ${spec}"
    return 0
  fi
  if ! npm install -g "$spec"; then
    err "Global npm install failed."
    err "If this was a permissions error, set a user-writable npm prefix:"
    err "    npm config set prefix \"$HYBRIDCLAW_HOME/npm-global\""
    err "    export PATH=\"$HYBRIDCLAW_HOME/npm-global/bin:\$PATH\""
    err "Then re-run this installer. (HybridClaw never needs sudo.)"
    exit 1
  fi

  local bin_dir
  bin_dir="$(npm_global_bin || true)"
  if [ -n "$bin_dir" ] && ! have hybridclaw; then
    export PATH="$bin_dir:$PATH"
    persist_path "$bin_dir"
    warn "Added npm global bin (${bin_dir}) to your PATH. Open a new shell if needed."
  fi
}

# --- Onboarding + next steps -------------------------------------------------

maybe_onboard() {
  if is_dry; then
    info "[dry-run] would verify hybridclaw is on PATH and (unless --no-prompt) run onboarding"
    return 0
  fi

  have hybridclaw \
    || die "hybridclaw was installed but is not on PATH yet. Open a new shell and run: hybridclaw onboarding"

  ok "Installed $(hybridclaw --version 2>/dev/null || echo "$PKG_NAME")"

  if [ "$RUN_ONBOARDING" -ne 1 ] || [ "$NO_PROMPT" -eq 1 ]; then
    info "Skipping interactive onboarding: run 'hybridclaw onboarding' when ready."
    return
  fi

  # When piped through `curl | bash`, stdin is the script, so read the wizard
  # from the controlling terminal if one is available.
  if [ ! -t 0 ] && [ ! -r /dev/tty ]; then
    info "Non-interactive shell: run 'hybridclaw onboarding' when ready."
    return
  fi

  info "Starting onboarding (Ctrl-C to skip and run it later)"
  if [ -t 0 ]; then
    hybridclaw onboarding || warn "onboarding did not complete; run 'hybridclaw onboarding' later"
  else
    hybridclaw onboarding </dev/tty || warn "onboarding did not complete; run 'hybridclaw onboarding' later"
  fi
}

run_verify() {
  [ "$VERIFY" -eq 1 ] || return 0
  if is_dry; then
    info "[dry-run] would run: hybridclaw --version && hybridclaw doctor --json"
    return 0
  fi

  info "Verifying installation"
  have hybridclaw || die "verification failed: 'hybridclaw' is not on PATH."
  local version_output
  version_output="$(hybridclaw --version 2>/dev/null)" \
    || die "verification failed: 'hybridclaw --version' did not run successfully."
  ok "hybridclaw --version -> $version_output"

  # doctor reflects environment health (e.g. Docker availability), so a non-zero
  # exit here is a warning about the host, not a broken install.
  if hybridclaw doctor --json >/dev/null 2>&1; then
    ok "hybridclaw doctor passed"
  else
    warn "hybridclaw doctor reported issues (often Docker/runtime env)."
    warn "Run 'hybridclaw doctor' for the full report."
  fi
}

print_next_steps() {
  cat <<EOF

${C_BOLD}HybridClaw is installed.${C_RESET}

Next steps:
  ${C_INFO}hybridclaw onboarding${C_RESET}   Connect a provider and save runtime secrets
  ${C_INFO}hybridclaw gateway${C_RESET}      Start the local gateway
  ${C_INFO}hybridclaw tui${C_RESET}          Open the terminal UI (in a second shell)

Local surfaces once the gateway runs:
  Chat   http://127.0.0.1:9090/chat
  Admin  http://127.0.0.1:9090/admin

Docs: https://hybridaione.github.io/hybridclaw/docs/getting-started/quickstart
EOF
}

# --- Main --------------------------------------------------------------------

main() {
  printf '%sHybridClaw installer%s\n\n' "$C_BOLD" "$C_RESET"
  is_dry && warn "Dry run: no changes will be made."
  have curl || die "curl is required but was not found."
  have tar  || die "tar is required but was not found."

  detect_platform
  ok "Platform: ${PLATFORM_OS}/${PLATFORM_ARCH} (${PLATFORM_LIBC})"

  ensure_node
  ensure_npm
  check_docker
  install_cli
  maybe_onboard
  run_verify
  is_dry && { info "Dry run complete; no changes were made."; return 0; }
  print_next_steps
}

main "$@"

} # end download guard — keep this brace as the final line of the file
