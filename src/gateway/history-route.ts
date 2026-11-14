/**
 * Authenticated history transport pages only the requested session's stored rows.
 * The HTTP server owns access checks; cursors are bounds, never authorization.
 * Unlike chat execution, fetching older history does not start a new turn.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getAgentById } from '../agents/agent-registry.js';
import { logger } from '../logger.js';
import { withWorkHistory } from '../work/work-routes.js';
import { pendingChatApproval } from './chat-approval-review.js';
import { parsePositiveInteger, sendJson } from './gateway-http-utils.js';
import {
  ensureGatewayBootstrapAutostart,
  getGatewayBootstrapAutostartState,
  getGatewayHistory,
  getGatewayHistorySummary,
} from './gateway-service.js';

interface HistoryRouteContext {
  isMalformedCanonicalSessionId: (sessionId: string) => boolean;
  resolveGatewayRequestUserId: (params: {
    req: IncomingMessage;
    channelId?: string | null;
    requestedUserId?: string | null;
    fallbackUserId?: string | null;
  }) => string | undefined;
}

const HISTORY_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function handleApiHistory(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: HistoryRouteContext,
): Promise<void> {
  const sessionId = url.searchParams.get('sessionId')?.trim();
  if (!sessionId) {
    sendJson(res, 400, { error: 'Missing `sessionId` query parameter.' });
    return;
  }
  if (context.isMalformedCanonicalSessionId(sessionId)) {
    sendJson(res, 400, { error: 'Malformed canonical `sessionId`.' });
    return;
  }
  const rawCursor = url.searchParams.get('before');
  const beforeMessageId =
    rawCursor === null ? undefined : parsePositiveInteger(rawCursor);
  if (beforeMessageId === null) {
    sendJson(res, 400, {
      error: '`before` must be a positive safe integer message ID.',
    });
    return;
  }
  const parsedLimit = parseInt(url.searchParams.get('limit') || '40', 10);
  const parsedSummarySinceMs = parseInt(
    url.searchParams.get('summarySinceMs') || '',
    10,
  );
  const limit = Number.isNaN(parsedLimit) ? 40 : parsedLimit;
  const rawAgentId = url.searchParams.get('agentId')?.trim() || '';
  if (rawAgentId && !HISTORY_AGENT_ID_PATTERN.test(rawAgentId)) {
    sendJson(res, 400, { error: 'Invalid `agentId` query parameter.' });
    return;
  }
  const requestedAgentId = rawAgentId || undefined;
  if (requestedAgentId && !getAgentById(requestedAgentId)) {
    sendJson(res, 404, { error: 'Agent not found.' });
    return;
  }
  const operatorUserId = context.resolveGatewayRequestUserId({
    req,
    channelId: 'web',
    requestedUserId: url.searchParams.get('userId'),
    fallbackUserId: 'web',
  });
  if (beforeMessageId === undefined) {
    void ensureGatewayBootstrapAutostart({
      sessionId,
      channelId: 'web',
      userId: operatorUserId,
      username: operatorUserId,
      agentId: requestedAgentId,
    }).catch((error) => {
      logger.warn(
        { sessionId, agentId: requestedAgentId ?? null, error },
        'Failed to start gateway bootstrap autostart',
      );
    });
  }
  const historyPage = getGatewayHistory(sessionId, limit, {
    operatorUserId,
    ...(beforeMessageId !== undefined ? { beforeMessageId } : {}),
  });
  const summary = getGatewayHistorySummary(sessionId, {
    sinceMs: Number.isNaN(parsedSummarySinceMs) ? null : parsedSummarySinceMs,
  });
  const bootstrapAutostart = getGatewayBootstrapAutostartState({
    sessionId,
    channelId: 'web',
    agentId: requestedAgentId,
    allowExistingSessionMessages: true,
  });
  const pendingApproval = pendingChatApproval(
    historyPage.sessionId,
    operatorUserId ?? '',
  );
  // These keys are returned only as chat-routing metadata for the web client.
  // Auth stays anchored to the existing API/session auth checks above, never to
  // sessionKey/mainSessionKey. If these fields ever become auth-sensitive,
  // remove them from this response instead of widening their meaning here.
  sendJson(res, 200, {
    sessionId: historyPage.sessionId,
    agentId: historyPage.agentId || undefined,
    sessionKey: historyPage.sessionKey || undefined,
    mainSessionKey: historyPage.mainSessionKey || undefined,
    history: withWorkHistory(historyPage.sessionId, historyPage.history),
    nextCursor: historyPage.nextCursor ?? null,
    ...(pendingApproval ? { pendingApproval } : {}),
    bootstrapAutostart,
    ...(historyPage.branchFamilies.length > 0
      ? { branchFamilies: historyPage.branchFamilies }
      : {}),
    summary,
  });
}
