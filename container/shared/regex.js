/**
 * Regex literal escaping: `escapeRegExp(value)` escapes every RegExp syntax
 * character, so the result spliced into a RegExp source outside a character
 * class matches `value` literally, with or without the `u` flag. It adds no
 * anchors, flags, or boundaries. NOT a glob compiler: `*` and `?` come out
 * literal.
 */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
