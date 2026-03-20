# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Install all deps (dev included — needed for tsc, vite)
COPY package*.json ./
COPY console/package*.json console/
RUN npm ci

# Build console SPA then compile gateway TypeScript
COPY . .
RUN npm run build:console
RUN npx tsc && node -e "require('node:fs').chmodSync('dist/cli.js', 0o755)"

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Production deps only (includes better-sqlite3 native binary)
COPY package*.json ./
COPY console/package*.json console/
RUN npm ci --omit=dev

# Gateway compiled output + bundled console SPA
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/console/dist ./console/dist

# Shared JS modules required at runtime by gateway imports
COPY --from=builder /app/container/shared ./container/shared

EXPOSE 9090

ENV HYBRIDCLAW_DATA_DIR=/workspace/.data

CMD ["node", "dist/cli.js", "gateway"]
