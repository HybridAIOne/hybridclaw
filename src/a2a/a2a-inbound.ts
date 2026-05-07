import type { IncomingMessage, ServerResponse } from 'node:http';

import { getAgentById, listAgents } from '../agents/agent-registry.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { readRequestBody, sendJson } from '../gateway/gateway-http-utils.js';
import { decodeA2AJsonRpcRequest } from './a2a-json-rpc.js';
import {
  A2A_MESSAGE_SEND_SCOPE,
  A2A_TASK_SEND_SCOPE,
} from './a2a-outbox-delivery.js';
import {
  A2ADelegationTokenError,
  decodeA2ADelegationTokenClaims,
  verifyA2ADelegationToken,
} from './delegation-token.js';
import {
  type A2AEnvelope,
  A2AEnvelopeDuplicateError,
  A2AEnvelopeValidationError,
  summarizeA2AEnvelopeForAudit,
} from './envelope.js';
import { resolveA2AAgentId } from './identity.js';
import { acceptA2AInboundEnvelope } from './inbound-pipeline.js';
import {
  type A2ATrustedA2APeer,
  getA2ATrustedA2APeerBySender,
  listA2ATrustedA2APeers,
  type UpsertA2ATrustedA2APeerInput,
  upsertA2ATrustedA2APeer,
} from './trust-ledger.js';
import { isRecord } from './utils.js';

export const A2A_JSON_RPC_INBOUND_PATH = '/a2a';
export const A2A_JSON_RPC_INBOUND_MAX_BODY_BYTES = 1_000_000;

export type A2AJsonRpcInboundSignatureOutcome =
  | 'passed'
  | 'failed'
  | 'missing_peer'
  | 'revoked';
export type A2AJsonRpcInboundDownstreamDisposition =
  | 'delivered'
  | 'validation_failed'
  | 'duplicate'
  | 'rejected'
  | 'error';

export type { A2ATrustedA2APeer, UpsertA2ATrustedA2APeerInput };
export { listA2ATrustedA2APeers, upsertA2ATrustedA2APeer };

export interface A2AJsonRpcInboundResult {
  statusCode: number;
  body: Record<string, unknown>;
}

let localCanonicalRecipientCache: {
  key: string;
  canonicalAgentIds: Set<string>;
} | null = null;

function readHeader(
  headers: IncomingMessage['headers'],
  headerName: string,
): string {
  const raw = headers[headerName.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] || '';
  return raw || '';
}

function extractBearerToken(authorization: string | null | undefined): string {
  const normalized = String(authorization || '').trim();
  const match = normalized.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]?.trim()) {
    throw new A2ADelegationTokenError('Authorization bearer token is required');
  }
  return match[1].trim();
}

function normalizeAudience(url: URL): string {
  return new URL(url.pathname, url.origin).toString();
}

function localCanonicalRecipientCacheKey(): string {
  return listAgents()
    .map((agent) => `${agent.id}\0${agent.owner || ''}`)
    .join('\n');
}

function localCanonicalRecipientIds(): Set<string> {
  const key = localCanonicalRecipientCacheKey();
  if (localCanonicalRecipientCache?.key === key) {
    return localCanonicalRecipientCache.canonicalAgentIds;
  }

  const canonicalAgentIds = new Set<string>();
  for (const agent of listAgents()) {
    try {
      canonicalAgentIds.add(resolveA2AAgentId(agent.id));
    } catch {
      // Agent registry validation owns surfacing malformed local records.
    }
  }
  localCanonicalRecipientCache = { key, canonicalAgentIds };
  return canonicalAgentIds;
}

function localRecipientResolves(recipientAgentId: string): boolean {
  if (!recipientAgentId.includes('@')) {
    return Boolean(getAgentById(recipientAgentId));
  }
  return localCanonicalRecipientIds().has(recipientAgentId.toLowerCase());
}

function jsonRpcMethod(payload: unknown): 'message/send' | 'tasks/send' {
  const parsed =
    typeof payload === 'string' ? (JSON.parse(payload) as unknown) : payload;
  if (!isRecord(parsed) || parsed.jsonrpc !== '2.0') {
    throw new A2AEnvelopeValidationError([
      'A2A JSON-RPC payload must use jsonrpc "2.0"',
    ]);
  }
  if (parsed.method !== 'message/send' && parsed.method !== 'tasks/send') {
    throw new A2AEnvelopeValidationError([
      'A2A JSON-RPC method must be message/send or tasks/send',
    ]);
  }
  return parsed.method;
}

