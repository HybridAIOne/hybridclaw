/**
 * Bounded syntax feedback for saved JSON text, without changing the requested bytes.
 * Unlike file-write preconditions, this is advisory: it grants no permissions,
 * repairs no content, and validates neither schemas nor semantic correctness.
 */
import path from 'node:path';

// 256 KiB (Codex implementation choice, 2026-10-31): bound automatic parsing;
// larger files remain writable and need explicit validation by the caller.
const MAX_JSON_CHECK_BYTES = 256 * 1024;

export function fileSyntaxFeedback(filePath: string, contents: string): string {
  if (path.extname(filePath).toLowerCase() !== '.json') return '';
  if (
    contents.length > MAX_JSON_CHECK_BYTES ||
    Buffer.byteLength(contents) > MAX_JSON_CHECK_BYTES
  ) {
    return '\nJSON syntax was not checked automatically because the file exceeds the bounded check size.';
  }
  try {
    JSON.parse(contents);
    return '';
  } catch {
    // Parser exceptions may quote sensitive file contents; do not return them.
    return '\nWarning: JSON syntax is invalid. The requested text was saved; correct it before using this file as valid JSON.';
  }
}
