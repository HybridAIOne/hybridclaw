export const normalizeBaseUrl = (baseUrl: string): string =>
  String(baseUrl || '')
    .trim()
    .replace(/\/+$/g, '');

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function ensureText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
