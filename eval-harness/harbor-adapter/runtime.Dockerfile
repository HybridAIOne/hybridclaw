# Installs the packed HybridClaw tarball beside its own Node under /opt.
# build-runtime.sh archives /opt/hybridclaw-node and /opt/hybridclaw-install
# from this image; the task sandbox needs nothing else preinstalled.
ARG NODE_VERSION
FROM --platform=linux/amd64 node:${NODE_VERSION}-slim AS node

FROM --platform=linux/amd64 python:3.13-slim-bookworm
RUN apt-get update -qq && apt-get install -y --no-install-recommends build-essential ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local /opt/hybridclaw-node
COPY package.tgz /tmp/
ENV PATH=/opt/hybridclaw-node/bin:$PATH
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --prefix /opt/hybridclaw-install --omit=dev --no-audit --no-fund /tmp/package.tgz && rm /tmp/package.tgz && npm cache clean --force
