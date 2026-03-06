FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies (including devDeps for tsc)
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- runtime image ----
FROM node:22-alpine

WORKDIR /app

# Production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled JS
COPY --from=builder /app/dist ./dist

# Agent workspace templates (workspace-manager bootstraps these into sandbox volumes)
COPY templates/ ./templates/

# Default data directory (overridable via HYBRIDCLAW_DATA_DIR or volume mount)
RUN mkdir -p /app/data

EXPOSE 9090

CMD ["node", "dist/gateway.js", "gateway"]
