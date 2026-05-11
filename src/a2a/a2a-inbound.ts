import { X509Certificate } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { getAgentById, listAgents } from '../agents/agent-registry.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { readRequestBody, sendJson } from '../gateway/gateway-http-utils.js';
import { decodeA2AJsonRpcRequest, type JsonRpcId } from './a2a-json-rpc.js';
import {
  A2A_AGENT_CARD_READ_SCOPE,
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
export type A2AAgentCardPeerTrustLevel = 'public' | 'trusted';
type A2AInboundAuthMode = 'signed_bearer' | 'peer_public_key';

export type { A2ATrustedA2APeer, UpsertA2ATrustedA2APeerInput };
export { listA2ATrustedA2APeers, upsertA2ATrustedA2APeer };

export interface A2AJsonRpcInboundResult {
  statusCode: number;
  body: Record<string, unknown>;
}

export interface A2AAgentCardPeerTrustResult {
  trustLevel: A2AAgentCardPeerTrustLevel;
  peerId?: string;
}

class A2AMissingTrustedPeerError extends A2ADelegationTokenError {
  constructor(message = 'No trusted A2A peer for token sender') {
    super(message);
    this.name = 'A2AMissingTrustedPeerError';
  }
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

function normalizePemText(value: string): string {
  return value.trim().replace(/\r\n/g, '\n');
}

function publicKeysMatch(leftPem: string, rightPem: string): boolean {
  return normalizePemText(leftPem) === normalizePemText(rightPem);
}

export function extractA2AMtlsPublicKeyPem(
  req: IncomingMessage,
): string | null {
  const socket = req.socket as {
    authorized?: boolean;
    getPeerCertificate?: (detailed?: boolean) => { raw?: Buffer } | null;
  };
  if (
    socket.authorized !== true ||
    typeof socket.getPeerCertificate !== 'function'
  ) {
    return null;
  }
  const certificate = socket.getPeerCertificate(true);
  if (!certificate?.raw || certificate.raw.length === 0) {
    return null;
  }
  try {
    return new X509Certificate(certificate.raw).publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
  } catch {
    return null;
  }
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

function parseJsonRpcPayload(rawBody: string): unknown {
  return JSON.parse(rawBody) as unknown;
}

function jsonRpcRequestMeta(parsed: unknown): {
  method: 'message/send' | 'tasks/send';
  id: JsonRpcId;
} {
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
  const id =
    typeof parsed.id === 'string' ||
    typeof parsed.id === 'number' ||
    parsed.id === null
      ? parsed.id
      : null;
  return { method: parsed.method, id };
}

function extractErrorReason(error: unknown): string {
  if (error instanceof A2AEnvelopeValidationError) {
    return error.issues.join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

function peerInstanceIdFromEnvelope(
  envelope: A2AEnvelope | null,
): string | null {
  const parts = envelope?.sender_agent_id.split('@') ?? [];
  return parts.length === 3 && parts[2] ? parts[2] : null;
}

function recordInboundAudit(params: {
  runId: string;
  peerId: string | null;
  peerInstanceId: string | null;
  authMode: A2AInboundAuthMode | null;
  method: 'message/send' | 'tasks/send' | null;
  agentId: string | null;
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
      peerInstanceId: params.peerInstanceId,
      authMode: params.authMode,
      method: params.method,
      agentId: params.agentId,
      signatureOutcome: params.signatureOutcome,
      intent: params.intent,
      outcome: params.downstreamDisposition,
      downstreamDisposition: params.downstreamDisposition,
      statusCode: params.statusCode,
      ...(params.reason ? { reason: params.reason } : {}),
      ...(params.envelope
        ? { envelope: summarizeA2AEnvelopeForAudit(params.envelope) }
        : {}),
    },
  });
}

function jsonRpcErrorBody(params: {
  id: JsonRpcId;
  code: number;
  message: string;
  reason?: string;
}): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    error: {
      code: params.code,
      message: params.message,
      ...(params.reason ? { data: { reason: params.reason } } : {}),
    },
    id: params.id,
  };
}

function jsonRpcErrorCode(error: unknown): number {
  if (error instanceof A2ADelegationTokenError) return -32001;
  if (error instanceof A2AEnvelopeDuplicateError) return -32009;
  if (error instanceof A2AEnvelopeValidationError) return -32602;
  return -32603;
}

function jsonRpcErrorMessage(error: unknown): string {
  if (error instanceof A2ADelegationTokenError) return 'Unauthorized';
  if (error instanceof A2AEnvelopeDuplicateError) return 'Duplicate envelope';
  if (error instanceof A2AEnvelopeValidationError) return 'Invalid params';
  return 'Internal error';
}

function resolveTrustedPeerForToken(params: {
  token: string;
  peer?: A2ATrustedA2APeer;
}): A2ATrustedA2APeer {
  const unverifiedClaims = decodeA2ADelegationTokenClaims(params.token);
  const peer =
    params.peer ??
    getA2ATrustedA2APeerBySender(unverifiedClaims.sender_agent_id);
  if (!peer) {
    throw new A2AMissingTrustedPeerError();
  }
  return peer;
}

function resolveTrustedPeerForMtls(params: {
  senderAgentId: string;
  mtlsPublicKeyPem: string;
  peer?: A2ATrustedA2APeer;
}): A2ATrustedA2APeer {
  const peer =
    params.peer ?? getA2ATrustedA2APeerBySender(params.senderAgentId);
  if (!peer) {
    throw new A2AMissingTrustedPeerError('No trusted A2A peer for mTLS sender');
  }
  if (!publicKeysMatch(params.mtlsPublicKeyPem, peer.publicKeyPem)) {
    throw new A2ADelegationTokenError(
      'mTLS certificate public key does not match trusted A2A peer',
    );
  }
  return peer;
}

function resolveTrustedPeerForMtlsPublicKey(
  mtlsPublicKeyPem: string,
): A2ATrustedA2APeer | null {
  return (
    listA2ATrustedA2APeers().find((peer) =>
      publicKeysMatch(mtlsPublicKeyPem, peer.publicKeyPem),
    ) ?? null
  );
}

function verifySignedRequest(params: {
  token: string;
  envelope: A2AEnvelope;
  method: 'message/send' | 'tasks/send';
  audience: string;
  now?: Date;
  peer: A2ATrustedA2APeer;
}): void {
  verifyA2ADelegationToken({
    token: params.token,
    publicKeyPem: params.peer.publicKeyPem,
    audience: params.audience,
    requiredScope:
      params.method === 'tasks/send'
        ? A2A_TASK_SEND_SCOPE
        : A2A_MESSAGE_SEND_SCOPE,
    senderAgentId: params.envelope.sender_agent_id,
    targetAgentId: params.envelope.recipient_agent_id,
    now: params.now,
  });
}

function signatureOutcomeForError(
  error: unknown,
): A2AJsonRpcInboundSignatureOutcome {
  if (error instanceof A2AMissingTrustedPeerError) return 'missing_peer';
  if (
    error instanceof A2ADelegationTokenError &&
    error.message.includes('revoked')
  ) {
    return 'revoked';
  }
  return 'failed';
}

export function acceptA2AJsonRpcInboundRequest(params: {
  rawBody: string;
  authorization: string | null | undefined;
  audience: string;
  mtlsPublicKeyPem?: string | null;
  now?: Date;
  peer?: A2ATrustedA2APeer;
}): A2AJsonRpcInboundResult {
  const runId = makeAuditRunId('a2a-inbound');
  let envelope: A2AEnvelope | null = null;
  let peer: A2ATrustedA2APeer | null = params.peer ?? null;
  let method: 'message/send' | 'tasks/send' | null = null;
  let requestId: JsonRpcId = null;
  let authMode: A2AInboundAuthMode | null = null;

  try {
    const parsed = parseJsonRpcPayload(params.rawBody);
    const meta = jsonRpcRequestMeta(parsed);
    method = meta.method;
    requestId = meta.id;
    envelope = decodeA2AJsonRpcRequest(parsed);
    if (!localRecipientResolves(envelope.recipient_agent_id)) {
      throw new A2AEnvelopeValidationError([
        'recipient_agent_id does not resolve to a local agent',
      ]);
    }
    const authorization = String(params.authorization || '').trim();
    if (authorization) {
      authMode = 'signed_bearer';
      const token = extractBearerToken(params.authorization);
      peer = resolveTrustedPeerForToken({
        token,
        peer: params.peer,
      });
      verifySignedRequest({
        token,
        envelope,
        method,
        audience: params.audience,
        now: params.now,
        peer,
      });
    } else if (params.mtlsPublicKeyPem) {
      authMode = 'peer_public_key';
      peer =
        params.peer ?? getA2ATrustedA2APeerBySender(envelope.sender_agent_id);
      peer = resolveTrustedPeerForMtls({
        senderAgentId: envelope.sender_agent_id,
        mtlsPublicKeyPem: params.mtlsPublicKeyPem,
        peer: peer ?? undefined,
      });
    } else {
      throw new A2ADelegationTokenError(
        'Authorization bearer token or mTLS client certificate is required',
      );
    }
  } catch (error) {
    const reason = extractErrorReason(error);
    const statusCode = error instanceof A2ADelegationTokenError ? 401 : 400;
    recordInboundAudit({
      runId,
      peerId: peer?.peerId || null,
      peerInstanceId: peerInstanceIdFromEnvelope(envelope),
      authMode,
      method,
      agentId: envelope?.recipient_agent_id || null,
      signatureOutcome: signatureOutcomeForError(error),
      intent: envelope?.intent || null,
      downstreamDisposition:
        error instanceof A2ADelegationTokenError
          ? 'rejected'
          : 'validation_failed',
      envelope,
      statusCode,
      reason,
    });
    return {
      statusCode,
      body: jsonRpcErrorBody({
        id: requestId,
        code: jsonRpcErrorCode(error),
        message: jsonRpcErrorMessage(error),
        reason,
      }),
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
      peerInstanceId: peerInstanceIdFromEnvelope(envelope),
      authMode,
      method,
      agentId: envelope.recipient_agent_id,
      signatureOutcome: 'passed',
      intent: envelope.intent,
      downstreamDisposition: 'delivered',
      envelope,
      statusCode: 202,
    });
    return {
      statusCode: 202,
      body: {
        jsonrpc: '2.0',
        result: { ...confirmation },
        id: requestId,
      },
    };
  } catch (error) {
    const isDuplicate = error instanceof A2AEnvelopeDuplicateError;
    const reason = extractErrorReason(error);
    recordInboundAudit({
      runId,
      peerId: peer.peerId,
      peerInstanceId: peerInstanceIdFromEnvelope(envelope),
      authMode,
      method,
      agentId: envelope.recipient_agent_id,
      signatureOutcome: 'passed',
      intent: envelope.intent,
      downstreamDisposition: isDuplicate ? 'duplicate' : 'error',
      envelope,
      statusCode: isDuplicate ? 409 : 500,
      reason,
    });
    return {
      statusCode: isDuplicate ? 409 : 500,
      body: jsonRpcErrorBody({
        id: requestId,
        code: jsonRpcErrorCode(error),
        message: jsonRpcErrorMessage(error),
        reason,
      }),
    };
  }
}

export function resolveA2AAgentCardPeerTrust(params: {
  authorization: string | null | undefined;
  audience: string;
  mtlsPublicKeyPem?: string | null;
  now?: Date;
}): A2AAgentCardPeerTrustResult {
  if (String(params.authorization || '').trim()) {
    try {
      const token = extractBearerToken(params.authorization);
      const peer = resolveTrustedPeerForToken({ token });
      verifyA2ADelegationToken({
        token,
        publicKeyPem: peer.publicKeyPem,
        audience: params.audience,
        requiredScope: A2A_AGENT_CARD_READ_SCOPE,
        now: params.now,
      });
      return { trustLevel: 'trusted', peerId: peer.peerId };
    } catch {
      return { trustLevel: 'public' };
    }
  }
  if (params.mtlsPublicKeyPem) {
    const peer = resolveTrustedPeerForMtlsPublicKey(params.mtlsPublicKeyPem);
    if (peer) return { trustLevel: 'trusted', peerId: peer.peerId };
  }
  return { trustLevel: 'public' };
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
      mtlsPublicKeyPem: extractA2AMtlsPublicKeyPem(req),
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
