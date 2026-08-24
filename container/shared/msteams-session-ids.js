import { parseSessionKey } from './session-keys.js';

// Pre-migration Teams rows keep their legacy `teams:...` ids forever
// (classifySessionKeyShape treats them as opaque), so both spellings
// stay valid indefinitely.
const LEGACY_MSTEAMS_SESSION_ID_RE = /^teams:/i;
const LEGACY_MSTEAMS_DM_SESSION_ID_RE = /^teams:dm:/i;

export function isMSTeamsSessionId(value) {
  const normalized = String(value || '').trim();
  if (LEGACY_MSTEAMS_SESSION_ID_RE.test(normalized)) return true;
  return parseSessionKey(normalized)?.channelKind === 'msteams';
}

export function isMSTeamsDmSessionId(value) {
  const normalized = String(value || '').trim();
  if (LEGACY_MSTEAMS_DM_SESSION_ID_RE.test(normalized)) return true;
  const parsed = parseSessionKey(normalized);
  return parsed?.channelKind === 'msteams' && parsed.chatType === 'dm';
}
