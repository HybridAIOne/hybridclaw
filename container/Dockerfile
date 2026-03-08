FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ripgrep git curl python3 python3-pip poppler-utils qpdf \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir --break-system-packages \
    uv \
    pypdf==5.4.0 \
    pdfplumber==0.11.6 \
    pdf2image==1.17.0 \
    reportlab==4.4.4 \
    pillow==11.3.0

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
