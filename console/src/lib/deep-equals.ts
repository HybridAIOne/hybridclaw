/**
 * Structural equality for plain JSON-shaped data plus `Date`. Handles
 * the cases that `JSON.stringify`-based comparison gets wrong:
 *
 *  - object key order (stringify is order-sensitive on V8, often not on
 *    other engines, and serialisation drops keys with `undefined` so
 *    `{a: 1}` and `{a: 1, b: undefined}` stringify equal);
 *  - `Date` (stringify renders the ISO string of `getTime()`, which is
 *    fine for equality but breaks once you mix Date and ISO-string
 *    values in the same draft);
 *  - `NaN`, which compares unequal under `===` but equal here (so
 *    drafts with parsed NaN don't flicker as dirty).
 *
 * Not designed for cyclic graphs, Maps, Sets, or class instances.
 * Admin drafts don't carry any of those today.
 */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date) || !(b instanceof Date)) return false;
    return a.getTime() === b.getTime();
  }

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;
  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }

  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b as Record<string, unknown>, key)) return false;
    if (
      !deepEquals(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
}
