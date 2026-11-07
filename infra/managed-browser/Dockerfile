FROM --platform=$BUILDPLATFORM node:22.23.4-slim@sha256:5991875dfb80938dd8a6ba3fe3e96fd04929e70792762b3319d8caadbbe229bc AS shared

WORKDIR /app/container
RUN --mount=type=cache,target=/root/.npm \
    npm install --global npm@11.10.0 --ignore-scripts --no-audit --fund=false
COPY .npmrc container/package.json container/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --fund=false
COPY container/shared ./shared
RUN npx tsc -b shared

FROM node:22.23.4-slim@sha256:5991875dfb80938dd8a6ba3fe3e96fd04929e70792762b3319d8caadbbe229bc AS node-runtime

FROM mcr.microsoft.com/playwright:v1.58.2-noble

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

COPY infra/managed-browser/package.json ./infra/managed-browser/package.json
RUN cd infra/managed-browser && npm install --engine-strict --omit=dev --no-audit --fund=false

COPY --from=shared /app/container/shared/dist ./container/shared/dist
COPY infra/managed-browser ./infra/managed-browser

WORKDIR /app/infra/managed-browser
EXPOSE 8787
CMD ["npm", "start"]
