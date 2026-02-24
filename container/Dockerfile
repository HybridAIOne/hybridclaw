FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ripgrep git curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ src/
RUN npx tsc

RUN chown -R node:node /app

USER node

WORKDIR /workspace

ENTRYPOINT ["node", "/app/dist/index.js"]
