import type { PdfAttachmentMessage } from './pdf-attachments.js';
export interface PdfReadOptions {
  workspaceRoot?: string;
  pages?: string;
  render?: 'auto' | 'always' | 'never';
  outputDir?: string;
  runtimeUrl?: string;
  maxChars?: number;
}
export interface PdfReadResult extends PdfAttachmentMessage {
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
export { PDF_READ_MAX_PAGES } from './pdf-attachments.js';
export const PDF_PREVIEW_MAX_CHARS: number;
export function readPdfPages(
  filePath: string,
  options?: PdfReadOptions,
): Promise<PdfReadResult>;
