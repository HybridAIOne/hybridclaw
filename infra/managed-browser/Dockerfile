FROM --platform=$BUILDPLATFORM node:22-slim@sha256:80fdb3f57c815e1b638d221f30a826823467c4a56c8f6a8d7aa091cd9b1675ea AS shared

WORKDIR /app
RUN npm install --no-save --ignore-scripts --no-audit --fund=false \
    typescript@5.9.3 @types/node@22.20.4
COPY container/shared ./container/shared
RUN npx tsc -b container/shared

FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

COPY infra/managed-browser/package.json ./infra/managed-browser/package.json
RUN cd infra/managed-browser && npm install --omit=dev --no-audit --fund=false

COPY --from=shared /app/container/shared ./container/shared
COPY infra/managed-browser ./infra/managed-browser

WORKDIR /app/infra/managed-browser
EXPOSE 8787
CMD ["npm", "start"]
