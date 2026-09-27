// Lone surrogates become U+FFFD; valid pairs are kept. The built-ins avoid the
// per-character string building that cost ~300 ms per 2 MB image data URL on
// every model call.
export function replaceUnpairedSurrogates(value) {
  return value.isWellFormed() ? value : value.toWellFormed();
}

const UNSAFE_JSON_STORAGE_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — C0 controls (except tab, newline, carriage return) and DEL are unsafe in stored JSON text
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function replaceUnsafeJsonStorageChars(value) {
  return replaceUnpairedSurrogates(value).replace(
    UNSAFE_JSON_STORAGE_CHARS,
    '\ufffd',
  );
}

export function repairUnicodeForJson(value) {
  if (typeof value === 'string') return replaceUnsafeJsonStorageChars(value);
  if (Array.isArray(value))
    return value.map((entry) => repairUnicodeForJson(entry));
  if (!value || typeof value !== 'object') return value;

  const repaired = {};
  for (const [key, entry] of Object.entries(value)) {
    repaired[replaceUnsafeJsonStorageChars(key)] = repairUnicodeForJson(entry);
  }
  return repaired;
}
