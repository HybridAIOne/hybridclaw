import type { JsonWebKey } from 'node:crypto';

import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  createSuspendedSession,
  emitInteractionNeededEvent,
} from '../gateway/interactive-escalation.js';
import {
  IdentityNotFoundError,
  type IdentityResolution,
} from '../identity/resolver.js';
import { resolveSecretHandleInput } from '../security/secret-refs.js';
import {
  A2AFailFastError,
  A2AHttpError,
  fetchA2AAgentCard,
} from './a2a-agent-card.js';
import { type A2AAgentCard, encodeA2AJsonRpcRequest } from './a2a-json-rpc.js';
import {
  type A2AOutboxItem,
  nowIso,
  persistA2AOutboxItem,
} from './a2a-outbox-persistence.js';
import {
  classifyA2AHttpStatus,
  shouldRetryA2AJsonRpcErrorCode,
} from './a2a-retry-policy.js';
import { getA2AAuditSessionId, recordA2AMessageAudit } from './audit.js';
import { signA2ADelegationToken } from './delegation-token.js';
import { summarizeA2AEnvelopeForAudit } from './envelope.js';
import { normalizePeerDescriptor } from './peer-descriptor.js';
import {
  type A2APeerPublicKeyMaterial,
  assertA2APeerPublicKeyTrust,
  extractA2APeerPublicKey,
  fingerprintA2APublicKey,
} from './trust-ledger.js';
import {
  isA2AAllowedHttpUrl,
  isA2ALoopbackHttpUrl,
  isRecord,
  normalizePositiveInteger,
} from './utils.js';

export const A2A_RETRY_BASE_DELAY_MS = 1_000;
export const A2A_RETRY_MAX_DELAY_MS = 5 * 60_000;
export const A2A_AGENT_CARD_READ_SCOPE = 'a2a:agent-card:read';
export const A2A_MESSAGE_SEND_SCOPE = 'a2a:message:send';
export const A2A_TASK_SEND_SCOPE = 'a2a:task:send';

export interface A2AOutboxProcessOptions {
  /** Test hook for deterministic delivery without making live network calls. */
  fetchImpl?: typeof fetch;
  /** Resolves canonical remote recipients that were queued without a peer descriptor. */
  identityResolver?: {
    resolve(canonicalId: string): Promise<IdentityResolution>;
  };
  /** Test hook for deterministic retry/audit timestamps. */
  now?: () => Date;
  /** Test hook for deterministic retry jitter. */
  random?: () => number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  concurrency?: number;
  agentCardCacheTtlMs?: number;
}

function resolveItemSessionId(item: A2AOutboxItem): string {
  return item.sessionId ?? getA2AAuditSessionId(item.envelope);
}

function resolveItemRunId(item: A2AOutboxItem, prefix: string): string {
  return item.runId || makeAuditRunId(prefix);
}

