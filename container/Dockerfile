# --- Build stage ---
FROM node:22-slim@sha256:80fdb3f57c815e1b638d221f30a826823467c4a56c8f6a8d7aa091cd9b1675ea AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci
COPY tsconfig.json ./
COPY shared/ shared/
COPY src/ src/
RUN npx tsc

# --- Runtime base (no LibreOffice) ---
FROM node:22-slim@sha256:80fdb3f57c815e1b638d221f30a826823467c4a56c8f6a8d7aa091cd9b1675ea AS runtime-lite

LABEL org.opencontainers.image.source="https://github.com/HybridAIOne/hybridclaw"
LABEL org.opencontainers.image.description="HybridClaw sandboxed agent runtime"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    ripgrep git curl python3 python3-pip poppler-utils qpdf pandoc \
    && rm -rf /var/lib/apt/lists/*

RUN --mount=type=cache,target=/root/.cache/pip \
    python3 -m pip install --break-system-packages \
    pypdf==5.4.0 \
    pdfplumber==0.11.6 \
    pdf2image==1.17.0 \
    reportlab==4.4.4 \
    pillow==11.3.0

RUN --mount=type=cache,target=/root/.npm \
    npm install -g \
    docx@9.5.1 \
    pptxgenjs@4.0.1 \
    csv-parse@6.1.0 \
    iconv-lite@0.7.0 \
    xlsx-populate@1.21.0

ENV NODE_PATH=/usr/local/lib/node_modules:/app/node_modules
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY --link --from=builder /app/package.json /app/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# System deps need root; browser installed as node user so /ms-playwright stays owned by node:node
RUN npx playwright install-deps chromium \
    && mkdir -p /ms-playwright \
    && chown -R node:node /app /ms-playwright
USER node
RUN npx playwright install --only-shell chromium

COPY --link --from=builder /app/dist/ dist/
COPY --link --from=builder /app/shared/ shared/

STOPSIGNAL SIGTERM
WORKDIR /workspace
ENTRYPOINT ["node", "/app/dist/index.js"]

# --- Full runtime (with LibreOffice) ---
FROM runtime-lite AS runtime

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    libreoffice-calc libreoffice-impress libreoffice-writer \
    && rm -rf /var/lib/apt/lists/*
USER node
