/**
 * Saved-result identity on a tool message or execution: the digest names the
 * exact bytes saved for one outcome. NOT the history validator or digest
 * format check (`packages/shared/src/tool-history.ts`), which need Node and run
 * on top of `ContainerOutputSchema`.
 */

/** Digest binds one saved outcome; a provider call ID alone is not identity. */
export interface FileBackedToolResult {
  resultDigest?: string;
}
