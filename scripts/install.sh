#!/usr/bin/env bash
#
# HybridClaw one-line installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/scripts/install.sh | bash
#
# Or with options (note the extra `-s --` to pass flags through the pipe):
#   curl -fsSL https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/scripts/install.sh | bash -s -- --version 0.22.0 --no-onboarding
#
# What it does:
#   1. Detects your OS/arch (Linux + macOS; Windows users are pointed at WSL2).
#   2. Ensures Node.js 22 (with its bundled npm) is available, installing a
#      user-local Node 22 into ~/.hybridclaw/node when no compatible one exists.
#      Downloaded Node tarballs are verified against nodejs.org's published
#      SHA-256 checksum. Alpine/musl needs a system Node 22 (apk add nodejs npm,
#      Alpine 3.21+) plus --skip-node, since nodejs.org ships glibc builds only.
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

# Everything below installs into $HOME-derived paths; fail with a clear
# message instead of an opaque `set -u` abort when HOME is missing.
if [ -z "${HOME:-}" ]; then
  printf 'error: HOME is not set; the installer needs a home directory to install into.\n' >&2
  exit 1
fi

# --- Configuration (override via environment) --------------------------------

HYBRIDCLAW_HOME="${HYBRIDCLAW_HOME:-$HOME/.hybridclaw}"
# User-writable npm prefix we fall back to when the global one needs root.
NPM_USER_PREFIX="$HYBRIDCLAW_HOME/npm-global"
PKG_NAME="@hybridaione/hybridclaw"
INSTALL_VERSION="${HYBRIDCLAW_INSTALL_VERSION:-latest}"
REQUIRED_NODE_MAJOR=22
# Used when nodejs.org is unreachable for latest-version discovery and no
# explicit HYBRIDCLAW_NODE_VERSION pin is set.
NODE_VERSION_FALLBACK="22.22.3"
# Set by ensure_writable_npm_prefix so later steps skip re-asking npm.
NPM_PREFIX=""

# --- Flags (env vars provide defaults; CLI flags override below) -------------

# Truthy for env-derived flags: 1/true/yes/on (any case). Avoids the arithmetic
# `-eq` test, which errors (and is then treated as false) on values like "true".
is_truthy() { case "${1:-}" in [Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]|1) return 0 ;; *) return 1 ;; esac; }

RUN_ONBOARDING=1
CHECK_DOCKER=1
MANAGE_NODE=1
DRY_RUN="${HYBRIDCLAW_DRY_RUN:-0}"
VERIFY="${HYBRIDCLAW_VERIFY_INSTALL:-0}"
# Headless when HYBRIDCLAW_NO_PROMPT, the conventional NO_PROMPT, or CI is
# truthy. Value-aware on purpose: CI=false or NO_PROMPT=0 must not go headless.
if is_truthy "${HYBRIDCLAW_NO_PROMPT:-}" || is_truthy "${NO_PROMPT:-}" || is_truthy "${CI:-}"; then
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

is_dry() { is_truthy "$DRY_RUN"; }
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
  HYBRIDCLAW_NODE_VERSION     Exact Node version to install when Node must be
                              downloaded (default: newest 22.x)
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
    armv7l)
      PLATFORM_ARCH="armv7l"
      warn "32-bit ARM has limited support: browser automation and local transformers embeddings are unavailable."
      ;;
    *) die "unsupported architecture: $arch" ;;
  esac

  # nodejs.org publishes glibc builds only; detect musl (e.g. Alpine) so the
  # managed-Node path can refuse to download an incompatible tarball. Probe the
  # musl loader directly first — `ldd --version` exits non-zero on musl, which
  # `set -o pipefail` would otherwise turn into a false negative.
  PLATFORM_LIBC="glibc"
  if [ "$PLATFORM_OS" = "linux" ]; then
    if ls /lib/ld-musl-* >/dev/null 2>&1 || { ldd --version 2>&1 || true; } | grep -qi musl; then
      PLATFORM_LIBC="musl"
    fi
  fi
}

# --- Node.js + npm -----------------------------------------------------------

# Hardened HTTPS fetch: the TLS/transfer flags every nodejs.org request shares,
# in one place. Callers append --max-time/--retry/-o and the URL.
fetch() { curl -fsSL --proto '=https' --tlsv1.2 "$@"; }

