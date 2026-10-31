/** Gateway-owned media permissions and capabilities are rebuilt each turn, including after restart. */
export interface SessionAttachmentAccess {
  /** Policy permission to send pixels; independent of primary-model capability. */
  visualMediaAllowed?: boolean;
  primaryModelSupportsVisualMedia?: boolean;
  readableMediaPaths?: string[];
}
