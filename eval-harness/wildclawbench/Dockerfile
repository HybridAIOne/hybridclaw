# Build context: HybridClaw checkout. The benchmark's published Ubuntu image
# supplies task dependencies; no task data or graders enter this image.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
# Published image inherits its builder's unreachable local proxy.
ENV http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= all_proxy=
ARG NODE_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) arch=x64 ;; arm64) ;; *) exit 1 ;; esac; \
    name="node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${name}"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep "  ${name}$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "$name" -C /usr/local --strip-components=1; \
    rm "$name" SHASUMS256.txt; \
    npm install --global npm@11.10.0 --no-audit --fund=false
WORKDIR /opt/hybridclaw
COPY .npmrc package.json package-lock.json npm-shrinkwrap.json ./
COPY console/package.json console/package.json
COPY desktop/package.json desktop/package.json
COPY desktop/support/packaging-anchor/ desktop/support/packaging-anchor/
COPY container/ container/
COPY scripts/ scripts/
COPY src/ src/
COPY tsconfig.json ./
COPY templates/ templates/
COPY skills/ skills/
COPY community-skills/ community-skills/
COPY plugins/ plugins/
COPY docs/content/ docs/content/
COPY SECURITY.md TRUST_MODEL.md LICENSE ./
RUN npm ci --no-audit --fund=false \
    && node scripts/bundle-gateway.mjs \
    && npm --prefix container run build \
    && npm prune --omit=dev --no-audit --fund=false
ARG SOURCE_COMMIT
ARG SOURCE_VERSION
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
LABEL org.opencontainers.image.version=$SOURCE_VERSION
COPY eval-harness/wildclawbench/launch.py /opt/wildclawbench/launch.py
COPY eval-harness/wildclawbench/evidence.py /opt/wildclawbench/evidence.py
COPY eval-harness/wildclawbench/workspace-display.mjs /opt/wildclawbench/workspace-display.mjs
COPY eval-harness/wildclawbench/record-generations.mjs /opt/wildclawbench/record-generations.mjs
# The base image's OpenClaw state must not seed this harness.
ENV HYBRIDCLAW_DATA_DIR=/tmp/hybridclaw-runtime
RUN rm -rf /tmp_workspace && mkdir /tmp_workspace
WORKDIR /tmp_workspace
ENTRYPOINT []
CMD ["/bin/bash"]
