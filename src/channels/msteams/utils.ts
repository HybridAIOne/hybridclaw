import { parseSessionKey } from '../../session/session-key.js';
import {
  normalizeNullableTrimmedString,
  normalizeTrimmedString as normalizeValue,
} from '../../utils/normalized-strings.js';

export const MSTEAMS_CONVERSATION_REFERENCE_KEY =
  'msteams:conversation-reference';
export const MSTEAMS_RATING_TARGETS_KEY = 'msteams:rating-targets';
export { isRecord } from '../../utils/type-guards.js';
export { normalizeValue };

const LEGACY_MSTEAMS_SESSION_ID_RE = /^teams:/i;
const LEGACY_MSTEAMS_DM_SESSION_ID_RE = /^teams:dm:/i;

export function isMSTeamsSessionId(value: string | null | undefined): boolean {
  const normalized = normalizeValue(String(value || ''));
  if (LEGACY_MSTEAMS_SESSION_ID_RE.test(normalized)) return true;
  return parseSessionKey(normalized)?.channelKind === 'msteams';
}

export function isMSTeamsDmSessionId(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeValue(String(value || ''));
  if (LEGACY_MSTEAMS_DM_SESSION_ID_RE.test(normalized)) return true;
  const parsed = parseSessionKey(normalized);
  return parsed?.channelKind === 'msteams' && parsed.chatType === 'dm';
}

export function normalizeOptionalValue(value: unknown): string | null {
  const normalized =
    typeof value === 'string' || typeof value === 'number'
      ? normalizeValue(String(value))
      : '';
  return normalizeNullableTrimmedString(normalized);
}
