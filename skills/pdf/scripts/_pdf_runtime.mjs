import fs from 'node:fs/promises';
import path from 'node:path';

let pdfJsPromise = null;
let canvasPromise = null;

export async function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfJsPromise;
}

export async function loadCanvas() {
  if (!canvasPromise) {
    canvasPromise = import('@napi-rs/canvas').catch((err) => {
      canvasPromise = null;
      throw new Error(
        `@napi-rs/canvas is required for PDF rendering: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
  return canvasPromise;
}

export function parsePageSelection(rawValue, totalPages) {
  const raw = String(rawValue || '').trim();
  if (!raw) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const pages = new Set();
  for (const token of raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      const low = Math.max(1, Math.min(start, end));
      const high = Math.min(totalPages, Math.max(start, end));
      for (let page = low; page <= high; page += 1) {
        pages.add(page);
      }
      continue;
    }

    const page = Number.parseInt(token, 10);
    if (Number.isFinite(page) && page >= 1 && page <= totalPages) {
      pages.add(page);
    }
  }

  return Array.from(pages).sort((left, right) => left - right);
}

export async function openPdfDocument(inputPath) {
  const { getDocument } = await loadPdfJs();
  const buffer = await fs.readFile(inputPath);
  return getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    useSystemFonts: true,
  }).promise;
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function groupPageTextItems(items) {
  const positioned = items
    .map((item) => {
      if (!('str' in item)) return null;
      const text = normalizeText(item.str);
      if (!text) return null;
      const transform = Array.isArray(item.transform) ? item.transform : [];
      const x = Number(transform[4] || 0);
      const y = Number(transform[5] || 0);
      const width = Number(item.width || 0);
      const height = Math.abs(Number(item.height || 0));
      return {
        text,
        x,
        y,
        width,
        height,
      };
    })
    .filter(Boolean);

  positioned.sort((left, right) => {
    const yDiff = right.y - left.y;
    if (Math.abs(yDiff) > 2) return yDiff;
    return left.x - right.x;
  });

  const lines = [];
  for (const item of positioned) {
    const previous = lines.at(-1);
    const tolerance = Math.max(2, item.height * 0.6);
    if (!previous || Math.abs(previous.y - item.y) > tolerance) {
      lines.push({ y: item.y, items: [item] });
      continue;
    }
    previous.items.push(item);
  }

  return lines
    .map((line) => {
      const ordered = line.items.sort((left, right) => left.x - right.x);
      let output = '';
      let previousEnd = null;
      for (const item of ordered) {
        const start = item.x;
        if (previousEnd != null && start - previousEnd > 6) {
          output += ' ';
        } else if (output && !output.endsWith(' ')) {
          output += ' ';
        }
        output += item.text;
        previousEnd = item.x + Math.max(item.width, item.text.length * 4);
      }
      return output.replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean)
    .join('\n');
}

export async function extractPdfText(inputPath, pageNumbers) {
  const pdf = await openPdfDocument(inputPath);
  const selectedPages = parsePageSelection(pageNumbers, pdf.numPages);
  const pages = [];

  for (const pageNumber of selectedPages) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    pages.push({
      pageNumber,
      text: groupPageTextItems(textContent.items),
    });
  }

  return {
    pageCount: pdf.numPages,
    selectedPages,
    pages,
  };
}

export async function renderPdfPages(params) {
  const { inputPath, outputDir, pageNumbers, maxDimension } = params;
  const { createCanvas } = await loadCanvas();
  const pdf = await openPdfDocument(inputPath);
  const selectedPages = parsePageSelection(pageNumbers, pdf.numPages);
  const written = [];

  await fs.mkdir(outputDir, { recursive: true });

  const canvasFactory = {
    create(width, height) {
      const canvas = createCanvas(width, height);
      return {
        canvas,
        context: canvas.getContext('2d'),
      };
    },
    reset(target, width, height) {
      target.canvas.width = width;
      target.canvas.height = height;
    },
    destroy(target) {
      target.canvas.width = 0;
      target.canvas.height = 0;
    },
  };

  for (const pageNumber of selectedPages) {
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(
      1,
      maxDimension / Math.max(baseViewport.width, baseViewport.height),
    );
    const viewport = page.getViewport({
      scale: Math.max(0.1, scale),
    });
    const canvas = createCanvas(
      Math.max(1, Math.ceil(viewport.width)),
      Math.max(1, Math.ceil(viewport.height)),
    );
    const context = canvas.getContext('2d');
    await page.render({
      canvasContext: context,
      viewport,
      canvasFactory,
    }).promise;

    const outputPath = path.join(outputDir, `page_${pageNumber}.png`);
    await fs.writeFile(outputPath, canvas.toBuffer('image/png'));
    written.push(outputPath);
  }

  return {
    pageCount: pdf.numPages,
    selectedPages,
    written,
  };
}