function assertBearerAuthConfigured(
  item: A2AOutboxItem,
  authUrl: string,
  opts: { required?: boolean } = {},
): void {
  if (!item.bearerTokenRef) {
    if (!opts.required || isA2ALoopbackHttpUrl(authUrl)) return;
    throw new A2AFailFastError(
      'a2a.bearerTokenRef is required for non-loopback peers',
    );
  }
  try {
    resolveSecretHandleInput(item.bearerTokenRef, {
      path: 'a2a.bearerTokenRef',
      required: true,
      sinkKind: 'http',
    });
  } catch (error) {
    throw new A2AFailFastError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function recordDelegationAuthAudit(params: {
  item: A2AOutboxItem;
  audience: string;
  scope: string;
  peerKey?: A2APeerPublicKeyMaterial;
}): void {
  recordA2AAudit(params.item, {
    type: 'a2a.outbound.delegation_auth',
    authMode: 'signed_delegation_jwt',
    bearerTokenRefRole: params.item.bearerTokenRef
      ? 'non_loopback_policy_gate'
      : params.peerKey
        ? 'not_required_public_key_trust'
        : 'not_required_for_loopback_or_agent_card',
    bearerTokenRef: params.item.bearerTokenRef
      ? {
          source: params.item.bearerTokenRef.source,
          id: params.item.bearerTokenRef.id,
        }
      : null,
    peerPublicKey: params.peerKey
      ? {
          peerId: params.peerKey.peerId,
          fingerprint: params.peerKey.publicKeyFingerprint,
        }
      : null,
    audience: params.audience,
    scope: params.scope,
    envelope: summarizeA2AEnvelopeForAudit(params.item.envelope),
  });
}

function resolveParentRunId(item: A2AOutboxItem): string {
  return item.runId || item.sessionId || item.envelope.thread_id;
}

function authHeaders(params: {
  item: A2AOutboxItem;
  audience: string;
  scope: string;
  now: Date;
  peerKey?: A2APeerPublicKeyMaterial;
  requireBearer?: boolean;
}): Record<string, string> {
  assertBearerAuthConfigured(params.item, params.audience, {
    required: params.requireBearer !== false,
  });
  recordDelegationAuthAudit(params);
  return {
    authorization: `Bearer ${signA2ADelegationToken({
      senderAgentId: params.item.envelope.sender_agent_id,
      targetAgentId: params.item.envelope.recipient_agent_id,
      audience: params.audience,
      scope: params.scope,
      parentRunId: resolveParentRunId(params.item),
      jwtId: params.item.envelope.id,
      messageId: params.item.envelope.id,
      threadId: params.item.envelope.thread_id,
      now: params.now,
    })}`,
  };
}

function agentCardAuthCacheKey(item: A2AOutboxItem): string | undefined {
  if (!item.bearerTokenRef) return undefined;
  return `${item.bearerTokenRef.source}:${item.bearerTokenRef.id}`;
}

function recordA2AAudit(
  item: A2AOutboxItem,
  event: Record<string, unknown> & { type: string },
): void {
  recordAuditEvent({
    sessionId: resolveItemSessionId(item),
    runId: resolveItemRunId(item, 'a2a-outbound'),
    event,
  });
}

function createA2AEscalation(item: A2AOutboxItem, reason: string): void {
  const sessionId = resolveItemSessionId(item);
  const runId = resolveItemRunId(item, 'a2a-outbound');
  const approvalId = `a2a-outbound-${item.envelope.id}`;
  const session = createSuspendedSession({
    sessionId,
    approvalId,
    prompt: [
      'A2A outbound delivery failed.',
      `Agent Card: ${item.agentCardUrl || '<unresolved>'}`,
      `Message: ${item.envelope.id}`,
      `Reason: ${reason}`,
      'Reply `approved` after fixing the peer, or `declined` to cancel this delivery.',
    ].join('\n'),
    userId: item.escalationTarget?.recipient || 'operator',
    modality: 'push',
    expectedReturnKinds: ['approved', 'declined', 'timeout'],
    frameSnapshot: {
      url: 'hybridclaw://a2a/outbox',
      title: 'A2A outbound delivery failed',
    },
    context: {
      host: 'a2a.outbound',
      pageTitle: 'A2A outbound delivery failure',
    },
    skillId: 'a2a.outbound',
    escalationTarget: item.escalationTarget,
  });
  emitInteractionNeededEvent({ session, runId });
}

function failA2AItem(
  item: A2AOutboxItem,
  now: Date,
  reason: string,
  details: { statusCode?: number; jsonRpcCode?: number } = {},
): A2AOutboxItem {
  const failed: A2AOutboxItem = {
    ...item,
    status: 'failed',
    attempts: item.attempts + 1,
    updatedAt: nowIso(now),
    lastAttemptAt: nowIso(now),
    failedAt: nowIso(now),
    lastError: reason,
    ...(details.statusCode ? { lastStatusCode: details.statusCode } : {}),
    ...(details.jsonRpcCode ? { lastJsonRpcCode: details.jsonRpcCode } : {}),
  };
  persistA2AOutboxItem(failed);
  recordA2AAudit(failed, {
    type: 'a2a.outbound.delivery_failed',
    reason,
    statusCode: details.statusCode ?? null,
    jsonRpcCode: details.jsonRpcCode ?? null,
    envelope: summarizeA2AEnvelopeForAudit(failed.envelope),
    agentCardUrl: failed.agentCardUrl ?? null,
  });
  recordA2AAudit(failed, {
    type: 'escalation.decision',
    action: 'a2a.outbound:deliver',
    proposedAction: 'deliver A2A envelope via JSON-RPC transport',
    escalationRoute: 'approval_request',
    target: failed.escalationTarget || null,
    stakes: 'high',
    classifier: 'a2a.outbound',
    classifierReasoning: [reason],
    approvalDecision: 'required',
    reason,
    envelope: summarizeA2AEnvelopeForAudit(failed.envelope),
  });
  createA2AEscalation(failed, reason);
  return failed;
}

function normalizeRetryOptions(
  opts: A2AOutboxProcessOptions,
): Required<
  Pick<
    A2AOutboxProcessOptions,
    'baseDelayMs' | 'maxDelayMs' | 'jitterRatio' | 'random'
  >
> {
  return {
    baseDelayMs: normalizePositiveInteger(
      opts.baseDelayMs,
      A2A_RETRY_BASE_DELAY_MS,
    ),
    maxDelayMs: normalizePositiveInteger(
      opts.maxDelayMs,
      A2A_RETRY_MAX_DELAY_MS,
    ),
    jitterRatio: Math.max(0, opts.jitterRatio ?? 0.2),
    random: opts.random ?? Math.random,
  };
}

function retryA2AItem(
  item: A2AOutboxItem,
  now: Date,
  reason: string,
  options: Required<
    Pick<
      A2AOutboxProcessOptions,
      'baseDelayMs' | 'maxDelayMs' | 'jitterRatio' | 'random'
    >
  >,
  details: { statusCode?: number; jsonRpcCode?: number } = {},
): A2AOutboxItem {
  const attempts = item.attempts + 1;
  const exponentialDelay = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * 2 ** Math.max(0, attempts - 1),
  );
  const jitter = exponentialDelay * options.jitterRatio * options.random();
  const delayMs = Math.max(0, Math.trunc(exponentialDelay + jitter));
  const retry: A2AOutboxItem = {
    ...item,
    attempts,
    updatedAt: nowIso(now),
    lastAttemptAt: nowIso(now),
    lastError: reason,
    nextAttemptAt: nowIso(new Date(now.getTime() + delayMs)),
    ...(details.statusCode ? { lastStatusCode: details.statusCode } : {}),
    ...(details.jsonRpcCode ? { lastJsonRpcCode: details.jsonRpcCode } : {}),
  };
  persistA2AOutboxItem(retry);
  recordA2AAudit(retry, {
    type: 'a2a.outbound.delivery_retry',
    reason,
    attempts,
    nextAttemptAt: retry.nextAttemptAt,
    statusCode: details.statusCode ?? null,
    jsonRpcCode: details.jsonRpcCode ?? null,
    envelope: summarizeA2AEnvelopeForAudit(retry.envelope),
    agentCardUrl: retry.agentCardUrl ?? null,
  });
  return retry;
}

function retryOrFailA2AItem(
  item: A2AOutboxItem,
  now: Date,
  attemptNumber: number,
  maxAttempts: number,
  reason: string,
  options: Required<
    Pick<
      A2AOutboxProcessOptions,
      'baseDelayMs' | 'maxDelayMs' | 'jitterRatio' | 'random'
    >
  >,
  details: { statusCode?: number; jsonRpcCode?: number } = {},
): 'retried' | 'failed' {
  if (attemptNumber >= maxAttempts) {
    failA2AItem(item, now, reason, details);
    return 'failed';
  }
  retryA2AItem(item, now, reason, options, details);
  return 'retried';
}

async function resolveA2AItemDeliveryTarget(
  item: A2AOutboxItem,
  opts: A2AOutboxProcessOptions,
  now: Date,
): Promise<A2AOutboxItem> {
  if (item.agentCardUrl) return item;

  const canonicalId = item.identityResolution?.canonicalId;
  if (!canonicalId) {
    throw new Error('A2A outbox item is missing an Agent Card URL');
  }
  if (!opts.identityResolver) {
    throw new Error(
      `A2A identity resolver is required for remote recipient ${canonicalId}`,
    );
  }

  const resolution = await opts.identityResolver.resolve(canonicalId);
  const descriptor = normalizePeerDescriptor({
    transport: 'a2a',
    url: resolution.url,
    expectPublicKey: true,
  });
  if (descriptor.transport !== 'a2a' || !('agentCardUrl' in descriptor)) {
    throw new Error('identity resolver did not produce an A2A peer descriptor');
  }

  const resolved: A2AOutboxItem = {
    ...item,
    agentCardUrl: descriptor.agentCardUrl,
    identityResolution: {
      status: 'resolved',
      canonicalId,
      url: resolution.url,
      publicKey: resolution.publicKey,
      resolvedAt: nowIso(now),
    },
    updatedAt: nowIso(now),
  };
  persistA2AOutboxItem(resolved);
  recordA2AAudit(resolved, {
    type: 'a2a.outbound.identity_resolved',
    canonicalId,
    url: resolution.url,
    publicKey: resolution.publicKey,
    envelope: summarizeA2AEnvelopeForAudit(resolved.envelope),
    agentCardUrl: resolved.agentCardUrl,
  });
  return resolved;
}

function discoveryPublicKeyFingerprint(publicKey: string): string | null {
  const normalized = publicKey.trim();
  if (/^[A-Za-z0-9_-]{43}$/.test(normalized)) return normalized;
  try {
    const parsed = JSON.parse(normalized) as JsonWebKey;
    if (
      parsed.kty !== 'OKP' ||
      parsed.crv !== 'Ed25519' ||
      typeof parsed.x !== 'string'
    ) {
      return null;
    }
    return fingerprintA2APublicKey(parsed);
  } catch {
    return null;
  }
}

function assertDiscoveryPublicKeyMatchesCard(
  item: A2AOutboxItem,
  peerKey: A2APeerPublicKeyMaterial | undefined,
): void {
  const identityResolution = item.identityResolution;
  if (identityResolution?.status !== 'resolved') return;
  const expected = discoveryPublicKeyFingerprint(identityResolution.publicKey);
  if (!expected) {
    throw new Error(
      `identity discovery returned an unsupported public key format for ${identityResolution.canonicalId}`,
    );
  }
  if (!peerKey) {
    throw new Error(
      'identity discovery returned a public key but the Agent Card did not advertise one',
    );
  }
  if (peerKey.publicKeyFingerprint !== expected) {
    throw new Error(
      `A2A identity discovery public key mismatch for ${identityResolution.canonicalId}`,
    );
  }
}

async function readJsonRpcResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  return JSON.parse(text) as unknown;
}

