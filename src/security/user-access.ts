import { randomUUID } from 'node:crypto';
import {
  hasActiveAgentGrant,
  listAgentGrantsForPrincipal,
} from '../agents/agent-grants.js';
import { getAgentById } from '../agents/agent-registry.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { tryNormalizePrincipal } from '../identity/principal.js';
import { getSessionById } from '../memory/db.js';
import { buildSessionKey, parseSessionKey } from '../session/session-key.js';
import type { Session } from '../types/session.js';

export function isUserSessionPayload(
  payload: Record<string, unknown> | null,
): boolean {
  return payload?.kind === 'user';
}

export function resolveUserSessionPrincipal(
  payload: Record<string, unknown> | null,
): string | null {
  if (!isUserSessionPayload(payload)) return null;
  return tryNormalizePrincipal(payload?.sub);
}

export function listGrantedAgentIds(principal: string): string[] {
  return listAgentGrantsForPrincipal(principal)
    .map((grant) => grant.agent_id)
    .filter((agentId) => getAgentById(agentId) !== null);
}

export function requireGrantedAgent(
  principal: string,
  agentId: string,
): string {
  const normalizedAgentId = agentId.trim();
  if (
    !normalizedAgentId ||
    !getAgentById(normalizedAgentId) ||
    !hasActiveAgentGrant(normalizedAgentId, principal)
  ) {
    throw new GatewayRequestError(
      403,
      'Agent access is not granted for this user.',
    );
  }
  return normalizedAgentId;
}

export function resolveGrantedAgentForUser(params: {
  principal: string;
  requestedAgentId?: string | null;
  session?: Session | null;
}): string {
  const requestedAgentId = params.requestedAgentId?.trim() || '';
  if (requestedAgentId) {
    return requireGrantedAgent(params.principal, requestedAgentId);
  }
  const sessionAgentId = params.session?.agent_id?.trim() || '';
  if (sessionAgentId) {
    return requireGrantedAgent(params.principal, sessionAgentId);
  }
  const firstGrantedAgentId = listGrantedAgentIds(params.principal)[0];
  if (!firstGrantedAgentId) {
    throw new GatewayRequestError(
      403,
      'No active agent grant exists for this user.',
    );
  }
  return firstGrantedAgentId;
}

export function requireOwnedUserSession(
  principal: string,
  sessionId: string,
): Session {
  const session = getSessionById(sessionId);
  const parsed = parseSessionKey(session?.session_key || '');
  const peerPrincipal = parsed ? tryNormalizePrincipal(parsed.peerId) : null;
  if (
    !session ||
    !parsed ||
    parsed.channelKind !== 'web' ||
    parsed.chatType !== 'dm' ||
    peerPrincipal !== principal ||
    parsed.agentId !== session.agent_id ||
    !hasActiveAgentGrant(session.agent_id, principal)
  ) {
    throw new GatewayRequestError(
      403,
      'Session access is not granted for this user.',
    );
  }
  return session;
}

export function requireUserSessionKey(params: {
  principal: string;
  sessionKey: string;
  agentId?: string | null;
}): string {
  const parsed = parseSessionKey(params.sessionKey);
  const peerPrincipal = parsed ? tryNormalizePrincipal(parsed.peerId) : null;
  const requestedAgentId = params.agentId?.trim() || '';
  if (
    !parsed ||
    parsed.channelKind !== 'web' ||
    parsed.chatType !== 'dm' ||
    peerPrincipal !== params.principal ||
    (requestedAgentId && requestedAgentId !== parsed.agentId)
  ) {
    throw new GatewayRequestError(403, 'Forbidden.');
  }
  return requireGrantedAgent(params.principal, parsed.agentId);
}

export function buildUserWebSessionKey(params: {
  agentId: string;
  principal: string;
  draftSessionId?: string | null;
}): string {
  const rawThreadId = params.draftSessionId?.trim() || '';
  const threadId =
    rawThreadId && rawThreadId.length <= 128
      ? rawThreadId
      : randomUUID().replace(/-/g, '');
  return buildSessionKey(params.agentId, 'web', 'dm', params.principal, {
    threadId,
  });
}

const USER_API_ROUTES = new Set([
  'GET /api/status',
  'GET /api/agents/list',
  'GET /api/history',
  'GET /api/chat/recent',
  'GET /api/chat/context',
  'GET /api/chat/commands',
  'GET /api/artifact',
  'POST /api/chat',
  'POST /api/chat/branch',
  'POST /api/chat/rating',
  'POST /api/command',
  'POST /api/media/upload',
]);

export function isUserApiRouteAllowed(
  pathname: string,
  method: string,
): boolean {
  if (pathname === '/api/agent-avatar' && method.toUpperCase() === 'GET') {
    return true;
  }
  return USER_API_ROUTES.has(`${method.toUpperCase()} ${pathname}`);
}

const USER_APPROVAL_ACTIONS = new Set([
  'view',
  'yes',
  'once',
  'session',
  'no',
  'deny',
  'skip',
  '1',
  '2',
  '5',
]);

const DURABLE_APPROVAL_DIRECTIVE_RE =
  /^(?:\/?(?:approve|yes|y))(?:\s+[a-f0-9-]{6,64})?\s+(?:for\s+)?(?:agent|all)$/i;

function hasDurableApprovalDirective(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;

  const candidates = new Set<string>([
    normalized,
    normalized.replace(/^(?:<@!?\d+>\s*)+/, ''),
  ]);
  const batchTailMatch = normalized.match(/Message\s+\d+\s*:\s*([\s\S]+)$/i);
  if (batchTailMatch?.[1]) candidates.add(batchTailMatch[1].trim());

  const lines = normalized
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1);
  if (lastLine) candidates.add(lastLine);

  return Array.from(candidates).some((candidate) => {
    const lowered = candidate.toLowerCase();
    return (
      lowered === '3' ||
      lowered === '4' ||
      DURABLE_APPROVAL_DIRECTIVE_RE.test(candidate)
    );
  });
}

export function isUserCommandAllowed(args: readonly string[]): boolean {
  const command = String(args[0] || '')
    .trim()
    .replace(/^\/+/, '')
    .toLowerCase();
  if (command === 'help') return args.length === 1;
  if (command !== 'approve') return false;
  const action = String(args[1] || 'view')
    .trim()
    .toLowerCase();
  return USER_APPROVAL_ACTIONS.has(action) && args.length <= 3;
}

export function isUserChatContentAllowed(content: string): boolean {
  const normalized = content.trim();
  if (hasDurableApprovalDirective(normalized)) return false;
  if (!normalized.startsWith('/')) {
    return true;
  }
  if (/[\r\n]/u.test(normalized)) return false;
  return isUserCommandAllowed(normalized.split(/\s+/u));
}
