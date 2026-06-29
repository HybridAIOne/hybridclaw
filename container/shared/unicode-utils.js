export function replaceUnpairedSurrogates(value) {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] + value[index + 1];
        index += 1;
      } else {
        output += '\ufffd';
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      output += '\ufffd';
      continue;
    }
    output += value[index];
  }
  return output;
}

export function replaceUnsafeJsonStorageChars(value) {
  const repaired = replaceUnpairedSurrogates(value);
  let output = '';
  for (let index = 0; index < repaired.length; index += 1) {
    const code = repaired.charCodeAt(index);
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      output += '\ufffd';
      continue;
    }
    output += repaired[index];
  }
  return output;
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