function requireTasksSendResponse(
  response: unknown,
): asserts response is Record<string, unknown> {
  if (!isRecord(response)) {
    throw new A2AFailFastError(
      'tasks/send requires a well-formed JSON-RPC response body',
    );
  }
  if (response.jsonrpc !== '2.0') {
    throw new A2AFailFastError('tasks/send response must use jsonrpc "2.0"');
  }
  if (!Object.hasOwn(response, 'result') && !Object.hasOwn(response, 'error')) {
    throw new A2AFailFastError(
      'tasks/send response must include result or error',
    );
  }
}

export async function deliverA2AItem(
  item: A2AOutboxItem,
  opts: A2AOutboxProcessOptions,
): Promise<'delivered' | 'retried' | 'failed'> {
  const now = opts.now?.() ?? new Date();
  const attemptNumber = item.attempts + 1;
  const maxAttempts = normalizePositiveInteger(
    opts.maxAttempts,
    item.maxAttempts,
  );
  const retryOptions = normalizeRetryOptions(opts);

  let deliveryItem = item;
  let card: A2AAgentCard;
  try {
    deliveryItem = await resolveA2AItemDeliveryTarget(item, opts, now);
    if (!deliveryItem.agentCardUrl) {
      throw new Error('A2A outbox item is missing an Agent Card URL');
    }
    card = await fetchA2AAgentCard({
      agentCardUrl: deliveryItem.agentCardUrl,
      fetchImpl: opts.fetchImpl,
      now,
      headers: authHeaders({
        item: deliveryItem,
        audience: deliveryItem.agentCardUrl,
        scope: A2A_AGENT_CARD_READ_SCOPE,
        now,
        requireBearer: false,
      }),
      authCacheKey: agentCardAuthCacheKey(deliveryItem),
      agentCardCacheTtlMs: opts.agentCardCacheTtlMs,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const statusCode =
      error instanceof A2AHttpError ? error.statusCode : undefined;
    if (
      error instanceof A2AFailFastError ||
      error instanceof IdentityNotFoundError
    ) {
      failA2AItem(deliveryItem, now, reason);
      return 'failed';
    }
    const httpDecision = statusCode
      ? classifyA2AHttpStatus(statusCode)
      : 'retry';
    if (httpDecision === 'fail-fast') {
      failA2AItem(deliveryItem, now, reason, { statusCode });
      return 'failed';
    }
    return retryOrFailA2AItem(
      deliveryItem,
      now,
      attemptNumber,
      maxAttempts,
      reason,
      retryOptions,
      { statusCode },
    );
  }

  let peerKey: A2APeerPublicKeyMaterial | undefined;
  try {
    peerKey = extractA2APeerPublicKey(card) ?? undefined;
    assertDiscoveryPublicKeyMatchesCard(deliveryItem, peerKey);
    if (peerKey) {
      assertA2APeerPublicKeyTrust({
        agentCardUrl: deliveryItem.agentCardUrl,
        deliveryUrl: card.url,
        key: peerKey,
        runId: resolveItemRunId(deliveryItem, 'a2a-trust'),
        now,
      });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failA2AItem(deliveryItem, now, reason);
    return 'failed';
  }

  const request = encodeA2AJsonRpcRequest(deliveryItem.envelope, card);
  if (!isA2AAllowedHttpUrl(card.url)) {
    failA2AItem(
      deliveryItem,
      now,
      'Agent Card url must use https unless targeting loopback',
    );
    return 'failed';
  }
  const body = JSON.stringify(request);
  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(card.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders({
          item: deliveryItem,
          audience: card.url,
          scope:
            request.method === 'tasks/send'
              ? A2A_TASK_SEND_SCOPE
              : A2A_MESSAGE_SEND_SCOPE,
          now,
          peerKey,
          requireBearer: !peerKey,
        }),
      },
      body,
      redirect: 'error',
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof A2AFailFastError) {
      failA2AItem(deliveryItem, now, reason);
      return 'failed';
    }
    return retryOrFailA2AItem(
      deliveryItem,
      now,
      attemptNumber,
      maxAttempts,
      reason,
      retryOptions,
    );
  }

  const httpDecision = classifyA2AHttpStatus(response.status);
  if (httpDecision === 'fail-fast') {
    failA2AItem(deliveryItem, now, `HTTP ${response.status}`, {
      statusCode: response.status,
    });
    return 'failed';
  }
  if (httpDecision === 'retry') {
    return retryOrFailA2AItem(
      deliveryItem,
      now,
      attemptNumber,
      maxAttempts,
      `HTTP ${response.status}`,
      retryOptions,
      { statusCode: response.status },
    );
  }

  let jsonRpcResponse: unknown;
  try {
    jsonRpcResponse = await readJsonRpcResponse(response);
    if (request.method === 'tasks/send') {
      requireTasksSendResponse(jsonRpcResponse);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failA2AItem(deliveryItem, now, reason, { statusCode: response.status });
    return 'failed';
  }

  if (isRecord(jsonRpcResponse) && isRecord(jsonRpcResponse.error)) {
    const code = Number(jsonRpcResponse.error.code);
    const message =
      typeof jsonRpcResponse.error.message === 'string'
        ? jsonRpcResponse.error.message
        : 'JSON-RPC error';
    const reason = `JSON-RPC ${Number.isFinite(code) ? code : 'error'}: ${message}`;
    if (Number.isFinite(code) && shouldRetryA2AJsonRpcErrorCode(code)) {
      return retryOrFailA2AItem(
        deliveryItem,
        now,
        attemptNumber,
        maxAttempts,
        reason,
        retryOptions,
        {
          statusCode: response.status,
          jsonRpcCode: code,
        },
      );
    }
    failA2AItem(deliveryItem, now, reason, {
      statusCode: response.status,
      ...(Number.isFinite(code) ? { jsonRpcCode: code } : {}),
    });
    return 'failed';
  }

  const delivered: A2AOutboxItem = {
    ...deliveryItem,
    status: 'delivered',
    attempts: attemptNumber,
    updatedAt: nowIso(now),
    lastAttemptAt: nowIso(now),
    deliveredAt: nowIso(now),
    lastStatusCode: response.status,
    lastError: undefined,
  };
  persistA2AOutboxItem(delivered);
  recordA2AMessageAudit({
    type: 'a2a.deliver',
    envelope: delivered.envelope,
    sessionId: resolveItemSessionId(delivered),
    runId: resolveItemRunId(delivered, 'a2a-outbound'),
    route: 'a2a.outbound.delivery',
    source: 'a2a-outbound',
    transport: 'a2a',
    statusCode: response.status,
    attempts: attemptNumber,
  });
  recordA2AAudit(delivered, {
    type: 'a2a.outbound.delivered',
    statusCode: response.status,
    attempts: attemptNumber,
    method: request.method,
    envelope: summarizeA2AEnvelopeForAudit(delivered.envelope),
    agentCardUrl: delivered.agentCardUrl ?? null,
  });
  return 'delivered';
}
