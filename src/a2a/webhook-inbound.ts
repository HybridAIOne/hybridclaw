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
  type A2ATrustedWebhookPeer,
  getA2ATrustedWebhookPeer,
  listA2ATrustedWebhookPeers,
  normalizeA2APeerId,
  type UpsertA2ATrustedWebhookPeerInput,
  upsertA2ATrustedWebhookPeer,
} from './trust-ledger.js';
import {
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
} from './webhook-outbound.js';

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

export type A2AWebhookInboundPeer = A2ATrustedWebhookPeer;

export type UpsertA2AWebhookInboundPeerInput = UpsertA2ATrustedWebhookPeerInput;

export interface A2AWebhookInboundResult {
  statusCode: number;
  body: Record<string, unknown>;
}

interface RateLimitBucket {
  windowStartedAtMs: number;
  count: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();

export function upsertA2AWebhookInboundPeer(
  input: UpsertA2AWebhookInboundPeerInput,
  now = new Date(),
): A2AWebhookInboundPeer {
  return upsertA2ATrustedWebhookPeer(input, now);
}

export function getA2AWebhookInboundPeer(
  peerId: string,
): A2AWebhookInboundPeer | null {
  return getA2ATrustedWebhookPeer(peerId);
}

export function listA2AWebhookInboundPeers(): A2AWebhookInboundPeer[] {
  return listA2ATrustedWebhookPeers();
}

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

function envelopeIntent(envelope: A2AEnvelope | null): string | null {
  return envelope?.intent || null;
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

function localRecipientResolves(recipientAgentId: string): boolean {
  if (!recipientAgentId.includes('@')) {
    return Boolean(getAgentById(recipientAgentId));
  }
  return listAgents().some((agent) => {
    try {
      return resolveA2AAgentId(agent.id) === recipientAgentId.toLowerCase();
    } catch {
      return false;
    }
  });
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
  nowMs?: number;
}): A2AWebhookInboundResult {
  const peerId = normalizeA2APeerId(params.peerId);
  const runId = makeAuditRunId('a2a-webhook-inbound');
  const sessionId = `a2a:webhook-inbound:${peerId}`;
  const nowMs = params.nowMs ?? Date.now();
  const peer = getA2AWebhookInboundPeer(peerId);
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

  let envelope: A2AEnvelope | null = null;
  try {
    envelope = decodeWebhookEnvelope(params.rawBody, peer);
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
  } catch (error) {
    const reason =
      error instanceof A2AEnvelopeValidationError
        ? error.issues.join('; ')
        : error instanceof Error
          ? error.message
          : String(error);
    recordInboundAudit({
      peerId,
      runId,
      signatureOutcome: 'passed',
      intent: envelopeIntent(envelope),
      downstreamDisposition: 'validation_failed',
      envelope,
      statusCode: 400,
      reason,
    });
    return { statusCode: 400, body: { error: reason } };
  }

  if (!envelope) {
    throw new Error(
      'A2A webhook envelope validation did not return an envelope.',
    );
  }

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
      intent: envelopeIntent(envelope),
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
    const reason =
      error instanceof A2AEnvelopeValidationError
        ? error.issues.join('; ')
        : error instanceof Error
          ? error.message
          : String(error);
    recordInboundAudit({
      peerId,
      runId,
      signatureOutcome: 'passed',
      intent: envelopeIntent(envelope),
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
    const signatureHeaderName =
      peer?.signatureHeader || WEBHOOK_SIGNATURE_HEADER;
    const rawBody = (
      await readRequestBody(req, A2A_WEBHOOK_INBOUND_MAX_BODY_BYTES)
    ).toString('utf-8');
    const result = acceptA2AWebhookInboundEnvelope({
      peerId,
      rawBody,
      signatureHeader: readHeader(req.headers, signatureHeaderName),
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