# Sets NODE_VERSION (and caches the release's SHASUMS256.txt body in
# NODE_SHASUMS when the latest-version lookup succeeded, so the checksum step
# needs no second fetch). An explicit HYBRIDCLAW_NODE_VERSION pin always wins.
resolve_node_version() {
  NODE_SHASUMS=""
  if [ -n "${HYBRIDCLAW_NODE_VERSION:-}" ]; then
    NODE_VERSION="$HYBRIDCLAW_NODE_VERSION"
    return 0
  fi
  # One small fetch yields both the newest 22.x version (from the filenames)
  # and its checksums; the full dist/index.json is ~85x larger.
  NODE_SHASUMS="$(fetch --max-time 15 \
      "https://nodejs.org/dist/latest-v${REQUIRED_NODE_MAJOR}.x/SHASUMS256.txt" 2>/dev/null)" \
    || NODE_SHASUMS=""
  NODE_VERSION="$(printf '%s\n' "$NODE_SHASUMS" \
    | sed -n "s/.*node-v\(${REQUIRED_NODE_MAJOR}[0-9.]*\)-linux-x64\.tar\.gz\$/\1/p" \
    | head -1)" || NODE_VERSION=""
  if [ -z "$NODE_VERSION" ]; then
    NODE_SHASUMS=""
    NODE_VERSION="$NODE_VERSION_FALLBACK"
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
  local file="$1" version="$2" filename="$3" expected="" actual
  # Reuse the SHASUMS body resolve_node_version already fetched when available.
  if [ -n "${NODE_SHASUMS:-}" ]; then
    expected="$(printf '%s\n' "$NODE_SHASUMS" | awk -v f="$filename" '$2 == f {print $1}')" || true
  fi
  # `|| true`: under `set -o pipefail` a failed fetch (offline/404/proxy) would
  # otherwise abort the whole installer here instead of the graceful skip below.
  [ -n "$expected" ] || expected="$(fetch --max-time 30 \
      "https://nodejs.org/dist/v${version}/SHASUMS256.txt" 2>/dev/null \
      | awk -v f="$filename" '$2 == f {print $1}')" || true
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
Refusing to install a corrupt or truncated Node.js download."
  fi
  ok "Verified Node.js download (sha256)"
}

install_managed_node() {
  local version dir filename url tarball
  if [ "${PLATFORM_LIBC:-glibc}" = "musl" ]; then
    die "Detected musl libc (e.g. Alpine). nodejs.org publishes glibc builds only.
Install Node ${REQUIRED_NODE_MAJOR} with your package manager and re-run with --skip-node:
    apk add --no-cache nodejs npm   # needs Alpine 3.21+ (older releases ship Node 20)
    curl -fsSL https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/scripts/install.sh | bash -s -- --skip-node"
  fi

  resolve_node_version
  version="$NODE_VERSION"
  dir="$HYBRIDCLAW_HOME/node"
  # Use the gzip tarball, not .tar.xz: `tar -xzf` only needs gzip (universally
  # present), whereas `tar -xJf` shells out to an `xz` binary that minimal
  # Debian/Ubuntu and many container/CI bases don't ship.
  filename="node-v${version}-${PLATFORM_OS}-${PLATFORM_ARCH}.tar.gz"
  url="https://nodejs.org/dist/v${version}/${filename}"

  if is_dry; then
    info "[dry-run] would download ${url}"
    info "[dry-run] would verify its sha256 against nodejs.org/dist/v${version}/SHASUMS256.txt"
    info "[dry-run] would extract Node.js v${version} into ${dir} and add ${dir}/bin to PATH"
    return 0
  fi

  info "Installing Node.js v${version} into ${dir} (no system changes)"
  mkdir -p "$dir"
  # No .tar.gz suffix: BusyBox mktemp requires the XXXXXX to be the final chars.
  tarball="$(mktemp "${TMPDIR:-/tmp}/hybridclaw-node.XXXXXX")"
  # `${tarball:-}`: this EXIT trap also fires when a later step fails and the
  # function unwinds, by which point the `local tarball` is out of scope; under
  # `set -u` a bare "$tarball" would abort with "unbound variable" and mask the
  # real error.
  trap 'rm -f "${tarball:-}"' EXIT
  fetch --retry 3 --retry-delay 2 -o "$tarball" "$url" \
    || die "failed to download Node.js from $url"
  verify_node_checksum "$tarball" "$version" "$filename"
  # --no-same-owner: when run as root, GNU tar would otherwise preserve the
  # tarball's build-user ownership (uid 1000), leaving the install tree
  # writable by an unrelated local user.
  tar -xzf "$tarball" -C "$dir" --strip-components=1 --no-same-owner
  rm -f "$tarball"
  trap - EXIT

  NODE_BIN_DIR="$dir/bin"
  # Smoke-test before declaring success: a command substitution that fails
  # inside an `ok` argument would not trip `set -e`, silently printing a green
  # checkmark for a binary that cannot run (e.g. glibc older than Node needs).
  local node_v
  node_v="$("$NODE_BIN_DIR/node" --version 2>/dev/null)" \
    || die "the downloaded Node.js binary does not run on this system (Node ${REQUIRED_NODE_MAJOR} needs glibc 2.28+; check 'ldd --version')."
  add_to_path "$NODE_BIN_DIR"
  ok "Node.js ${node_v} ready"
}

