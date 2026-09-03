import {
  isMSTeamsDmSessionId,
  isMSTeamsSessionId,
} from '../../../container/shared/msteams-session-ids.js';
import { getSessionById } from '../../memory/db.js';
import type { Session } from '../../types/session.js';
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
  looksLikeMSTeamsConversationId,
} from '../../../container/shared/msteams-session-ids.js';
export { isRecord } from '../../utils/type-guards.js';
export { normalizeValue };

type SessionKeyFields = Pick<Session, 'id' | 'session_key'>;

// Since the multi-session re-keying, Teams session rows carry generated
// `sess_*` instance ids; the Teams identity lives in `session_key`.
// Pre-migration rows still use the canonical key (or legacy `teams:...` id)
// as their row id, so both columns are consulted.
export function isMSTeamsSession(session: SessionKeyFields): boolean {
  return (
    isMSTeamsSessionId(session.session_key) || isMSTeamsSessionId(session.id)
  );
}

export function isMSTeamsDmSession(session: SessionKeyFields): boolean {
  return (
    isMSTeamsDmSessionId(session.session_key) ||
    isMSTeamsDmSessionId(session.id)
  );
}

// The canonical key the Teams runtime uses for its active-session map and
// stored conversation references (`buildSessionIdFromActivity` output).
export function resolveMSTeamsSessionKey(session: SessionKeyFields): string {
  const sessionKey = normalizeValue(session.session_key);
  if (isMSTeamsSessionId(sessionKey)) return sessionKey;
  return normalizeValue(session.id);
}

// Resolves a message-tool `sessionId` (instance id, canonical key, or legacy
// `teams:...` id) to its Teams session row, or null when the id is unknown or
// belongs to another channel.
export function resolveMSTeamsRequestSession(
  sessionId: string | undefined,
): Session | null {
  const normalized = normalizeValue(sessionId);
  if (!normalized) return null;
  const session = getSessionById(normalized);
  if (!session || !isMSTeamsSession(session)) return null;
  return session;
}

export function normalizeOptionalValue(value: unknown): string | null {
  const normalized =
    typeof value === 'string' || typeof value === 'number'
      ? normalizeValue(String(value))
      : '';
  return normalizeNullableTrimmedString(normalized);
}
