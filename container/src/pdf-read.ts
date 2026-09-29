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
} from '../shared/pdf-reader.js';
import { WORKSPACE_ROOT } from './runtime-paths.js';
import type { ToolRunResult } from './types.js';

export const PDF_READ_PARAMETERS = {
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
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hybridclaw-pdf-'));
  try {
    const result = await readPdfPages(filePath, {
      pages: args.pages as PdfReadOptions['pages'],
      render: args.render as PdfReadOptions['render'],
      outputDir,
      workspaceRoot: WORKSPACE_ROOT,
      runtimeUrl: pathToFileURL(
        path.join(WORKSPACE_ROOT, 'skills/pdf/scripts/_pdf_runtime.mjs'),
      ).href,
    });
    const { pdfAttachments, images, ...summary } = result;
    return {
      isError: false,
      pdfAttachments,
      output: JSON.stringify({
        ...summary,
        snapshotId: pdfAttachments?.[0]?.id.slice(0, 12),
        renderedPages: images.map((image) => image.page),
        visualDelivery: pdfAttachments?.length
          ? 'Selected pages queued for direct model delivery; dispatch reports actual coverage.'
          : 'Text only',
        next: 'Read omitted pages with read.pages. Use original page numbers for citations. Only claim coverage of pages delivered to this request.',
      }),
    };
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}