ensure_node() {
  local node_version major
  if have node; then
    # `|| node_version=""`: a broken node that fails `--version` must not abort
    # the installer under `set -e` — fall through to the managed-Node install.
    node_version="$(node --version 2>/dev/null)" || node_version=""
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

  # nvm is a shell function, never on PATH; probe its env/install dir instead.
  if have fnm || [ -n "${NVM_DIR:-}" ] || [ -s "$HOME/.nvm/nvm.sh" ]; then
    warn "A Node version manager (fnm/nvm) is installed. You may prefer:"
    warn "    fnm install 22 && fnm use 22    # or: nvm install 22 && nvm use 22"
    warn "Continuing with a HybridClaw-managed Node 22 in ${HYBRIDCLAW_HOME}/node."
  fi
  install_managed_node
}

# Writable if the directory exists and is writable, or its nearest existing
# ancestor is (so npm can create it). Used to decide whether a global install
# would hit EACCES before we attempt one.
dir_writable() {
  local d="$1"
  while [ -n "$d" ] && [ "$d" != "/" ] && [ ! -e "$d" ]; do d="$(dirname "$d")"; done
  [ -w "$d" ]
}

# A global `npm install -g` writes into <prefix>/lib/node_modules and
# <prefix>/bin. A system Node using a root-owned prefix (e.g. /usr/local) is not
# user-writable, so the advertised one-liner would fail with EACCES. Detect that
# up front and point npm at a user-local prefix — no sudo, no manual rerun.
ensure_writable_npm_prefix() {
  local prefix
  prefix="$(npm prefix -g 2>/dev/null)" || return 0
  if dir_writable "$prefix/lib/node_modules" && dir_writable "$prefix/bin"; then
    NPM_PREFIX="$prefix"
    return 0
  fi
  warn "npm global prefix ${prefix} is not writable; using ${NPM_USER_PREFIX} instead (no sudo)."
  warn "This persists 'prefix=${NPM_USER_PREFIX}' in ~/.npmrc so future global installs and 'hybridclaw update' keep working; undo with 'npm config delete prefix'."
  warn "Note: nvm refuses to run while a prefix is set in ~/.npmrc."
  mkdir -p "$NPM_USER_PREFIX/bin"
  npm config set prefix "$NPM_USER_PREFIX" >/dev/null 2>&1 \
    || die "could not point npm at a user-writable prefix (${NPM_USER_PREFIX})."
  NPM_PREFIX="$NPM_USER_PREFIX"
  add_to_path "$NPM_USER_PREFIX/bin"
}

# The npm version itself is deliberately not gated here: the published package
# ships a fully pinned npm-shrinkwrap.json, so any npm bundled with Node 22
# installs it correctly (the npm 11.10+ requirement is a dev/build concern;
# see SECURITY.md). Mutating the user's global npm would be all downside.
ensure_npm() {
  local npm_version
  if is_dry; then
    info "[dry-run] would check npm is available and the global prefix is user-writable"
    return 0
  fi
  have npm || die "npm not found alongside Node.js; reinstall Node 22."
  # Make the prefix writable before the global CLI install writes there.
  ensure_writable_npm_prefix
  npm_version="$(npm --version 2>/dev/null)" \
    || die "'npm --version' failed; your npm install looks broken — reinstall Node ${REQUIRED_NODE_MAJOR}."
  ok "npm ${npm_version} detected"
}

# --- PATH persistence --------------------------------------------------------

