/** Content-addressed visual snapshots; references never grant arbitrary file access. */
export interface VisualAttachment {
  id: string;
  /** Original PDF page numbers; empty for a standalone image. */
  pages: number[];
}
export interface VisualAttachmentMessage {
  visualAttachments?: VisualAttachment[];
}
export interface PdfFilePart {
  type: 'file';
  file: { filename: string; file_data: string };
}
export interface VisualSnapshot {
  pdf: string;
  images: string[];
}
export const PDF_READ_MAX_PAGES: number;
export const VISUAL_SNAPSHOT_MAX_BYTES: number;
export function validateVisualAttachments(value: unknown): VisualAttachment[];
export function saveVisualSnapshot(
  workspaceRoot: string,
  snapshot: VisualSnapshot,
  pages: number[],
): Promise<VisualAttachment>;
export function loadVisualSnapshot(
  workspaceRoot: string,
  attachment: VisualAttachment,
): Promise<VisualSnapshot>;
