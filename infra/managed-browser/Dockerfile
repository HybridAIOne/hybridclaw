FROM node:22.23.4-slim@sha256:5991875dfb80938dd8a6ba3fe3e96fd04929e70792762b3319d8caadbbe229bc AS node-runtime

FROM mcr.microsoft.com/playwright:v1.58.2-noble

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

COPY infra/managed-browser/package.json ./infra/managed-browser/package.json
RUN cd infra/managed-browser && npm install --engine-strict --omit=dev --no-audit --fund=false

COPY container/shared ./container/shared
COPY infra/managed-browser ./infra/managed-browser

WORKDIR /app/infra/managed-browser
EXPOSE 8787
CMD ["npm", "start"]