# Prepend a directory to this process's PATH and persist it in shell rc files.
add_to_path() {
  local dir="$1"
  if is_dry; then
    info "[dry-run] would add ${dir} to PATH in your shell rc files"
    return 0
  fi
  export PATH="$dir:$PATH"
  # Append an idempotent PATH export to the user's shell rc files.
  local marker="# added by HybridClaw installer"
  local line="export PATH=\"$dir:\$PATH\" $marker"

  # The rc file the login shell actually sources. We always (re)ensure this one,
  # creating it if absent — otherwise a zsh user whose only existing rc is
  # ~/.bashrc (which zsh never reads), or a fresh macOS box with no ~/.zshrc,
  # would get no usable PATH persistence.
  local login_rc fish_conf=""
  case "${SHELL:-}" in
    *zsh)  login_rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    *bash) login_rc="$HOME/.bashrc" ;;
    *fish)
      # fish reads none of the POSIX rc files and uses its own dialect.
      login_rc=""
      fish_conf="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
      ;;
    *)     login_rc="$HOME/.profile" ;;
  esac

  local rc
  # ~/.bash_profile is included because a bash login shell that has one never
  # reads ~/.profile (and usually not ~/.bashrc) — the macOS bash default.
  for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc" "$HOME/.profile" "$login_rc"; do
    [ -n "$rc" ] || continue
    # Touch existing rc files; the login shell's rc is created even if absent.
    [ -e "$rc" ] || [ "$rc" = "$login_rc" ] || continue
    # Match the exact line so re-runs (and revisiting login_rc) don't duplicate.
    grep -qsF "$line" "$rc" 2>/dev/null && continue
    # A read-only rc (or a missing $ZDOTDIR) must not abort the install under
    # `set -e`; PATH was already exported for this process, so warn and move on.
    printf '\n%s\n' "$line" >> "$rc" \
      || warn "could not update ${rc}; add '${dir}' to your PATH manually."
  done

  if [ -n "$fish_conf" ]; then
    local fish_line="fish_add_path --prepend \"$dir\" $marker"
    if ! grep -qsF "$fish_line" "$fish_conf" 2>/dev/null; then
      { mkdir -p "${fish_conf%/*}" && printf '\n%s\n' "$fish_line" >> "$fish_conf"; } 2>/dev/null \
        || warn "could not update ${fish_conf}; add '${dir}' to your PATH manually."
    fi
  fi
}

npm_global_bin() {
  local prefix
  prefix="${NPM_PREFIX:-}"
  [ -n "$prefix" ] || prefix="$(npm prefix -g 2>/dev/null)" || return 1
  printf '%s/bin' "$prefix"
}

# --- Docker ------------------------------------------------------------------

check_docker() {
  [ "$CHECK_DOCKER" -eq 1 ] || return 0
  if is_dry; then
    info "[dry-run] would check for Docker (recommended for the default sandbox)"
    return 0
  fi
  if ! have docker; then
    warn "Docker not found. The default container sandbox will be unavailable."
    warn "Install Docker (https://docs.docker.com/get-docker/) or run 'hybridclaw gateway start --sandbox=host'."
  elif docker info >/dev/null 2>&1; then
    ok "Docker is available (default container sandbox supported)"
  else
    warn "Docker is installed but its daemon is not reachable."
    warn "Start Docker, or run 'hybridclaw gateway start --sandbox=host'."
  fi
}

# --- Install -----------------------------------------------------------------

# Per-distro commands to install the native-module build toolchain, printed via
# the given printer ($1 = warn or err) so the pre-flight warning and the
# install-failure error stay in sync.
build_tool_hint() {
  "$1" "    Debian/Ubuntu: apt-get install -y python3 make g++"
  "$1" "    Fedora/RHEL:   dnf install -y python3 make gcc-c++"
  "$1" "    Alpine:        apk add python3 make g++"
  "$1" "    macOS:         xcode-select --install"
  "$1" "  (run the package-manager command as root, or via sudo, if needed)"
}

# The npm package builds native modules (better-sqlite3, node-pty) from source
# whenever no prebuilt binary matches the platform, and node-gyp then needs a
# toolchain. Warn early rather than failing deep inside an npm log.
check_build_prereqs() {
  if is_dry; then
    info "[dry-run] would check for native-module build tools (make, C/C++ compiler, python3)"
    return 0
  fi
  local missing=""
  have make || missing="make"
  if ! have g++ && ! have clang++ && ! have c++; then
    missing="${missing:+$missing, }a C/C++ compiler (g++)"
  fi
  if ! have python3 && ! have python; then
    missing="${missing:+$missing, }python3"
  fi
  [ -z "$missing" ] && return 0
  warn "Build tools may be missing: ${missing}."
  warn "npm needs them to compile native modules when no prebuilt binary exists:"
  build_tool_hint warn
}

