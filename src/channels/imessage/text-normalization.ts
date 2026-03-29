export function normalizeIMessageComparableText(
  value: string | null | undefined,
): string {
  return String(value || '')
    .trim()
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .slice(0, 256);
}
