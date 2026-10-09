# ── Build stage ───────────────────────────────────────────────────────────────
# Runs on the build host's own architecture: tsc and vite emit
# platform-independent JS, and compiling it under QEMU for arm64 took ~13 of
# the ~17 minutes of a main build (2026-10-01). Install scripts are skipped
# because nothing here loads a native addon; those come from `deps` below.
FROM --platform=$BUILDPLATFORM node:22-slim@sha256:80fdb3f57c815e1b638d221f30a826823467c4a56c8f6a8d7aa091cd9b1675ea AS builder

WORKDIR /app

RUN npm install --global npm@11.10.0 --no-audit --fund=false

COPY .npmrc package*.json ./
COPY console/package*.json console/
RUN npm ci --ignore-scripts
COPY container/package*.json container/
RUN npm --prefix container ci --ignore-scripts

COPY . .
RUN npm run build:console
RUN npx tsc && node -e "require('node:fs').chmodSync('dist/cli.js', 0o755)"
RUN node scripts/bundle-gateway.mjs
RUN npm --prefix container run build

# ── Production deps ───────────────────────────────────────────────────────────
# Runs per target platform, so better-sqlite3 and node-pty get native addons
# for the image's architecture. Depends only on the lockfiles, so a source
# change reuses it from cache.
FROM node:22-slim@sha256:80fdb3f57c815e1b638d221f30a826823467c4a56c8f6a8d7aa091cd9b1675ea AS deps

# better-sqlite3 requires native compilation; node-pty may fall back to it
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN npm install --global npm@11.10.0 --no-audit --fund=false

COPY .npmrc package*.json ./
COPY console/package*.json console/
COPY scripts/postinstall-container.mjs scripts/
RUN npm ci
RUN find node_modules/node-pty/prebuilds -name spawn-helper -exec chmod 755 {} \; 2>/dev/null || true

COPY container/package*.json container/
RUN npm --prefix container ci

# Prune devDeps in place so the runtime stage copies only production deps.
# Prune must see every workspace manifest: the container workspace's deps stay
# hoisted in the root tree only then, and the host-sandbox browser tools run
# /app/node_modules/.bin/agent-browser. (`npm ci --omit=dev` cannot replace
# this: with container/package.json present, the root postinstall would
# install the container deps a second time.)
# The hidden lockfiles carry the project version, which would give the copied
# node_modules layers a new digest on every release; nothing reads them here.
COPY desktop/package.json desktop/
COPY desktop/support/packaging-anchor/ desktop/support/packaging-anchor/
RUN npm prune --omit=dev \
    && npm --prefix container prune --omit=dev \
    && rm -f node_modules/.package-lock.json \
       container/node_modules/.package-lock.json

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-slim@sha256:80fdb3f57c815e1b638d221f30a826823467c4a56c8f6a8d7aa091cd9b1675ea AS runtime

ARG TARGETARCH
# 0.14.7 (maintainer diagnosis, 2026-08-23): Signal rejects 0.14.2's final
# linked-device provisioning request with HTTP 409 after accepting the QR.
ARG SIGNAL_CLI_VERSION=0.14.7