install_cli() {
  local spec="$PKG_NAME"
  [ "$INSTALL_VERSION" != "latest" ] && spec="${PKG_NAME}@${INSTALL_VERSION}"
  info "Installing ${spec} globally via npm"
  if is_dry; then
    info "[dry-run] would run: npm install -g --no-audit --no-fund ${spec}"
    return 0
  fi
  if ! npm install -g --no-audit --no-fund "$spec"; then
    err "Global npm install failed. Common causes:"
    err "  1) Missing build tools for native modules (node-gyp needs python3,"
    err "     make, and a C/C++ compiler). Install them, e.g.:"
    build_tool_hint err
    err "  2) A non-writable npm global prefix that the automatic fallback to"
    err "     ${NPM_USER_PREFIX} did not catch. Check 'npm config get prefix'"
    err "     and ensure that directory is writable (no sudo needed)."
    err "  3) A transient network/registry failure (the package bootstraps its"
    err "     container dependencies during install); re-running often fixes it."
    err "Then re-run this installer. (HybridClaw never needs sudo.)"
    exit 1
  fi

  local bin_dir resolved
  bin_dir="$(npm_global_bin || true)"
  [ -n "$bin_dir" ] || return 0
  resolved="$(command -v hybridclaw 2>/dev/null || true)"
  case "$resolved" in
    "$bin_dir"/*) return 0 ;; # PATH already resolves to the fresh install
  esac
  add_to_path "$bin_dir"
  hash -r
  if [ -n "$resolved" ]; then
    # Without this, onboarding/--verify below would silently exercise the
    # stale binary and report its old version as the install result.
    warn "Another hybridclaw at ${resolved} was shadowing this install; ${bin_dir} now takes precedence on PATH."
  else
    warn "Added npm global bin (${bin_dir}) to your PATH. Open a new shell if needed."
  fi
}

# --- Onboarding + next steps -------------------------------------------------

# Last line of `hybridclaw --version` (the CLI may print a banner first).
hc_version() { hybridclaw --version 2>/dev/null | tail -1; }

maybe_onboard() {
  if is_dry; then
    info "[dry-run] would verify hybridclaw is on PATH and (unless --no-prompt) run onboarding"
    return 0
  fi

  have hybridclaw \
    || die "hybridclaw was installed but is not on PATH yet. Open a new shell and run: hybridclaw onboarding"

  ok "Installed $(hc_version || echo "$PKG_NAME")"

  if [ "$RUN_ONBOARDING" -ne 1 ] || [ "$NO_PROMPT" -eq 1 ]; then
    info "Skipping interactive onboarding: run 'hybridclaw onboarding' when ready."
    return
  fi

  # When piped through `curl | bash`, stdin is the script, so read the wizard
  # from the controlling terminal if one is available. Probe by actually
  # opening /dev/tty: `-r` only checks permission bits and passes even with no
  # controlling terminal, where the redirect below would fail with ENXIO.
  if [ ! -t 0 ] && ! { : </dev/tty; } 2>/dev/null; then
    info "Non-interactive shell: run 'hybridclaw onboarding' when ready."
    return
  fi

  info "Starting onboarding (Ctrl-C to skip and run it later)"
  local onboard_in=/dev/stdin
  [ -t 0 ] || onboard_in=/dev/tty
  # `trap : INT`: when the wizard dies of Ctrl-C, bash would otherwise kill the
  # whole installer, skipping the || fallback and every remaining step. The
  # no-op trap keeps this shell alive while the child still gets the SIGINT.
  trap : INT
  hybridclaw onboarding <"$onboard_in" \
    || warn "onboarding did not complete; run 'hybridclaw onboarding' later"
  trap - INT
}

run_verify() {
  is_truthy "$VERIFY" || return 0
  if is_dry; then
    info "[dry-run] would run: hybridclaw --version && hybridclaw doctor --json"
    return 0
  fi

  info "Verifying installation"
  have hybridclaw || die "verification failed: 'hybridclaw' is not on PATH."
  local version_output
  version_output="$(hc_version)" \
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
  check_build_prereqs
  install_cli
  maybe_onboard
  run_verify
  is_dry && { info "Dry run complete; no changes were made."; return 0; }
  print_next_steps
}

# Run the installer — unless sourced with HYBRIDCLAW_INSTALL_LIB=1, which the
# test suite (scripts/install.test.sh) uses to load these functions without
# executing. Real invocations (executed or piped) never set it, so they run.
if [ -z "${HYBRIDCLAW_INSTALL_LIB:-}" ]; then
  main "$@"
fi

} # end download guard — keep this brace as the final line of the file
