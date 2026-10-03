/**
 * String-list comparisons preserve ordered versus set semantics.
 * Unlike channel config comparators, these helpers know nothing about config
 * fields and do not normalize their input.
 */

export function equalStringLists(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function equalStringSets(left: string[], right: string[]): boolean {
  if (left.length === 0 && right.length === 0) return true;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) return false;
  for (const entry of leftSet) {
    if (!rightSet.has(entry)) return false;
  }
  return true;
}
