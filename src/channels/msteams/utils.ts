export const MSTEAMS_CONVERSATION_REFERENCE_KEY =
  'msteams:conversation-reference';

export function normalizeValue(value: string | null | undefined): string {
  return String(value || '').trim();
}

export function normalizeOptionalValue(value: unknown): string | null {
  const normalized =
    typeof value === 'string' || typeof value === 'number'
      ? normalizeValue(String(value))
      : '';
  return normalized || null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
