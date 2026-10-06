/**
 * Daily-note intake uses the tool's character cap on both sides of the sandbox.
 * Oversized external notes retain both ends; this does not set durable-memory budgets.
 */
import {
  TEXT_FILE_TRUNCATION_MARKER as MARKER,
  readTextFileHeadTail,
} from './read-text-file.js';

// Existing tool limit, shared on 2026-09-08 for issue #1466; configurable budgets deferred.
export const DAILY_MEMORY_MAX_CHARS = 24_000;

export function truncateDailyMemoryText(
  content,
  maxChars = DAILY_MEMORY_MAX_CHARS,
) {
  if (content.length <= maxChars) return content;
  if (maxChars <= MARKER.length) return MARKER.slice(0, maxChars);
  const available = maxChars - MARKER.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return (
    content.slice(0, head).replace(/[\uD800-\uDBFF]$/, '') +
    MARKER +
    (tail ? content.slice(-tail).replace(/^[\uDC00-\uDFFF]/, '') : '')
  );
}

export function readDailyMemoryFile(filePath) {
  const content = readTextFileHeadTail(filePath, DAILY_MEMORY_MAX_CHARS * 4);
  return content === null ? null : truncateDailyMemoryText(content);
}
