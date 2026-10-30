/**
 * Bounded text slices and literal search, including single-line tool results.
 * Unlike PDF reads this operates only on already authorized decoded text;
 * it neither resolves paths nor expands read permissions.
 */

// Engineering choice, 2026-10-30: 2k decoded chars keeps even JSON-escaped
// excerpts below the inline tool-result cap; callers page for more evidence.
const MAX_EXCERPT_CHARS = 2_000;

export const TEXT_READ_PARAMETERS = {
  query: {
    type: 'string',
    description:
      'Literal search in text or extracted PDF text. Text returns bounded matching excerpts and character offsets; PDF returns page numbers. Use char_offset to continue text search.',
  },
  char_offset: {
    type: 'integer',
    minimum: 0,
    description:
      'Zero-based text character offset; works on long single lines.',
  },
  max_chars: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_EXCERPT_CHARS,
    description: 'Maximum text excerpt characters (default and cap: 2000).',
  },
};

export function readTextExcerpt(
  content: string,
  args: Record<string, unknown>,
): string | undefined {
  if (
    args.query === undefined &&
    args.char_offset === undefined &&
    args.max_chars === undefined
  )
    return undefined;
  const offset = args.char_offset ?? 0;
  const limit = args.max_chars ?? MAX_EXCERPT_CHARS;
  if (
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > content.length
  )
    throw new Error('char_offset must be an integer within the text');
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1)
    throw new Error('max_chars must be a positive integer');
  if (
    args.query !== undefined &&
    (typeof args.query !== 'string' || !args.query.length)
  )
    throw new Error('query must be a nonempty literal string');
  const budget = Math.min(limit, MAX_EXCERPT_CHARS);
  const matchOffset =
    typeof args.query === 'string'
      ? content.indexOf(args.query, offset)
      : offset;
  if (matchOffset === -1)
    return JSON.stringify({
      totalChars: content.length,
      found: false,
      nextOffset: null,
    });
  const start =
    typeof args.query === 'string'
      ? Math.max(offset, matchOffset - Math.floor(budget / 4))
      : offset;
  const end = Math.min(content.length, start + budget);
  return JSON.stringify({
    totalChars: content.length,
    offset: start,
    matchOffset,
    text: content.slice(start, end),
    nextOffset: end < content.length ? end : null,
  });
}
