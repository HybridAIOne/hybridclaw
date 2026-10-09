/**
 * Gateway callbacks from a scoped chat's worker. Agent tools call back into
 * the gateway (`/api/todo`, `/api/delegate`, …) naming the session they act
 * for, and the model can make such calls itself from a shell. A scoped
 * worker holds its scope's runtime token, so every callback it makes must
 * name a session of that scope; one that names none is accepted only on
 * routes that act on no chat's data, and the user-wide notes and memory
 * plugin tools are refused outright (fail closed).
 *
 * NOT the tool list (`scope-connectors.ts`), which decides what the model is
 * offered; this decides what the gateway does for a scope's worker.
 */
import type { IncomingMessage } from 'node:http';
import { SHELL_RUNTIME_ENV_PATH } from '../../container/shared/shell-runtime-env.js';
import { BROWSER_SIGN_IN_LOOKUP_PATH } from '../gateway/gateway-browser-sign-ins.js';
import { readJsonBody } from '../gateway/gateway-http-utils.js';
import { isDatabaseInitialized } from '../memory/database.js';
import { getSessionById } from '../memory/sessions.js';
import { NOTES_RUNTIME_PATH } from '../security/admin-rbac.js';
import { deriveScopeRuntimeToken } from '../security/agent-runtime-token.js';
import { isRecord } from '../utils/type-guards.js';
import { listAllScopeKeys } from './scope-store.js';

export interface RuntimeScope {
  agentId: string;
  scopeId: string;
}

// Runtime routes that act on no chat's data (2026-10-09): prices, the shell's
// environment, the user's style preferences (shared by design), outbound HTTP
// and secret injection, the shared browser and its sign-in lookup.
const SESSIONLESS_ROUTES: ReadonlySet<string> = new Set([
  '/api/cost-estimate',
  SHELL_RUNTIME_ENV_PATH,
  '/api/preferences',
  '/api/http/request',
  '/api/secret/inject',
  '/api/browser/tool',
  BROWSER_SIGN_IN_LOOKUP_PATH,
]);
// User-wide notes are not partitioned by scope, so a scope never reads them.
const REFUSED_ROUTES: ReadonlySet<string> = new Set([NOTES_RUNTIME_PATH]);
const SESSION_FIELDS = ['sessionId', 'parentSessionId'] as const;

/** The scope a bearer token was minted for, if it is a scope runtime token. */
export function matchScopeRuntimeToken(
  bearer: string,
  gatewayApiToken: string,
): RuntimeScope | null {
  if (!/^[0-9a-f]{64}$/.test(bearer) || !isDatabaseInitialized()) return null;
  for (const { agentId, scopeId } of listAllScopeKeys()) {
    if (deriveScopeRuntimeToken(gatewayApiToken, agentId, scopeId) === bearer) {
      return { agentId, scopeId };
    }
  }
  return null;
}

/** Why the gateway refuses this callback from a scoped worker, or null. */
export async function scopedRuntimeRequestError(params: {
  req: IncomingMessage;
  pathname: string;
  scope: RuntimeScope;
  memoryToolNames: readonly string[];
}): Promise<string | null> {
  if (REFUSED_ROUTES.has(params.pathname)) {
    return 'Not available in a scoped chat.';
  }
  const raw = await readJsonBody(params.req);
  const body = isRecord(raw) ? raw : {};
  const sessionIds = SESSION_FIELDS.map((field) => body[field]).filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  if (sessionIds.length === 0) {
    return SESSIONLESS_ROUTES.has(params.pathname)
      ? null
      : 'A scoped chat acts only for chats of its scope.';
  }
  for (const sessionId of sessionIds) {
    const session = getSessionById(sessionId);
    if (
      session?.scope !== params.scope.scopeId ||
      session.agent_id !== params.scope.agentId
    ) {
      return 'A scoped chat acts only for chats of its scope.';
    }
  }
  if (
    params.pathname === '/api/plugin/tool' &&
    params.memoryToolNames.includes(String(body.toolName ?? '').trim())
  ) {
    return 'Not available in a scoped chat.';
  }
  return null;
}
