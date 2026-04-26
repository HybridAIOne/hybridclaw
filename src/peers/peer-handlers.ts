/**
 * HTTP handlers for cross-instance ("hierarchical swarm") peer delegation.
 *
 * Three endpoints:
 * - GET  /.well-known/hybridclaw-peer.json — public agent card
 * - POST /api/peer/delegate                — inbound delegation (peer → us)
 * - POST /api/peer/proxy                   — outbound delegation (container → us → peer)
 *
 * The proxy endpoint is what the container's `delegate_to_peer` tool calls.
 * It re-authenticates with the gateway's normal API token, looks up the named
 * peer in our outbound config, and forwards the call. Tokens never leave the
 * gateway boundary.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { listAgents } from '../agents/agent-registry.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { appendAuditEvent, createAuditRunId } from '../audit/audit-trail.js';
import { APP_VERSION } from '../config/config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { handleGatewayMessage } from '../gateway/gateway-chat-service.js';
import { readJsonBody, sendJson } from '../gateway/gateway-http-utils.js';
import type { GatewayChatRequest } from '../gateway/gateway-types.js';
import { logger } from '../logger.js';
import { delegateToPeer } from './peer-client.js';
import {
  arePeersEnabled,
  ensureInboundAgentAllowed,
  getInboundMaxConcurrent,
  getInstanceId,
  getInstanceName,
  matchInboundToken,
} from './peer-registry.js';
import type {
  PeerAgentCard,
  PeerDelegateRequest,
  PeerDelegateResponse,
} from './peer-types.js';

let activeInboundCount = 0;

function safeAuditAppend(input: Parameters<typeof appendAuditEvent>[0]): void {
  try {
    appendAuditEvent(input);
  } catch (err) {
    logger.warn(
      { err, sessionId: input.sessionId },
      'Failed to write peer audit event',
    );
  }
}

function buildPeerSessionId(peerInstanceLabel: string, taskId: string): string {
  const safeLabel = peerInstanceLabel.replace(/[^a-zA-Z0-9_-]/g, '_') || 'peer';
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  return `peer:${safeLabel}:${safeTaskId}`;
}

export function buildPeerAgentCard(): PeerAgentCard {
  const agentSummaries = listAgents().map((agent) => ({
    id: agent.id,
    name: agent.name ?? null,
  }));
  return {
    protocol: 'hybridclaw-peer',
    protocolVersion: '1',
    instanceId: getInstanceId(),
    instanceName: getInstanceName(),
    appVersion: APP_VERSION,
    agents: agentSummaries,
    capabilities: {
      delegate: arePeersEnabled(),
      streaming: false,
    },
  };
}

export function handlePeerAgentCard(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, buildPeerAgentCard());
}

function isPeerDelegateRequestBody(
  value: unknown,
): value is PeerDelegateRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.taskId === 'string' &&
    v.taskId.length > 0 &&
    typeof v.parentInstanceId === 'string' &&
    typeof v.content === 'string' &&
    v.content.length > 0
  );
}

export async function handlePeerInboundDelegate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!arePeersEnabled()) {
    sendJson(res, 503, { error: 'Peer delegation is disabled.' });
    return;
  }

  const authHeader = String(req.headers.authorization || '').trim();
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!bearerMatch) {
    sendJson(res, 401, { error: 'Missing bearer token.' });
    return;
  }
  const inbound = matchInboundToken(bearerMatch[1].trim());
  if (!inbound) {
    sendJson(res, 401, { error: 'Unknown peer token.' });
    return;
  }

  if (activeInboundCount >= getInboundMaxConcurrent()) {
    sendJson(res, 429, {
      error: 'Peer inbound concurrency limit reached.',
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof GatewayRequestError) {
      sendJson(res, err.statusCode, { error: err.message });
      return;
    }
    throw err;
  }
  if (!isPeerDelegateRequestBody(body)) {
    sendJson(res, 400, {
      error:
        'Invalid body. Required: { taskId, parentInstanceId, content }; optional: parentRunId, parentSessionId, agentId, model, timeoutMs.',
    });
    return;
  }

  try {
    ensureInboundAgentAllowed(inbound, body.agentId);
  } catch (err) {
    sendJson(res, 403, { error: (err as Error).message });
    return;
  }

  const sessionId = buildPeerSessionId(inbound.id, body.taskId);
  const peerRunId = createAuditRunId('peer');
  const agentId = (body.agentId || '').trim() || DEFAULT_AGENT_ID;

  safeAuditAppend({
    sessionId,
    runId: peerRunId,
    parentRunId: body.parentRunId,
    event: {
      type: 'peer.delegate.received',
      taskId: body.taskId,
      parentInstanceId: body.parentInstanceId,
      parentRunId: body.parentRunId || null,
      parentSessionId: body.parentSessionId || null,
      inboundPeerId: inbound.id,
      agentId,
      model: body.model || null,
      contentLength: body.content.length,
    },
  });

  const channelId = `peer:${inbound.id}`;
  const userId = `peer:${body.parentInstanceId || inbound.id}`;
  const username = body.parentInstanceId || inbound.id;

  const chatRequest: GatewayChatRequest = {
    sessionId,
    sessionMode: 'new',
    guildId: null,
    channelId,
    userId,
    username,
    content: body.content,
    agentId,
    model: body.model ?? null,
    source: `peer:${inbound.id}`,
  };

  activeInboundCount += 1;
  let response: PeerDelegateResponse;
  try {
    const result = await handleGatewayMessage(chatRequest);
    const pendingApprovalSummary = result.pendingApproval
      ? buildPendingApprovalSummary(result.pendingApproval)
      : null;

    response = {
      taskId: body.taskId,
      peerInstanceId: getInstanceId(),
      peerRunId,
      peerSessionId: result.sessionId || sessionId,
      status: result.status,
      result: result.result ?? null,
      toolsUsed: result.toolsUsed,
      agentId: result.agentId,
      model: result.model,
      pendingApprovalSummary,
    };
    if (result.status === 'error' && result.error) {
      response.error = result.error;
    }

    safeAuditAppend({
      sessionId,
      runId: peerRunId,
      parentRunId: body.parentRunId,
      event: {
        type: 'peer.delegate.completed',
        taskId: body.taskId,
        status: result.status,
        toolsUsed: result.toolsUsed,
        pendingApproval: Boolean(pendingApprovalSummary),
        resultLength: result.result?.length || 0,
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    response = {
      taskId: body.taskId,
      peerInstanceId: getInstanceId(),
      peerRunId,
      peerSessionId: sessionId,
      status: 'error',
      result: null,
      error: errorMessage,
    };
    safeAuditAppend({
      sessionId,
      runId: peerRunId,
      parentRunId: body.parentRunId,
      event: {
        type: 'peer.delegate.failed',
        taskId: body.taskId,
        error: errorMessage,
      },
    });
    logger.error(
      { err, taskId: body.taskId, inboundPeerId: inbound.id },
      'Inbound peer delegation failed',
    );
  } finally {
    activeInboundCount = Math.max(0, activeInboundCount - 1);
  }

  sendJson(res, 200, response);
}

function buildPendingApprovalSummary(approval: {
  prompt?: string;
  toolName?: string;
}): string {
  const tool = (approval.toolName || 'tool').trim();
  const prompt = (approval.prompt || '').trim();
  return prompt ? `${tool}: ${prompt}` : `${tool} requires approval`;
}

interface PeerProxyRequestBody {
  peerId?: unknown;
  agentId?: unknown;
  content?: unknown;
  model?: unknown;
  timeoutMs?: unknown;
  parentRunId?: unknown;
  parentSessionId?: unknown;
  taskId?: unknown;
}

export async function handlePeerOutboundProxy(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!arePeersEnabled()) {
    sendJson(res, 503, { error: 'Peer delegation is disabled.' });
    return;
  }

  let body: PeerProxyRequestBody;
  try {
    body = (await readJsonBody(req)) as PeerProxyRequestBody;
  } catch (err) {
    if (err instanceof GatewayRequestError) {
      sendJson(res, err.statusCode, { error: err.message });
      return;
    }
    throw err;
  }

  const peerId = typeof body.peerId === 'string' ? body.peerId.trim() : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (!peerId || !content) {
    sendJson(res, 400, { error: 'Missing required fields: peerId, content.' });
    return;
  }
  const taskId =
    typeof body.taskId === 'string' && body.taskId.trim()
      ? body.taskId.trim()
      : randomUUID();
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const timeoutMs =
    typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)
      ? Math.max(1_000, Math.min(600_000, Math.trunc(body.timeoutMs)))
      : undefined;
  const parentRunId =
    typeof body.parentRunId === 'string' ? body.parentRunId : '';
  const parentSessionId =
    typeof body.parentSessionId === 'string' ? body.parentSessionId : '';

  const proxyRunId = createAuditRunId('peerProxy');
  const auditSessionId = parentSessionId || `peer-proxy:${peerId}`;
  safeAuditAppend({
    sessionId: auditSessionId,
    runId: proxyRunId,
    parentRunId: parentRunId || undefined,
    event: {
      type: 'peer.delegate.sent',
      taskId,
      peerId,
      agentId: agentId || null,
      model: model || null,
      contentLength: content.length,
    },
  });

  try {
    const peerResponse = await delegateToPeer({
      peerId,
      request: {
        taskId,
        parentInstanceId: getInstanceId(),
        parentRunId: parentRunId || undefined,
        parentSessionId: parentSessionId || undefined,
        agentId: agentId || undefined,
        content,
        model: model || undefined,
        timeoutMs,
      },
    });

    safeAuditAppend({
      sessionId: auditSessionId,
      runId: proxyRunId,
      parentRunId: parentRunId || undefined,
      event: {
        type: 'peer.delegate.acknowledged',
        taskId,
        peerId,
        peerInstanceId: peerResponse.peerInstanceId,
        peerRunId: peerResponse.peerRunId || null,
        status: peerResponse.status,
        resultLength: peerResponse.result?.length || 0,
      },
    });
    sendJson(res, 200, peerResponse);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    safeAuditAppend({
      sessionId: auditSessionId,
      runId: proxyRunId,
      parentRunId: parentRunId || undefined,
      event: {
        type: 'peer.delegate.send_failed',
        taskId,
        peerId,
        error: errorMessage,
      },
    });
    sendJson(res, 502, {
      error: errorMessage,
      taskId,
      peerId,
    });
  }
}