# The agent runtime needs root to install packages, manage files, etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      python3 \
      python3-pip \
      python3-venv \
      python-is-python3 \
      unzip \
      file \
    && rm -rf /var/lib/apt/lists/*

# Debian's PEP 668 marker makes bare `pip install` fail with
# externally-managed-environment. This image is a disposable sandbox whose
# agent runs as root, so the marker only blocks agents from installing the
# Python packages they need at runtime; python3-venv above keeps the venv
# route working too.
ENV PIP_BREAK_SYSTEM_PACKAGES=1

# Agent tool libraries: one lockfile-backed manifest shared with the standalone
# agent image (container/tools). Cloud host-sandbox deployments execute skills
# in this image, so it carries the same set. Agent-written scripts resolve them
# via NODE_PATH.
ENV NPM_CONFIG_LOGS_MAX=0
COPY container/tools/ /opt/hybridclaw-tools/
RUN --mount=type=cache,target=/root/.cache/pip \
    python3 -m pip install --break-system-packages --require-hashes \
      -r /opt/hybridclaw-tools/requirements.txt
RUN --mount=type=cache,target=/root/.npm \
    cd /opt/hybridclaw-tools \
    && npm ci --ignore-scripts --omit=dev --no-audit --fund=false \
    && rm -f node_modules/.package-lock.json

# Chromium for the browser tools. This image runs the agent in host sandbox
# mode, and without a browser every browser_* call fails with "Chrome not
# found". agent-browser 0.27 does not look inside
# PLAYWRIGHT_BROWSERS_PATH for the headless shell, so it is named explicitly
# through a version-free symlink. Installed before the app layers so a release
# does not rebuild these ~400 MB; the CLI version follows the root package.json.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chrome-headless-shell
RUN --mount=type=cache,target=/root/.npm \
    DEBIAN_FRONTEND=noninteractive npx --yes playwright@1.63.0 install-deps chromium \
    && npx --yes playwright@1.63.0 install --only-shell chromium \
    && ln -s "$(find /ms-playwright -type f -name chrome-headless-shell | head -n 1)" \
      /usr/local/bin/chrome-headless-shell \
    && /usr/local/bin/chrome-headless-shell --version \
    && rm -rf /var/lib/apt/lists/* /var/cache/ldconfig/aux-cache \
    && find /var/log -type f -delete

RUN if [ "${TARGETARCH}" = "amd64" ]; then \
      curl -fsSL \
        "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux-native.tar.gz" \
        -o /tmp/signal-cli.tar.gz \
      && tar -xzf /tmp/signal-cli.tar.gz -C /opt \
      && ln -sf /opt/signal-cli /usr/local/bin/signal-cli \
      && rm -f /tmp/signal-cli.tar.gz \
      && signal-cli --version; \
    else \
      echo "signal-cli native release is not available for TARGETARCH=${TARGETARCH}; use an external signal-cli daemon or sidecar."; \
    fi

# Keep the bundled signal-cli linked identity in the gateway's persistent data
# mount. The system config also makes later bare daemon commands use the same
# account store as the admin QR-link flow.
RUN mkdir -p /etc/signal-cli \
    && printf '%s\n' '{"dataDir":"/workspace/.data/signal-cli"}' \
      > /etc/signal-cli/config.json

WORKDIR /app

# Production deps — copy pre-built from deps
# (better-sqlite3 and node-pty may require native compilation;
# copying from deps avoids needing build tools at runtime)
COPY --link --from=deps /app/package*.json ./
COPY --link --from=deps /app/console/package*.json console/
COPY --link --from=deps /app/node_modules/ node_modules/

# Production deps — container agent
COPY --link --from=deps /app/container/package*.json container/
COPY --link container/tools/package.json container/tools/package.json
COPY --link --from=deps /app/container/node_modules/ container/node_modules/

# Gateway compiled output + console SPA
COPY --link --from=builder /app/dist ./dist
COPY --link --from=builder /app/bundle ./bundle
COPY --link --from=builder /app/console/dist ./console/dist

# Container agent runtime (host sandbox mode) + shared modules
COPY --link --from=builder /app/container/dist ./container/dist
COPY --link --from=builder /app/container/shared ./container/shared

# Gateway-served static content from docs/: /about (index.html), /agents
# (agents.html), the /docs markdown site, and shared favicons/images.
# (The /chat and /admin SPA is the console/dist/ bundle copied separately.)
COPY --link docs/ ./docs/

# Runtime templates and skills
COPY --link templates/ ./templates/
COPY --link skills/ ./skills/
COPY --link --from=builder /app/plugins/tier-router ./plugins/tier-router
# Install-on-demand plugin sources, so `hybridclaw plugin install <id>` works
# in the image; their dependencies are fetched only when installed.
COPY --link --from=builder /app/plugins/distill ./plugins/distill
COPY --link --from=builder /app/plugins/media-tools ./plugins/media-tools
COPY --link --from=builder /app/plugins/transformers-embeddings ./plugins/transformers-embeddings
COPY --link --from=builder /app/plugins/twilio-voice ./plugins/twilio-voice
COPY --link SECURITY.md TRUST_MODEL.md ./

EXPOSE 9090

ENV HYBRIDCLAW_DATA_DIR=/workspace/.data
ENV NODE_PATH=/opt/hybridclaw-tools/node_modules:/usr/local/lib/node_modules:/app/node_modules:/app/container/node_modules
# Operators must set HYBRIDCLAW_ACCEPT_TRUST=true at runtime to accept the
# security trust model in headless mode (e.g. docker run -e HYBRIDCLAW_ACCEPT_TRUST=true).
RUN mkdir -p /workspace/.data
# Agents and bundled skills call `hybridclaw ...` from the shell.
RUN printf '#!/bin/sh\nexec node /app/bundle/cli.js "$@"\n' > /usr/local/bin/hybridclaw \
  && chmod 755 /usr/local/bin/hybridclaw

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9090/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bundle/cli.js", "gateway", "start", "--foreground"]
