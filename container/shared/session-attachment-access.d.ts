/** Gateway-owned media permissions are rebuilt each turn, including after restart. */
export interface SessionAttachmentAccess {
  visualMediaAllowed?: boolean;
  readableMediaPaths?: string[];
}
