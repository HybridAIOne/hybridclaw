/**
 * Bounded, page-addressable PDF reads shared by preview and worker tools.
 * File authorization belongs to the caller; this module never fetches URLs or
 * calls a model. Native rendering runs outside the reader process so a canvas
 * crash cannot discard extracted text or kill the worker serving the turn.
 */
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import type { VisualAttachmentMessage } from './visual-snapshots.js';
import { PDF_READ_MAX_PAGES, saveVisualSnapshot } from './visual-snapshots.js';

export interface PdfReadOptions {
  workspaceRoot?: string;
  pages?: string;
  render?: 'auto' | 'always' | 'never';
  outputDir?: string;
  runtimeUrl?: string;
  maxChars?: number;
}
export interface PdfReadResult extends VisualAttachmentMessage {
  pageCount: number;
  processedPages: number[];
  omittedPages: number;
  pages: Array<{
    page: number;
    text: string;
    textTruncated: boolean;
    needsVisualInspection: boolean;
  }>;
  images: Array<{ page: number; path: string }>;
  renderError?: string;
}

interface PdfSearchResult {
  pageCount: number;
  searchedPages: number;
  omittedPages: number;
  sparsePages: number;
  matches: Array<{ page: number; snippet: string }>;
}

interface PdfRuntime {
  extractPdfText(
    inputPath: string,
    pageNumbers: string,
  ): Promise<{
    pageCount: number;
    selectedPages: number[];
    pages: Array<{ pageNumber: number; text: string }>;
  }>;
  subsetPdfBytes(inputPath: string, pages: number[]): Promise<Buffer>;
  searchPdfText(inputPath: string, query: string): Promise<PdfSearchResult>;
}

export { PDF_READ_MAX_PAGES } from './visual-snapshots.js';

// Agent decision, 2026-09-29: four pages / 24k text / 50 MiB per read bound
// ingestion; larger documents are read in batches. Selected pages are also the native transport boundary.
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_CHARS = 24_000;
export const PDF_PREVIEW_MAX_CHARS: number = 6_000;
// Agent decision, 2026-09-29: 50 characters is only a sparse-text hint;
// visual tasks still request all selected pages. 1600px bounds raster memory.
const SPARSE_PAGE_CHARS = 50;
const RENDER_MAX_DIMENSION = 1600;

interface RenderedPage {
  page: number;
  path: string;
}

function renderInChild(
  runtimeUrl: string,
  inputPath: string,
  outputDir: string,
  pages: number[],
): Promise<RenderedPage[]> {
  const params = {
    inputPath,
    outputDir,
    pageNumbers: pages.join(','),
    maxDimension: RENDER_MAX_DIMENSION,
  };
  return new Promise((resolve, reject) => {
    const child = fork(
      new URL('render_pdf_pages.mjs', runtimeUrl),
      ['--render-for-read', JSON.stringify(params)],
      { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    let result: { written?: unknown; selectedPages?: unknown[] } | undefined;
    child.once('message', (message) => {
      result = message as typeof result;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) {
        reject(Object.assign(new Error('PDF renderer exited'), { signal }));
      } else if (
        result &&
        Array.isArray(result.written) &&
        result.written.length === pages.length &&
        pages.every(
          (page, i) =>
            result?.selectedPages?.[i] === page &&
            typeof (result.written as unknown[])[i] === 'string',
        )
      ) {
        const written = result.written as string[];
        resolve(pages.map((page, i) => ({ page, path: written[i] })));
      } else {
        reject(new Error('PDF renderer returned an incomplete page list'));
      }
    });
  });
}

async function renderReadPages(
  runtimeUrl: string,
  inputPath: string,
  outputDir: string,
  pages: number[],
): Promise<RenderedPage[]> {
  try {
    return await renderInChild(runtimeUrl, inputPath, outputDir, pages);
  } catch (error) {
    if (
      (error as { signal?: unknown })?.signal !== 'SIGSEGV' ||
      pages.length < 2
    )
      throw error;
    // A native drawing fault can depend on earlier pages. Re-render each in
    // a fresh process; a partial PNG left by the crashed process is untrusted.
    const images: RenderedPage[] = [];
    for (const page of pages) {
      images.push(
        ...(await renderInChild(runtimeUrl, inputPath, outputDir, [page])),
      );
    }
    return images;
  }
}

export function firstPdfPageBatch(
  selection: unknown,
): { pages: string; hasMore: boolean } | undefined {
  if (selection === undefined) return undefined;
  if (typeof selection !== 'string' || !selection.trim()) {
    throw new Error(
      'pages must be a nonempty page range such as "1-4" or "5,7"',
    );
  }
  const selected = new Set<number>();
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
    // One extra distinct page detects overflow without expanding a large range.
    for (
      let page = first;
      page <= last && selected.size <= PDF_READ_MAX_PAGES;
      page += 1
    )
      selected.add(page);
  }
  return {
    pages: [...selected]
      .slice(0, PDF_READ_MAX_PAGES)
      .sort((a, b) => a - b)
      .join(','),
    hasMore: selected.size > PDF_READ_MAX_PAGES,
  };
}

export async function readPdfPages(
  filePath: string,
  options: PdfReadOptions = {},
): Promise<PdfReadResult> {
  const batch = firstPdfPageBatch(options.pages);
  if (batch?.hasMore)
    throw new Error(`Read at most ${PDF_READ_MAX_PAGES} PDF pages per call`);
  const selection = batch?.pages ?? `1-${PDF_READ_MAX_PAGES}`;
  const render = options.render ?? 'auto';
  if (!['auto', 'always', 'never'].includes(render))
    throw new Error('render must be auto, always, or never');
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_BYTES)
    throw new Error('PDF must be a regular file of at most 50 MiB');
  const runtimeUrl =
    options.runtimeUrl ??
    new URL('../../../skills/pdf/scripts/_pdf_runtime.mjs', import.meta.url)
      .href;
  const runtime: PdfRuntime = await import(runtimeUrl);
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
  const result: PdfReadResult = {
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
      result.images = await renderReadPages(
        runtimeUrl,
        filePath,
        options.outputDir,
        imagePages.map((page) => page.page),
      );
    } catch (error) {
      const signal = (error as { signal?: unknown })?.signal;
      const reason = signal ? `stopped (${String(signal)})` : 'failed';
      result.renderError = `Page rendering ${reason}; visual content has not been inspected.`;
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
      result.visualAttachments = [
        await saveVisualSnapshot(
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

export async function searchPdfPages(
  filePath: string,
  query: unknown,
  runtimeUrl?: string,
): Promise<PdfSearchResult> {
  if (typeof query !== 'string' || !query.trim() || query.length > 256)
    throw new Error(
      'PDF query must be literal text between 1 and 256 characters',
    );
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_BYTES)
    throw new Error('PDF must be a regular file of at most 50 MiB');
  const runtime: PdfRuntime = await import(
    runtimeUrl ??
      new URL('../../../skills/pdf/scripts/_pdf_runtime.mjs', import.meta.url)
        .href
  );
  return runtime.searchPdfText(filePath, query.trim());
}
