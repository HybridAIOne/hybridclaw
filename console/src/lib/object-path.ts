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
 *
 * Idempotent — when the value at `path` already === `value`, the
 * original `source` reference is returned unchanged so React consumers
 * downstream of a `setField('x', sameValue)` call don't re-render.
 */
export function setPath<T extends object>(
  source: T,
  path: string,
  value: unknown,
): T {
  if (!path) {
    throw new Error('setPath requires a non-empty path.');
  }
  const segments = path.split('.');
  const result = assignAt(source, segments, 0, value);
  return result as T;
}

function assignAt(
  cursor: unknown,
  segments: string[],
  index: number,
  value: unknown,
): unknown {
  const key = segments[index];
  const isLast = index === segments.length - 1;
  const isObject = cursor !== null && typeof cursor === 'object';
  if (isLast) {
    if (isObject && (cursor as Record<string, unknown>)[key] === value) {
      return cursor;
    }
    const base: Record<string, unknown> = isObject
      ? { ...(cursor as Record<string, unknown>) }
      : {};
    base[key] = value;
    return base;
  }
  const child = isObject ? (cursor as Record<string, unknown>)[key] : undefined;
  const nextChild = assignAt(child, segments, index + 1, value);
  if (isObject && nextChild === child) return cursor;
  const base: Record<string, unknown> = isObject
    ? { ...(cursor as Record<string, unknown>) }
    : {};
  base[key] = nextChild;
  return base;
}
