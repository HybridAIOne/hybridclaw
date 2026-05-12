export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/gi, (_, dec) =>
      String.fromCharCode(Number.parseInt(dec, 10)),
    );
}

export function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ''));
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
