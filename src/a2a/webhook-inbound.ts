import type { IncomingMessage, ServerResponse } from 'node:http';

import { getAgentById, listAgents } from '../agents/agent-registry.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { readRequestBody, sendJson } from '../gateway/gateway-http-utils.js';
import { resolveSecretInputUnsafe } from '../security/secret-refs.js';
import {
  type A2AEnvelope,
  A2AEnvelopeDuplicateError,
  A2AEnvelopeValidationError,
  summarizeA2AEnvelopeForAudit,
  validateA2AEnvelope,
} from './envelope.js';
import { resolveA2AAgentId } from './identity.js';
import { acceptA2AInboundEnvelope } from './inbound-pipeline.js';
import {
  A2A_TRUST_LEDGER_DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE,
  type A2ATrustedWebhookPeer as A2AWebhookInboundPeer,
  getA2ATrustedWebhookPeer as getA2AWebhookInboundPeer,
  listA2ATrustedWebhookPeers as listA2AWebhookInboundPeers,
  normalizeA2APeerId,
  type UpsertA2ATrustedWebhookPeerInput as UpsertA2AWebhookInboundPeerInput,
  upsertA2ATrustedWebhookPeer as upsertA2AWebhookInboundPeer,
} from './trust-ledger.js';
import { verifyWebhookSignature } from './webhook-outbound.js';

export const A2A_WEBHOOK_INBOUND_PATH_PREFIX = '/a2a/webhook/';
export const A2A_WEBHOOK_INBOUND_MAX_BODY_BYTES = 1_000_000;
export const A2A_WEBHOOK_INBOUND_DEFAULT_RATE_LIMIT_PER_MINUTE =
  A2A_TRUST_LEDGER_DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE;

export type A2AWebhookInboundSignatureOutcome =
  | 'passed'
  | 'failed'
  | 'missing_peer'
  | 'rate_limited';
export type A2AWebhookInboundDownstreamDisposition =
  | 'delivered'
  | 'validation_failed'
  | 'duplicate'
  | 'rejected'
  | 'rate_limited'
  | 'error';

export type { A2AWebhookInboundPeer, UpsertA2AWebhookInboundPeerInput };
export {
  getA2AWebhookInboundPeer,
  listA2AWebhookInboundPeers,
  upsertA2AWebhookInboundPeer,
};

export interface A2AWebhookInboundResult {
  statusCode: number;
  body: Record<string, unknown>;
}

interface RateLimitBucket {
  windowStartedAtMs: number;
  count: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();
let localCanonicalRecipientCache: {
  key: string;
  canonicalAgentIds: Set<string>;
} | null = null;

export function resetA2AWebhookInboundRateLimitsForTests(): void {
  rateLimitBuckets.clear();
}

export function parseA2AWebhookInboundPath(pathname: string): string | null {
  if (!pathname.startsWith(A2A_WEBHOOK_INBOUND_PATH_PREFIX)) return null;
  const suffix = pathname.slice(A2A_WEBHOOK_INBOUND_PATH_PREFIX.length);
  if (!suffix || suffix.includes('/')) return null;
  try {
    return normalizeA2APeerId(decodeURIComponent(suffix));
  } catch {
    return null;
  }
}

function readHeader(
  headers: IncomingMessage['headers'],
  headerName: string,
): string {
  const raw = headers[headerName.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] || '';
  return raw || '';
}

function shouldRateLimit(peer: A2AWebhookInboundPeer, nowMs: number): boolean {
  const limit = peer.rateLimitPerMinute;
  const bucket = rateLimitBuckets.get(peer.peerId);
  if (!bucket || nowMs - bucket.windowStartedAtMs >= 60_000) {
    rateLimitBuckets.set(peer.peerId, {
      windowStartedAtMs: nowMs,
      count: 1,
    });
    return false;
  }
  if (bucket.count >= limit) return true;
  bucket.count += 1;
  return false;
}

function decodeWebhookEnvelope(
  rawBody: string,
  peer: A2AWebhookInboundPeer,
): A2AEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch (error) {
    throw new A2AEnvelopeValidationError([
      error instanceof Error ? error.message : 'invalid JSON',
    ]);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new A2AEnvelopeValidationError(['envelope must be an object']);
  }
  const record = parsed as Record<string, unknown>;
  const version = record.version;
  if (version !== undefined && version !== peer.version) {
    throw new A2AEnvelopeValidationError([
      `version must be ${peer.version} when provided`,
    ]);
  }
  const { version: _version, ...envelope } = record;
  return validateA2AEnvelope(envelope);
}

