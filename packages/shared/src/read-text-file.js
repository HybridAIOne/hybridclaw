/**
 * Prompt file intake bounds disk reads and allocation while retaining both ends.
 * Unlike prompt truncation, this only samples bytes; callers own character budgets.
 */
import fs from 'node:fs';

export const TEXT_FILE_TRUNCATION_MARKER = '\n...[truncated middle]...\n';

export function readTextFileHeadTail(filePath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= maxBytes) {
      const buffer = Buffer.alloc(size);
      const count = fs.readSync(fd, buffer, 0, size, 0);
      return buffer.toString('utf8', 0, count);
    }
    const head = Buffer.alloc(Math.ceil(maxBytes / 2));
    const tail = Buffer.alloc(Math.floor(maxBytes / 2));
    const headRead = fs.readSync(fd, head, 0, head.length, 0);
    const tailRead = fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    return (
      head.toString('utf8', 0, headRead).replace(/\uFFFD+$/, '') +
      TEXT_FILE_TRUNCATION_MARKER +
      tail.toString('utf8', 0, tailRead).replace(/^\uFFFD+/, '')
    );
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
