FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ripgrep git curl python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir --break-system-packages uv

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium
RUN npx playwright install --with-deps --only-shell chromium

COPY src/ src/
RUN npx tsc

RUN chown -R node:node /app /ms-playwright

USER node

WORKDIR /workspace

ENTRYPOINT ["node", "/app/dist/index.js"]
