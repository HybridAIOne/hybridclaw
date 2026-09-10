/**
 * Daily-note intake uses the tool's character cap on both sides of the sandbox.
 * Oversized external notes retain both ends; this does not set durable-memory budgets.
 */
import fs from 'node:fs';

// Existing tool limit, shared on 2026-09-08 for issue #1466; configurable budgets deferred.
export const DAILY_MEMORY_MAX_CHARS = 24_000;
const MARKER = '\n...[truncated middle]...\n';

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
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    // UTF-8 can take up to four bytes per character. Bound allocation even
    // for external files that bypass the memory tool's character limit.
    const byteBudget = DAILY_MEMORY_MAX_CHARS * 4;
    if (size <= byteBudget) {
      const buffer = Buffer.alloc(size);
      const count = fs.readSync(fd, buffer, 0, size, 0);
      return truncateDailyMemoryText(buffer.toString('utf8', 0, count));
    }
    const head = Buffer.alloc(byteBudget / 2);
    const tail = Buffer.alloc(byteBudget / 2);
    const headRead = fs.readSync(fd, head, 0, head.length, 0);
    const tailRead = fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    return truncateDailyMemoryText(
      head.toString('utf8', 0, headRead).replace(/\uFFFD+$/, '') +
        MARKER +
        tail.toString('utf8', 0, tailRead).replace(/^\uFFFD+/, ''),
    );
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
