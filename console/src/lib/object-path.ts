/**
 * Read a deeply-nested value from a plain object via a dotted path
 * (e.g. `'ops.healthPort'`). Returns `undefined` for missing intermediates.
 * Array indices are not supported — admin configs don't use them in
 * editable positions today.
 */
export function getPath<T>(source: unknown, path: string): T | undefined {
  if (source === null || source === undefined) return undefined;
  const segments = path.split('.');
  let cursor: unknown = source;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor as T | undefined;
}

/**
 * Return a structurally-shared copy of `source` with the value at `path`
 * replaced by `value`. Each segment along the path produces a fresh
 * object; siblings are kept by reference. Missing intermediates are
 * created as empty objects.
 */
export function setPath<T extends object>(source: T, path: string, value: unknown): T {
  if (!path) {
    throw new Error('setPath requires a non-empty path.');
  }
  const segments = path.split('.');
  return assignAt(source, segments, 0, value) as T;
}

function assignAt(
  cursor: unknown,
  segments: string[],
  index: number,
  value: unknown,
): unknown {
  const key = segments[index];
  const isLast = index === segments.length - 1;
  const base: Record<string, unknown> =
    cursor !== null && typeof cursor === 'object'
      ? { ...(cursor as Record<string, unknown>) }
      : {};
  base[key] = isLast
    ? value
    : assignAt(base[key], segments, index + 1, value);
  return base;
}
