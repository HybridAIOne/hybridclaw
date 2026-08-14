# --- Build stage ---
FROM node:22-slim@sha256:80fdb3f57c815e1b638d221f30a826823467c4a56c8f6a8d7aa091cd9b1675ea AS builder
WORKDIR /app

RUN --mount=type=cache,target=/root/.npm \
    npm install --global npm@11.10.0 --ignore-scripts --no-audit --fund=false
RUN printf '%s\n' \
    'engine-strict=true' \
    'save-exact=true' \
    'min-release-age=7' \
    > .npmrc
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts
COPY tsconfig.json ./
COPY shared/ shared/
COPY src/ src/
RUN npx tsc

# --- Runtime base (no LibreOffice) ---
FROM node:22-slim@sha256:80fdb3f57c815e1b638d221f30a826823467c4a56c8f6a8d7aa091cd9b1675ea AS runtime-lite

LABEL org.opencontainers.image.source="https://github.com/HybridAIOne/hybridclaw"
LABEL org.opencontainers.image.description="HybridClaw sandboxed agent runtime"

# npm names its debug logs after the wall clock and leaves a V8 compile cache in
# /tmp whose contents vary per run; shipping either hands every layer that runs
# npm a fresh digest on each rebuild.
ENV NPM_CONFIG_LOGS_MAX=0
ENV NODE_DISABLE_COMPILE_CACHE=1

RUN --mount=type=cache,target=/root/.npm \
    npm install --global npm@11.10.0 --ignore-scripts --no-audit --fund=false

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ripgrep git curl python3 python3-pip python3-venv python-is-python3 unzip file poppler-utils qpdf pandoc

# Debian's PEP 668 marker makes bare `pip install` fail with
# externally-managed-environment. This image is a disposable sandbox, so the
# marker only blocks agents from installing the Python packages they need at
# runtime; python3-venv above keeps the venv route working too.
ENV PIP_BREAK_SYSTEM_PACKAGES=1

RUN --mount=type=cache,target=/root/.cache/pip \
    python3 -m pip install --break-system-packages \
    pypdf==5.4.0 \
    pdfplumber==0.11.6 \
    pdf2image==1.17.0 \
    reportlab==4.4.4 \
    pillow==11.3.0 \
    openpyxl==3.1.5

# Security owner call, 2026-08-13: PptxGenJS does not import image-size;
# remove the unpatched parser until upstream drops the unused dependency.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g --ignore-scripts \
    docx@9.5.1 \
    pptxgenjs@4.0.1 \
    csv-parse@6.1.0 \
    iconv-lite@0.7.0 \
    @e965/xlsx@0.20.3 \
    xlsx-populate@1.21.0 \
    && npm pkg delete dependencies.image-size --prefix /usr/local/lib/node_modules/pptxgenjs \
    && rm -rf /usr/local/lib/node_modules/pptxgenjs/node_modules/image-size

RUN ln -s /usr/local/lib/node_modules/@e965/xlsx /usr/local/lib/node_modules/xlsx

ENV NODE_PATH=/usr/local/lib/node_modules:/app/node_modules
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Hand /app to node before anything is written into it; a trailing `chown -R`
# would copy every installed file into a second layer instead. `--link` copies
# below resolve ownership without passwd, so they name node numerically.
RUN mkdir -p /ms-playwright && chown node:node /app /ms-playwright

COPY --link --chown=1000:1000 --from=builder /app/.npmrc /app/package.json /app/package-lock.json ./
USER node
# npm stamps the project version into the hidden lockfile, which would give this
# ~400 MB layer a new digest on every release even when no dependency changed.
# Nothing reads it at runtime.
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 \
    npm ci --ignore-scripts --omit=dev \
    && rm -f node_modules/.package-lock.json

# Playwright's system deps need root; the browser itself is installed as node
# so /ms-playwright stays owned by node:node.
#
# apt/dpkg logs and the font and linker caches record the wall clock in their
# contents, which the exporter's timestamp rewrite cannot normalise, so leaving
# them would hand this ~300 MB layer a new digest on every rebuild. Fonts are
# recached against SOURCE_DATE_EPOCH, the mtime the layer is exported with, so
# the cache still validates at runtime.
USER root
RUN DEBIAN_FRONTEND=noninteractive npx playwright install-deps chromium \
    && rm -rf /var/cache/ldconfig/aux-cache \
    && find /var/log -type f -delete \
    && find /usr/share/fonts -exec touch -hd @1704067200 {} + \
    && fc-cache -f -s
USER node
RUN npx playwright install --only-shell chromium

COPY --link --chown=1000:1000 --from=builder /app/dist/ dist/
COPY --link --chown=1000:1000 --from=builder /app/shared/ shared/

# Declared last: an ARG invalidates every instruction after it, so a version
# bump here would otherwise rebuild the whole runtime stage.
ARG HYBRIDCLAW_VERSION=0.0.0
LABEL org.opencontainers.image.version="${HYBRIDCLAW_VERSION}"

STOPSIGNAL SIGTERM
WORKDIR /workspace
ENTRYPOINT ["node", "/app/dist/index.js"]

# --- Full runtime (with LibreOffice) ---
FROM runtime-lite AS runtime

USER root
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libreoffice-calc libreoffice-impress libreoffice-writer \
    && rm -rf /var/cache/ldconfig/aux-cache \
    && find /var/log -type f -delete \
    && find /usr/share/fonts -exec touch -hd @1704067200 {} + \
    && fc-cache -f -s
USER node
