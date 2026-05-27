// Path segments that would walk into the prototype chain. Guarded in both
// the read and write helpers so a crafted path can never reach
// `Object.prototype` (prototype pollution) — these are generic exported
// helpers, even if today's callers only pass hardcoded admin-config paths.
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function isUnsafeSegment(segment: string): boolean {
  return UNSAFE_SEGMENTS.has(segment);
}

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
    if (isUnsafeSegment(segment)) return undefined;
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
  if (segments.some(isUnsafeSegment)) {
    throw new Error(`setPath rejected an unsafe path segment in "${path}".`);
  }
  const result = assignAt(source, segments, 0, value);
  return result as T;
}

// Clone a container, preserving array-ness. Spreading an array into a plain
// object literal would silently rewrite it into a numeric-keyed object (losing
// `.length`/`.map`), so an array intermediate on the path stays an array.
function cloneContainer(cursor: object): Record<string, unknown> {
  return (
    Array.isArray(cursor) ? [...cursor] : { ...(cursor as object) }
  ) as Record<string, unknown>;
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
    const base = isObject ? cloneContainer(cursor as object) : {};
    base[key] = value;
    return base;
  }
  const child = isObject ? (cursor as Record<string, unknown>)[key] : undefined;
  const nextChild = assignAt(child, segments, index + 1, value);
  if (isObject && nextChild === child) return cursor;
  const base = isObject ? cloneContainer(cursor as object) : {};
  base[key] = nextChild;
  return base;
}
