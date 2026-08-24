import {
  normalizeNullableTrimmedString,
  normalizeTrimmedString as normalizeValue,
} from '../../utils/normalized-strings.js';

export const MSTEAMS_CONVERSATION_REFERENCE_KEY =
  'msteams:conversation-reference';
export const MSTEAMS_RATING_TARGETS_KEY = 'msteams:rating-targets';
export {
  isMSTeamsDmSessionId,
  isMSTeamsSessionId,
} from '../../../container/shared/msteams-session-ids.js';
export { isRecord } from '../../utils/type-guards.js';
export { normalizeValue };

export function looksLikeMSTeamsConversationId(value: string): boolean {
  return /^(?:a:|19:)/.test(normalizeValue(value));
}

export function normalizeOptionalValue(value: unknown): string | null {
  const normalized =
    typeof value === 'string' || typeof value === 'number'
      ? normalizeValue(String(value))
      : '';
  return normalizeNullableTrimmedString(normalized);
}
