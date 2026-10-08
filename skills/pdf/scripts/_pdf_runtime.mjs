import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let pdfJsPromise = null;
let canvasPromise = null;

// pdfjs-dist and @napi-rs/canvas ship with the agent runtime (container/),
// not the gateway package. import() ignores NODE_PATH and cannot see
// container/node_modules from skills/, so resolve through require: this
// script's node_modules chain, the packaged runtime beside skills/, NODE_PATH.
const SCRIPT_DIR = path.dirname(realpathSync(fileURLToPath(import.meta.url)));
const RUNTIME_MODULE_LOOKUP = [
  SCRIPT_DIR,
  path.resolve(SCRIPT_DIR, '..', '..', '..', 'container'),
];

export function resolveRuntimeModule(specifier, lookup = RUNTIME_MODULE_LOOKUP) {
  return pathToFileURL(
    createRequire(import.meta.url).resolve(specifier, { paths: lookup }),
  );
}

export async function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import(
      resolveRuntimeModule('pdfjs-dist/legacy/build/pdf.mjs').href
    );
  }
  return pdfJsPromise;
}

export async function loadCanvas() {
  if (!canvasPromise) {
    // Render with the canvas build pdfjs-dist itself loads; Path2D objects
    // from a second @napi-rs/canvas copy are rejected at draw time.
    const pdfJsDir = path.dirname(
      fileURLToPath(resolveRuntimeModule('pdfjs-dist/package.json')),
    );
    canvasPromise = import(
      resolveRuntimeModule('@napi-rs/canvas', [pdfJsDir]).href
    ).catch((err) => {
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

/**
 * Project a text item's transform into viewport space so page rotation
 * (`/Rotate`) and rotated text runs group into the lines a reader sees.
 * Falls back to raw PDF user-space coordinates when no viewport is given.
 */
function positionTextItem(item, options) {
  const transform = Array.isArray(item.transform) ? item.transform : [];
  const width = Number(item.width || 0);
  const rawHeight = Math.abs(Number(item.height || 0));
  const { viewport, Util } = options;
  if (!viewport || !Util || transform.length < 6) {
    return {
      x: Number(transform[4] || 0),
      y: Number(transform[5] || 0),
      width,
      height: rawHeight,
    };
  }
  const projected = Util.transform(viewport.transform, transform);
  const height = Math.hypot(projected[2], projected[3]) || rawHeight;
  // Viewport y grows downwards; negate it so "larger y is higher on the
  // page" keeps holding for the line ordering below.
  return {
    x: Number(projected[4] || 0),
    y: -Number(projected[5] || 0),
    width,
    height,
  };
}

function groupPageTextItems(items, options = {}) {
  const positioned = items
    .map((item) => {
      if (!('str' in item)) return null;
      const text = normalizeText(item.str);
      if (!text) return null;
      const { x, y, width, height } = positionTextItem(item, options);
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
  try {
    const selectedPages = parsePageSelection(pageNumbers, pdf.numPages);
    const pages = [];

    const { Util } = await loadPdfJs();

    for (const pageNumber of selectedPages) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      pages.push({
        pageNumber,
        text: groupPageTextItems(textContent.items, {
          viewport: page.getViewport({ scale: 1 }),
          Util,
        }),
      });
    }

    return {
      pageCount: pdf.numPages,
      selectedPages,
      pages,
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

export async function renderPdfPages(params) {
  const { inputPath, outputDir, pageNumbers, maxDimension } = params;
  const { createCanvas } = await loadCanvas();
  const pdf = await openPdfDocument(inputPath);
  try {
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
      if (
        !Number.isFinite(maxDimension) ||
        maxDimension <= 0 ||
        !Number.isFinite(baseViewport.width) ||
        !Number.isFinite(baseViewport.height) ||
        baseViewport.width <= 0 ||
        baseViewport.height <= 0
      ) {
        throw new Error('Invalid PDF render dimensions');
      }
      // Fit the requested dimension, including upscaling small pages for legible text.
      const scale =
        maxDimension / Math.max(baseViewport.width, baseViewport.height);
      const viewport = page.getViewport({ scale });
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
  } finally {
    await pdf.loadingTask.destroy();
  }
}

// Copy only requested pages: native endpoints must not receive omitted pages.
export async function subsetPdfBytes(inputPath, pages) {
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(await fs.readFile(inputPath));
  const selected = await PDFDocument.create({ updateMetadata: false });
  for (const page of await selected.copyPages(
    source,
    pages.map((page) => page - 1),
  )) {
    selected.addPage(page);
  }
  return Buffer.from(await selected.save());
}

// Literal search returns page locations without filling context with the document.
export async function searchPdfText(inputPath, query) {
  const pdf = await openPdfDocument(inputPath);
  try {
    const needle = query.replace(/\s+/g, ' ').toLowerCase();
    const matches = [];
    let searchedPages = 0;
    // Agent decision, 2026-09-29: cap a search at 500 pages / 20 matching pages;
    // large or scanned documents retain explicit unsearched/sparse coverage.
    let sparsePages = 0;
    for (let number = 1; number <= Math.min(pdf.numPages, 500); number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => item.str || '')
        .join(' ')
        .replace(/\s+/g, ' ');
      searchedPages = number;
      if (text.trim().length < 50) sparsePages++;
      const index = text.toLowerCase().indexOf(needle);
      if (index >= 0)
        matches.push({
          page: number,
          snippet: text.slice(
            Math.max(0, index - 100),
            index + needle.length + 300,
          ),
        });
      page.cleanup();
      if (matches.length >= 20) break;
    }
    return {
      pageCount: pdf.numPages,
      searchedPages,
      omittedPages: pdf.numPages - searchedPages,
      sparsePages,
      matches,
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
