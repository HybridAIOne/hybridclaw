/**
 * Admin edits select a future-session default or one existing session's mode.
 * Changes are explicit, audited and conditional on the last observed value.
 * Unlike approval resolution, this never answers or replays a pending action.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type ApprovalSettingsResponse,
  isApprovalMode,
} from '../../container/shared/approval-mode.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  getRuntimeConfig,
  saveRuntimeConfig,
} from '../config/runtime-config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { getAllSessions, getSessionById } from '../memory/db.js';
import { isRecord } from '../utils/type-guards.js';
import {
  resolveSessionApprovalMode,
  setSessionApprovalMode,
} from './approval-mode.js';
import type { AdminTokenAuditContext } from './gateway-admin-tokens.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';

export function getApprovalSettings(): ApprovalSettingsResponse {
  return {
    defaultMode: getRuntimeConfig().security.defaultApprovalMode,
    sessions: getAllSessions().map((session) => ({
      id: session.id,
      agentId: session.agent_id,
      channelId: session.channel_id,
      storedMode: session.approval_mode,
      effectiveMode: resolveSessionApprovalMode(session),
    })),
  };
}

export async function handleApprovalSettingsAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  audit: AdminTokenAuditContext,
): Promise<void> {
  if (req.method === 'GET') {
    sendJson(res, 200, getApprovalSettings());
    return;
  }
  if (req.method !== 'PUT') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  const body = await readJsonBody(req, 16_384);
  if (
    !isRecord(body) ||
    !isApprovalMode(body.mode) ||
    !isApprovalMode(body.expectedMode)
  ) {
    throw new GatewayRequestError(
      400,
      'Supply valid mode and expectedMode values.',
    );
  }
  if (body.target === 'default') {
    const config = getRuntimeConfig();
    const previous = config.security.defaultApprovalMode;
    if (previous !== body.expectedMode) {
      throw new GatewayRequestError(
        409,
        'Default mode changed. Reload before saving.',
      );
    }
    if (previous !== body.mode) {
      const next = structuredClone(config);
      next.security.defaultApprovalMode = body.mode;
      saveRuntimeConfig(next, {
        actor: audit.actor,
        route: 'api.admin.approval-settings',
        source: 'admin-console',
      });
      recordAuditEvent({
        sessionId: audit.sessionId || 'admin:approval-settings',
        runId: makeAuditRunId('approval-default'),
        event: {
          type: 'approval.default_changed',
          actor: audit.actor || 'admin',
          from: previous,
          to: body.mode,
        },
      });
    }
  } else if (
    body.target === 'session' &&
    typeof body.sessionId === 'string' &&
    body.sessionId.trim()
  ) {
    const session = getSessionById(body.sessionId);
    if (!session || session.id !== body.sessionId) {
      throw new GatewayRequestError(404, 'Session not found.');
    }
    if (session.approval_mode !== body.expectedMode) {
      throw new GatewayRequestError(
        409,
        'Session mode changed. Reload before saving.',
      );
    }
    setSessionApprovalMode(session, body.mode, {
      actor: audit.actor || 'admin',
      channelId: session.channel_id,
    });
  } else {
    throw new GatewayRequestError(400, 'Choose a default or session target.');
  }
  sendJson(res, 200, getApprovalSettings());
}
