export function normalizeValue(value: string | null | undefined): string {
  return String(value || '').trim();
}
