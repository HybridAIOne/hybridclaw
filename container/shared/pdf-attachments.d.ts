/** Content-addressed PDF page snapshots; references never grant arbitrary file access. */
export interface PdfAttachment {
  id: string;
  pages: number[];
}
export interface PdfAttachmentMessage {
  pdfAttachments?: PdfAttachment[];
}
export interface PdfFilePart {
  type: 'file';
  file: { filename: string; file_data: string };
}
export interface PdfSnapshot {
  pdf: string;
  images: string[];
}
export const PDF_READ_MAX_PAGES: number;
export const PDF_SNAPSHOT_MAX_BYTES: number;
export function validatePdfAttachments(value: unknown): PdfAttachment[];
export function savePdfSnapshot(
  workspaceRoot: string,
  snapshot: PdfSnapshot,
  pages: number[],
): Promise<PdfAttachment>;
export function loadPdfSnapshot(
  workspaceRoot: string,
  attachment: PdfAttachment,
): Promise<PdfSnapshot>;