function auditSecretEscape(params: {
  peer: A2AWebhookInboundPeer;
  sessionId: string;
  runId: string;
  reason: string;
}): void {
  recordAuditEvent({
    sessionId: params.sessionId,
    runId: params.runId,
    event: {
      type: 'secret.unsafe_escape',
      skill: 'a2a.webhook-inbound',
      secretRef: params.peer.secretRef,
      sinkKind: 'hmac',
      host: params.peer.peerId,
      selector: null,
      reason: params.reason,
    },
  });
}

function resolveInboundSecret(params: {
  peer: A2AWebhookInboundPeer;
  sessionId: string;
  runId: string;
}): string {
  const secret = resolveSecretInputUnsafe(params.peer.secretRef, {
    path: 'a2a.webhook.inbound.secretRef',
    required: true,
    reason: 'verify inbound webhook envelope',
    audit: (_handle, reason) =>
      auditSecretEscape({
        peer: params.peer,
        sessionId: params.sessionId,
        runId: params.runId,
        reason,
      }),
  });
  if (!secret) {
    throw new Error(
      `a2a.webhook.inbound.secretRef resolved to an empty secret for ${params.peer.secretRef.source}:${params.peer.secretRef.id}`,
    );
  }
  return secret;
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
      // Ignore malformed local agent records here; agent registry validation
      // owns surfacing those errors on config mutation.
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

function extractErrorReason(error: unknown): string {
  if (error instanceof A2AEnvelopeValidationError) {
    return error.issues.join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

function validateWebhookEnvelopeForPeer(
  rawBody: string,
  peer: A2AWebhookInboundPeer,
):
  | { ok: true; envelope: A2AEnvelope }
  | { ok: false; reason: string; envelope: A2AEnvelope | null } {
  let envelope: A2AEnvelope | null = null;
  try {
    envelope = decodeWebhookEnvelope(rawBody, peer);
    if (envelope.sender_agent_id !== peer.senderAgentId) {
      throw new A2AEnvelopeValidationError([
        'sender_agent_id does not match webhook peer',
      ]);
    }
    if (!localRecipientResolves(envelope.recipient_agent_id)) {
      throw new A2AEnvelopeValidationError([
        'recipient_agent_id does not resolve to a local agent',
      ]);
    }
    return { ok: true, envelope };
  } catch (error) {
    return {
      ok: false,
      reason: extractErrorReason(error),
      envelope,
    };
  }
}

function recordInboundAudit(params: {
  peerId: string;
  runId: string;
  signatureOutcome: A2AWebhookInboundSignatureOutcome;
  intent: string | null;
  downstreamDisposition: A2AWebhookInboundDownstreamDisposition;
  envelope: A2AEnvelope | null;
  statusCode: number;
  reason?: string;
}): void {
  recordAuditEvent({
    sessionId: `a2a:webhook-inbound:${params.peerId}`,
    runId: params.runId,
    event: {
      type: 'a2a.webhook.inbound_post',
      peerId: params.peerId,
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

export function recordA2AWebhookInboundPreflightAudit(params: {
  peerId: string;
  signatureOutcome: A2AWebhookInboundSignatureOutcome;
  downstreamDisposition: A2AWebhookInboundDownstreamDisposition;
  statusCode: number;
  reason: string;
}): void {
  recordInboundAudit({
    peerId: params.peerId,
    runId: makeAuditRunId('a2a-webhook-inbound'),
    signatureOutcome: params.signatureOutcome,
    intent: null,
    downstreamDisposition: params.downstreamDisposition,
    envelope: null,
    statusCode: params.statusCode,
    reason: params.reason,
  });
}

export function acceptA2AWebhookInboundEnvelope(params: {
  peerId: string;
  rawBody: string;
  signatureHeader: string | null | undefined;
  peer?: A2AWebhookInboundPeer;
  nowMs?: number;
}): A2AWebhookInboundResult {
  const peerId = normalizeA2APeerId(params.peerId);
  const runId = makeAuditRunId('a2a-webhook-inbound');
  const sessionId = `a2a:webhook-inbound:${peerId}`;
  const nowMs = params.nowMs ?? Date.now();
  const peer = params.peer ?? getA2AWebhookInboundPeer(peerId);
  if (!peer) {
    recordInboundAudit({
      peerId,
      runId,
      signatureOutcome: 'missing_peer',
      intent: null,
      downstreamDisposition: 'rejected',
      envelope: null,
      statusCode: 401,
      reason: 'unknown webhook peer',
    });
    return { statusCode: 401, body: { error: 'Unauthorized' } };
  }

  let secret: string;
  try {
    secret = resolveInboundSecret({ peer, sessionId, runId });
  } catch (error) {
    recordInboundAudit({
      peerId,
      runId,
      signatureOutcome: 'failed',
      intent: null,
      downstreamDisposition: 'rejected',
      envelope: null,
      statusCode: 401,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { statusCode: 401, body: { error: 'Unauthorized' } };
  }

  const signatureOk = verifyWebhookSignature({
    header: params.signatureHeader,
    body: params.rawBody,
    secret,
    nowMs,
    replayWindowMs: peer.replayWindowMs,
  });
  if (!signatureOk) {
    recordInboundAudit({
      peerId,
      runId,
      signatureOutcome: 'failed',
      intent: null,
      downstreamDisposition: 'rejected',
      envelope: null,
      statusCode: 401,
      reason: 'invalid webhook signature',
    });
    return { statusCode: 401, body: { error: 'Unauthorized' } };
  }

  if (shouldRateLimit(peer, nowMs)) {
    recordInboundAudit({
      peerId,
      runId,
      signatureOutcome: 'rate_limited',
      intent: null,
      downstreamDisposition: 'rate_limited',
      envelope: null,
      statusCode: 429,
      reason: 'webhook peer rate limit exceeded',
    });
    return { statusCode: 429, body: { error: 'Rate limit exceeded' } };
  }

  const validation = validateWebhookEnvelopeForPeer(params.rawBody, peer);
  if (!validation.ok) {
    recordInboundAudit({
      peerId,
      runId,
      signatureOutcome: 'passed',
      intent: validation.envelope?.intent || null,
      downstreamDisposition: 'validation_failed',
      envelope: validation.envelope,
      statusCode: 400,
      reason: validation.reason,
    });
    return { statusCode: 400, body: { error: validation.reason } };
  }

  const { envelope } = validation;
  try {
    const confirmation = acceptA2AInboundEnvelope(envelope, {
      source: 'webhook',
      actor: peerId,
      sessionId,
      auditRunId: runId,
    });
    recordInboundAudit({
      peerId,
      runId,
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
      peerId,
      runId,
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

export async function handleA2AWebhookInbound(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const peerId = parseA2AWebhookInboundPath(url.pathname);
  if (!peerId) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  try {
    const peer = getA2AWebhookInboundPeer(peerId);
    if (!peer) {
      recordA2AWebhookInboundPreflightAudit({
        peerId,
        signatureOutcome: 'missing_peer',
        downstreamDisposition: 'rejected',
        statusCode: 401,
        reason: 'unknown webhook peer',
      });
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const rawBody = (
      await readRequestBody(req, A2A_WEBHOOK_INBOUND_MAX_BODY_BYTES)
    ).toString('utf-8');
    const result = acceptA2AWebhookInboundEnvelope({
      peerId,
      rawBody,
      signatureHeader: readHeader(req.headers, peer.signatureHeader),
      peer,
    });
    sendJson(res, result.statusCode, result.body);
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      recordA2AWebhookInboundPreflightAudit({
        peerId,
        signatureOutcome: 'failed',
        downstreamDisposition: 'rejected',
        statusCode: error.statusCode,
        reason: error.message,
      });
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    recordA2AWebhookInboundPreflightAudit({
      peerId,
      signatureOutcome: 'failed',
      downstreamDisposition: 'error',
      statusCode: 500,
      reason,
    });
    sendJson(res, 500, { error: 'Internal server error' });
  }
}
