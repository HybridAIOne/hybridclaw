/**
 * PDF branch of read: inherits read's authorized local file, never expands access.
 * Returns text and durable selected-page references for the main model request.
 * Provider dispatch chooses native PDF or images; this is not a model client.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PDF_READ_MAX_PAGES,
  type PdfReadOptions,
  readPdfPages,
  searchPdfPages,
} from '../shared/pdf-reader.js';
import { WORKSPACE_ROOT } from './runtime-paths.js';
import type { ToolRunResult } from './types.js';

export const PDF_READ_PARAMETERS = {
  query: {
    type: 'string',
    description:
      'Search PDF text/captions literally, e.g. "Figure 3". Returns page numbers and snippets; then read with pages to inspect them visually. Cannot combine with pages/render.',
  },
  pages: {
    type: 'string',
    description: `PDF page range, e.g. "5-8" or "1,3"; at most ${PDF_READ_MAX_PAGES} pages per call. Defaults to the first ${PDF_READ_MAX_PAGES} pages.`,
  },
  render: {
    type: 'string',
    enum: ['auto', 'never'],
    description:
      'PDF images: auto attaches selected pages directly to the model; never extracts text only.',
  },
};

export async function readPdfFile(
  filePath: string,
  args: Record<string, unknown>,
): Promise<ToolRunResult> {
  if (
    args.render !== undefined &&
    (typeof args.render !== 'string' ||
      !PDF_READ_PARAMETERS.render.enum.includes(args.render))
  )
    throw new Error('render must be auto or never');
  if (args.offset !== undefined || args.limit !== undefined)
    throw new Error('Use pages for PDFs, not line offset/limit');
  const runtimeUrl = pathToFileURL(
    path.join(WORKSPACE_ROOT, 'skills/pdf/scripts/_pdf_runtime.mjs'),
  ).href;
  if (args.query !== undefined) {
    if (args.pages !== undefined || args.render !== undefined)
      throw new Error(
        'Use query to locate pages, then a separate read with pages; do not combine query with pages/render',
      );
    return {
      isError: false,
      output: JSON.stringify({
        ...(await searchPdfPages(filePath, args.query, runtimeUrl)),
        next: 'Read matching pages with pages to inspect figures. Search covers extracted text, not scanned text. No shell conversion or cleanup is needed.',
      }),
    };
  }
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hybridclaw-pdf-'));
  try {
    const result = await readPdfPages(filePath, {
      pages: args.pages as PdfReadOptions['pages'],
      render: args.render as PdfReadOptions['render'],
      outputDir,
      workspaceRoot: WORKSPACE_ROOT,
      runtimeUrl,
    });
    const { visualAttachments, images, ...summary } = result;
    return {
      isError: false,
      visualAttachments,
      output: JSON.stringify({
        ...summary,
        snapshotId: visualAttachments?.[0]?.id.slice(0, 12),
        renderedPages: images.map((image) => image.page),
        visualDelivery: visualAttachments?.length
          ? 'Selected pages queued for direct model delivery; dispatch reports actual coverage.'
          : 'Text only',
        next: 'Read omitted pages with read.pages. Use original page numbers for citations. Only claim coverage of pages delivered to this request.',
      }),
    };
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}
