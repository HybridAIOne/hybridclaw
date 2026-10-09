/**
 * A session's scope: set once, when the chat begins, and never changed.
 *
 * A request naming a scope (`/api/chat` body `scope`, a voice call's start
 * frame) gives it to a session that has none and has had no model turn yet;
 * commands the app sends before the first message do not count. Any later
 * request's scope is ignored: the stored one wins. The agent's main chat
 * (`main-…`) is never scoped.
 *
 * NOT what a run in a scoped session uses (`scope-run.ts`) or who may create
 * scopes (`scope-routes.ts`).
 */

import {
  getRuntimeConfig,
  resolveDefaultAgentId,
} from '../config/runtime-config.js';
import {
  getOrCreateSession,
  getSessionById,
  setSessionScopeOnce,
} from '../memory/sessions.js';
import type { Session } from '../types/session.js';
import { getScope, isScopeId } from './scope-store.js';

export type ScopeErrorCode = 'unknown_scope' | 'scope_deleted';

export interface ScopeRunError {
  errorCode: ScopeErrorCode;
  error: string;
}

export const UNKNOWN_SCOPE_ERROR: ScopeRunError = {
  errorCode: 'unknown_scope',
  error: 'This scope does not exist.',
};

export const SCOPE_DELETED_ERROR: ScopeRunError = {
  errorCode: 'scope_deleted',
  error: 'The scope of this chat was deleted.',
};

function isMainChat(session: Pick<Session, 'session_key'>): boolean {
  return session.session_key.startsWith('main-');
}

/**
 * Applies a request's `scope` to its session. Returns an error for a scope
 * the agent does not have when the session would take it; null otherwise,
 * also when the request's scope is ignored because the session's stands.
 */
export function bindRequestedScope(params: {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  agentId?: string | null;
  requestedScope: unknown;
}): ScopeRunError | null {
  if (
    params.requestedScope === undefined ||
    params.requestedScope === null ||
    params.requestedScope === ''
  ) {
    return null;
  }
  const existing = getSessionById(params.sessionId);
  if (
    existing &&
    (existing.scope || existing.message_count > 0 || isMainChat(existing))
  ) {
    return null;
  }
  const agentId =
    params.agentId?.trim() ||
    existing?.agent_id ||
    resolveDefaultAgentId(getRuntimeConfig());
  if (
    !isScopeId(params.requestedScope) ||
    !getScope(agentId, params.requestedScope)
  ) {
    return UNKNOWN_SCOPE_ERROR;
  }
  const session =
    existing ??
    getOrCreateSession(
      params.sessionId,
      params.guildId,
      params.channelId,
      agentId,
    );
  if (!isMainChat(session)) {
    setSessionScopeOnce(session.id, params.requestedScope);
  }
  return null;
}

/** The scope a run in this session uses, or null for an unscoped session. */
export function sessionScopeId(sessionId: string): string | null {
  return getSessionById(sessionId)?.scope || null;
}

/** `scope_deleted` for a session whose scope is gone, else null. */
export function deletedScopeError(
  sessionId: string,
  agentId: string,
): ScopeRunError | null {
  const scopeId = sessionScopeId(sessionId);
  return scopeId && !getScope(agentId, scopeId) ? SCOPE_DELETED_ERROR : null;
}
