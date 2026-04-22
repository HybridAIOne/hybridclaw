import {
  normalizeNullableTrimmedString,
  normalizeTrimmedString as normalizeValue,
} from '../../utils/normalized-strings.js';

export const MSTEAMS_CONVERSATION_REFERENCE_KEY =
  'msteams:conversation-reference';
export { isRecord } from '../../utils/type-guards.js';
export { normalizeValue };

export function normalizeOptionalValue(value: unknown): string | null {
  const normalized =
    typeof value === 'string' || typeof value === 'number'
      ? normalizeValue(String(value))
      : '';
  return normalizeNullableTrimmedString(normalized);
}
