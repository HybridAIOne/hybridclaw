/**
 * Bounded, page-addressable PDF reads shared by preview and worker tools.
 * File authorization belongs to the caller; this module never fetches URLs or
 * calls a model. The bundled PDF skill remains the extraction/render engine.
 */
import fs from 'node:fs/promises';
import { PDF_READ_MAX_PAGES, savePdfSnapshot } from './pdf-attachments.js';

export { PDF_READ_MAX_PAGES } from './pdf-attachments.js';

// Agent decision, 2026-09-29: four pages / 24k text / 50 MiB per read bound
// ingestion; larger documents are read in batches. Selected pages are also the native transport boundary.
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_CHARS = 24_000;
export const PDF_PREVIEW_MAX_CHARS = 6_000;
// Agent decision, 2026-09-29: 50 characters is only a sparse-text hint;
// visual tasks still request all selected pages. 1600px bounds raster memory.
const SPARSE_PAGE_CHARS = 50;
const RENDER_MAX_DIMENSION = 1600;

function selectPages(selection) {
  if (selection === undefined) return `1-${PDF_READ_MAX_PAGES}`;
  if (typeof selection !== 'string' || !selection.trim()) {
    throw new Error(
      'pages must be a nonempty page range such as "1-4" or "5,7"',
    );
  }
  const selected = new Set();
  for (const token of selection.split(',')) {
    const match = token.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error('Invalid PDF page selection');
    const first = Number(match[1]);
    const last = Number(match[2] || match[1]);
    if (
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      first < 1 ||
      last < first
    ) {
      throw new Error('PDF pages must be positive, ascending integers');
    }
    if (last - first >= PDF_READ_MAX_PAGES)
      throw new Error(`Read at most ${PDF_READ_MAX_PAGES} PDF pages per call`);
    for (let page = first; page <= last; page += 1) selected.add(page);
    if (selected.size > PDF_READ_MAX_PAGES)
      throw new Error(`Read at most ${PDF_READ_MAX_PAGES} PDF pages per call`);
  }
  return [...selected].sort((a, b) => a - b).join(',');
}

export async function readPdfPages(filePath, options = {}) {
  const selection = selectPages(options.pages);
  const render = options.render ?? 'auto';
  if (!['auto', 'always', 'never'].includes(render))
    throw new Error('render must be auto, always, or never');
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_BYTES)
    throw new Error('PDF must be a regular file of at most 50 MiB');
  const runtime = await import(
    options.runtimeUrl ??
      new URL('../../skills/pdf/scripts/_pdf_runtime.mjs', import.meta.url).href
  );
  const extracted = await runtime.extractPdfText(filePath, selection);
  if (
    options.pages !== undefined &&
    selection.split(',').some((page) => Number(page) > extracted.pageCount)
  ) {
    throw new Error(
      `Requested page exceeds PDF page count (${extracted.pageCount})`,
    );
  }
  let remaining = options.maxChars ?? MAX_TEXT_CHARS;
  const pages = extracted.pages.map((page) => {
    const text = page.text.slice(0, Math.max(0, remaining));
    remaining -= text.length;
    return {
      page: page.pageNumber,
      text,
      textTruncated: text.length < page.text.length,
      // Sparse text is a scan hint, not proof that a page has no visual content.
      needsVisualInspection: page.text.trim().length < SPARSE_PAGE_CHARS,
    };
  });
  const result = {
    pageCount: extracted.pageCount,
    processedPages: extracted.selectedPages,
    omittedPages: extracted.pageCount - extracted.selectedPages.length,
    pages,
    images: [],
  };
  const imagePages = pages.filter(
    (page) =>
      render === 'always' ||
      (render === 'auto' &&
        (options.workspaceRoot || page.needsVisualInspection)),
  );
  if (imagePages.length && render !== 'never' && options.outputDir) {
    try {
      const rendered = await runtime.renderPdfPages({
        inputPath: filePath,
        outputDir: options.outputDir,
        pageNumbers: imagePages.map((page) => page.page).join(','),
        maxDimension: RENDER_MAX_DIMENSION,
      });
      result.images = rendered.written.map((imagePath, index) => ({
        page: rendered.selectedPages[index],
        path: imagePath,
      }));
    } catch {
      result.renderError =
        'Page rendering failed; visual content has not been inspected.';
    }
  }
  if (options.workspaceRoot && render !== 'never') {
    try {
      const pdf = await runtime.subsetPdfBytes(filePath, result.processedPages);
      const images = await Promise.all(
        result.images.map(async (image) =>
          (await fs.readFile(image.path)).toString('base64'),
        ),
      );
      result.pdfAttachments = [
        await savePdfSnapshot(
          options.workspaceRoot,
          {
            pdf: pdf.toString('base64'),
            images,
          },
          result.processedPages,
        ),
      ];
    } catch {
      result.renderError =
        'PDF visual snapshot unavailable; only extracted text is available. Try fewer pages.';
    }
  }
  return result;
}