function extractErrorReason(error: unknown): string {
  if (error instanceof A2AEnvelopeValidationError) {
    return error.issues.join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

function recordInboundAudit(params: {
  runId: string;
  peerId: string | null;
  signatureOutcome: A2AJsonRpcInboundSignatureOutcome;
  intent: string | null;
  downstreamDisposition: A2AJsonRpcInboundDownstreamDisposition;
  envelope: A2AEnvelope | null;
  statusCode: number;
  reason?: string;
}): void {
  const peerId = params.peerId || 'unknown';
  recordAuditEvent({
    sessionId: `a2a:inbound:${peerId}`,
    runId: params.runId,
    event: {
      type: 'a2a.inbound_post',
      peerId,
      signatureOutcome: params.signatureOutcome,
      intent: params.intent,
      downstreamDisposition: params.downstreamDisposition,
      statusCode: params.statusCode,
      ...(params.reason ? { reason: params.reason } : {}),
      ...(params.envelope
        ? { envelope: summarizeA2AEnvelopeForAudit(params.envelope) }
        : {}),
    },
  });
}

function validateSignedRequest(params: {
  token: string;
  envelope: A2AEnvelope;
  method: 'message/send' | 'tasks/send';
  audience: string;
  now?: Date;
  peer?: A2ATrustedA2APeer;
}): A2ATrustedA2APeer {
  const unverifiedClaims = decodeA2ADelegationTokenClaims(params.token);
  const peer =
    params.peer ??
    getA2ATrustedA2APeerBySender(unverifiedClaims.sender_agent_id);
  if (!peer) {
    throw new A2ADelegationTokenError('No trusted A2A peer for token sender');
  }
  verifyA2ADelegationToken({
    token: params.token,
    publicKeyPem: peer.publicKeyPem,
    audience: params.audience,
    requiredScope:
      params.method === 'tasks/send'
        ? A2A_TASK_SEND_SCOPE
        : A2A_MESSAGE_SEND_SCOPE,
    senderAgentId: params.envelope.sender_agent_id,
    targetAgentId: params.envelope.recipient_agent_id,
    now: params.now,
  });
  return peer;
}

export function acceptA2AJsonRpcInboundRequest(params: {
  rawBody: string;
  authorization: string | null | undefined;
  audience: string;
  now?: Date;
  peer?: A2ATrustedA2APeer;
}): A2AJsonRpcInboundResult {
  const runId = makeAuditRunId('a2a-inbound');
  let envelope: A2AEnvelope | null = null;
  let peer: A2ATrustedA2APeer | null = params.peer ?? null;

  try {
    const method = jsonRpcMethod(params.rawBody);
    envelope = decodeA2AJsonRpcRequest(params.rawBody);
    if (!localRecipientResolves(envelope.recipient_agent_id)) {
      throw new A2AEnvelopeValidationError([
        'recipient_agent_id does not resolve to a local agent',
      ]);
    }
    const token = extractBearerToken(params.authorization);
    peer = validateSignedRequest({
      token,
      envelope,
      method,
      audience: params.audience,
      now: params.now,
      peer: params.peer,
    });
  } catch (error) {
    const reason = extractErrorReason(error);
    recordInboundAudit({
      runId,
      peerId: peer?.peerId || null,
      signatureOutcome: reason.includes('revoked')
        ? 'revoked'
        : error instanceof A2ADelegationTokenError
          ? 'failed'
          : 'failed',
      intent: envelope?.intent || null,
      downstreamDisposition:
        error instanceof A2ADelegationTokenError
          ? 'rejected'
          : 'validation_failed',
      envelope,
      statusCode: error instanceof A2ADelegationTokenError ? 401 : 400,
      reason,
    });
    return {
      statusCode: error instanceof A2ADelegationTokenError ? 401 : 400,
      body: {
        error:
          error instanceof A2ADelegationTokenError ? 'Unauthorized' : reason,
      },
    };
  }

  try {
    const confirmation = acceptA2AInboundEnvelope(envelope, {
      source: 'a2a',
      actor: peer.peerId,
      sessionId: `a2a:inbound:${peer.peerId}`,
      auditRunId: runId,
    });
    recordInboundAudit({
      runId,
      peerId: peer.peerId,
      signatureOutcome: 'passed',
      intent: envelope.intent,
      downstreamDisposition: 'delivered',
      envelope,
      statusCode: 202,
    });
    return {
      statusCode: 202,
      body: { ...confirmation },
    };
  } catch (error) {
    const isDuplicate = error instanceof A2AEnvelopeDuplicateError;
    const reason = extractErrorReason(error);
    recordInboundAudit({
      runId,
      peerId: peer.peerId,
      signatureOutcome: 'passed',
      intent: envelope.intent,
      downstreamDisposition: isDuplicate ? 'duplicate' : 'error',
      envelope,
      statusCode: isDuplicate ? 409 : 500,
      reason,
    });
    return {
      statusCode: isDuplicate ? 409 : 500,
      body: { error: reason },
    };
  }
}

export async function handleA2AJsonRpcInbound(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (url.pathname !== A2A_JSON_RPC_INBOUND_PATH) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  try {
    const rawBody = (
      await readRequestBody(req, A2A_JSON_RPC_INBOUND_MAX_BODY_BYTES)
    ).toString('utf-8');
    const result = acceptA2AJsonRpcInboundRequest({
      rawBody,
      authorization: readHeader(req.headers, 'authorization'),
      audience: normalizeAudience(url),
    });
    sendJson(res, result.statusCode, result.body);
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: 'Internal server error' });
  }
}
