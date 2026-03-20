# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Install root deps first (cached unless package.json changes)
COPY package*.json ./
COPY console/package*.json console/
RUN npm ci

# Install container agent deps (cached separately from source)
COPY container/package*.json container/
RUN npm --prefix container ci

# Copy source and build everything
COPY . .
RUN npm run build:console
RUN npx tsc && node -e "require('node:fs').chmodSync('dist/cli.js', 0o755)"
RUN npm --prefix container run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production deps — root
COPY package*.json ./
COPY console/package*.json console/
RUN npm ci --omit=dev

# Production deps — container agent
COPY container/package*.json container/
RUN npm --prefix container ci --omit=dev

# Gateway compiled output + console SPA
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/console/dist ./console/dist

# Container agent runtime (host sandbox mode) + shared modules
COPY --from=builder --chown=node:node /app/container/dist ./container/dist
COPY --from=builder --chown=node:node /app/container/shared ./container/shared

# Runtime templates and skills
COPY --chown=node:node templates/ ./templates/
COPY --chown=node:node skills/ ./skills/
COPY --chown=node:node SECURITY.md TRUST_MODEL.md ./

EXPOSE 9090

ENV HYBRIDCLAW_DATA_DIR=/workspace/.data

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9090/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

CMD ["node", "dist/cli.js", "gateway"]
