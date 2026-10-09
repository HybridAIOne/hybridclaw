/**
 * `/api/scopes`: the user's scopes of one agent. Authorized like `/api/chat`
 * (`chat.send`, phone owner tokens included); the agent runtime's own token
 * lacks it, so a model can suggest a scope but never create or change one.
 *
 * DELETE erases the scope's workspace. Sessions keep their scope id, and
 * their next run fails with `scope_deleted` (`scope-session.ts`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { findAgentConfig, getAgentById } from '../agents/agent-registry.js';
import { readJsonBody, sendJson } from '../gateway/gateway-http-utils.js';
import { isRecord } from '../utils/type-guards.js';
import {
  createScope,
  deleteScopeRow,
  listScopes,
  ScopeError,
  updateScope,
} from './scope-store.js';
import { eraseScopeWorkspace } from './scope-workspace.js';

export const SCOPES_PATH = '/api/scopes';

const STATUS_BY_CODE: Record<ScopeError['code'], number> = {
  invalid_scope: 400,
  scope_exists: 409,
  scope_not_found: 404,
  too_many_scopes: 409,
};

function knownAgentId(value: unknown): string | null {
  const agentId = typeof value === 'string' ? value.trim() : '';
  if (!agentId) return null;
  return getAgentById(agentId) || findAgentConfig(agentId) ? agentId : null;
}

function sendScopeError(res: ServerResponse, error: unknown): void {
  if (error instanceof ScopeError) {
    sendJson(res, STATUS_BY_CODE[error.code], {
      error: error.message,
      errorCode: error.code,
    });
    return;
  }
  throw error;
}

export function isScopesPath(pathname: string): boolean {
  return pathname === SCOPES_PATH || pathname.startsWith(`${SCOPES_PATH}/`);
}

export async function handleScopesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const method = (req.method || 'GET').toUpperCase();
  const rest = url.pathname.slice(SCOPES_PATH.length).replace(/^\/+/, '');
  const scopeId = rest ? decodeURIComponent(rest) : '';
  if (scopeId.includes('/')) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }
  const body =
    method === 'POST' || method === 'PATCH' ? await readJsonBody(req) : {};
  const record = isRecord(body) ? body : {};
  const agentId = knownAgentId(
    method === 'GET' || method === 'DELETE'
      ? url.searchParams.get('agentId')
      : record.agentId,
  );
  if (!agentId) {
    sendJson(res, 400, {
      error: 'Expected the `agentId` of a known agent.',
      errorCode: 'unknown_agent',
    });
    return;
  }
  try {
    if (!scopeId && method === 'GET') {
      sendJson(res, 200, { scopes: listScopes(agentId) });
      return;
    }
    if (!scopeId && method === 'POST') {
      sendJson(
        res,
        201,
        createScope({
          agentId,
          name: record.name,
          connectors: record.connectors ?? [],
        }),
      );
      return;
    }
    if (scopeId && method === 'PATCH') {
      sendJson(
        res,
        200,
        updateScope({
          agentId,
          scopeId,
          name: record.name,
          connectors: record.connectors,
        }),
      );
      return;
    }
    if (scopeId && method === 'DELETE') {
      if (!deleteScopeRow(agentId, scopeId)) {
        throw new ScopeError('scope_not_found', 'No such scope.');
      }
      eraseScopeWorkspace(agentId, scopeId);
      sendJson(res, 200, { deleted: true });
      return;
    }
  } catch (error) {
    sendScopeError(res, error);
    return;
  }
  sendJson(res, 405, { error: 'Method Not Allowed' });
}
