export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decodeEntities(value: string): string {
  return value.replace(
    /&(nbsp|amp|quot|#39|lt|gt|#x([0-9a-f]+)|#(\d+));/gi,
    (
      entity,
      name: string,
      hex: string | undefined,
      dec: string | undefined,
    ) => {
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
      if (dec) return String.fromCharCode(Number.parseInt(dec, 10));
      switch (name.toLowerCase()) {
        case 'nbsp':
          return ' ';
        case 'amp':
          return '&';
        case 'quot':
          return '"';
        case '#39':
          return "'";
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        default:
          return entity;
      }
    },
  );
}

export function stripTags(value: string): string {
  let output = '';
  let inTag = false;
  let quote = '';
  for (const character of value) {
    if (!inTag) {
      if (character === '<') {
        inTag = true;
      } else {
        output += character;
      }
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      inTag = false;
    }
  }
  return decodeEntities(output);
}

export function normalizeWhitespace(value: string): string {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function validateHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function normalizeResultUrl(value: unknown): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return validateHttpUrl(normalized);
}

export function dedupeResults<T extends { url: string }>(results: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const result of results) {
    const urlKey = result.url.toLowerCase();
    if (seen.has(urlKey)) continue;
    seen.add(urlKey);
    deduped.push(result);
  }
  return deduped;
}
