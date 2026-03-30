# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-slim@sha256:80fdb3f57c815e1b638d221f30a826823467c4a56c8f6a8d7aa091cd9b1675ea AS builder

# better-sqlite3 requires native compilation; node-pty may fall back to it
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY console/package*.json console/
COPY scripts/postinstall-container.mjs scripts/
RUN npm ci
RUN find node_modules/node-pty/prebuilds -name spawn-helper -exec chmod 755 {} \; 2>/dev/null || true

# Install container agent deps (cached separately from source)
COPY container/package*.json container/
RUN npm --prefix container ci

# Copy source and build everything
COPY . .
RUN npm run build:console
RUN npx tsc && node -e "require('node:fs').chmodSync('dist/cli.js', 0o755)"
RUN npm --prefix container run build

# Prune devDeps in place so the runtime stage copies only production deps
RUN npm prune --omit=dev \
    && npm --prefix container prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-slim@sha256:80fdb3f57c815e1b638d221f30a826823467c4a56c8f6a8d7aa091cd9b1675ea AS runtime

# The agent runtime needs root to install packages, manage files, etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production deps — copy pre-built and pre-pruned from builder
# (better-sqlite3 and node-pty may require native compilation;
# copying from the builder avoids needing build tools at runtime)
COPY --link --from=builder /app/package*.json ./
COPY --link --from=builder /app/console/package*.json console/
COPY --link --from=builder /app/node_modules/ node_modules/

# Production deps — container agent
COPY --link --from=builder /app/container/package*.json container/
COPY --link --from=builder /app/container/node_modules/ container/node_modules/

# Gateway compiled output + console SPA
COPY --link --from=builder /app/dist ./dist
COPY --link --from=builder /app/console/dist ./console/dist

# Container agent runtime (host sandbox mode) + shared modules
COPY --link --from=builder /app/container/dist ./container/dist
COPY --link --from=builder /app/container/shared ./container/shared

# SPA pages served by the gateway (/chat, /agents, /)
COPY --link docs/ ./docs/

# Runtime templates and skills
COPY --link templates/ ./templates/
COPY --link skills/ ./skills/
COPY --link SECURITY.md TRUST_MODEL.md ./

EXPOSE 9090

ENV HYBRIDCLAW_DATA_DIR=/workspace/.data
# Operators must set HYBRIDCLAW_ACCEPT_TRUST=true at runtime to accept the
# security trust model in headless mode (e.g. docker run -e HYBRIDCLAW_ACCEPT_TRUST=true).
RUN mkdir -p /workspace/.data

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9090/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/cli.js", "gateway", "start", "--foreground"]
