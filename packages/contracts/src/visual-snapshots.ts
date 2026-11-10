/**
 * Visual attachment references on model messages and the PDF part a message
 * may carry. A reference names stored snapshot bytes; it never grants file
 * access. NOT the snapshot store or its validators
 * (`@hybridclaw/shared/visual-snapshots`).
 */

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
