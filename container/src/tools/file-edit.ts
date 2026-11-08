/**
 * Literal edits visit nonoverlapping occurrences in the original text only.
 * Inserted text is never searched again; the count reports actual substitutions.
 * Unlike file-write, this plans text changes without reading or publishing files.
 */
export function replaceEditOccurrences(
  original: string,
  oldText: string,
  newText: string,
  requestedCount: unknown,
): { content: string; count: number } {
  const limit = requestedCount === undefined ? 1 : requestedCount;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('edit count must be a positive safe integer');
  }
  const parts: string[] = [];
  let offset = 0;
  let count = 0;
  while (count < limit) {
    const index = original.indexOf(oldText, offset);
    if (index === -1) break;
    parts.push(original.slice(offset, index), newText);
    offset = index + oldText.length;
    count += 1;
  }
  parts.push(original.slice(offset));
  return { content: parts.join(''), count };
}
