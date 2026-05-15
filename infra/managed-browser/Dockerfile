FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

COPY infra/managed-browser/package.json ./infra/managed-browser/package.json
RUN cd infra/managed-browser && npm install --omit=dev --no-audit --fund=false

COPY container/shared ./container/shared
COPY infra/managed-browser ./infra/managed-browser

WORKDIR /app/infra/managed-browser
EXPOSE 8787
CMD ["npm", "start"]
