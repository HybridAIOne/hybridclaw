import { createHmac } from 'node:crypto';

import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  createSuspendedSession,
  emitInteractionNeededEvent,
} from '../gateway/interactive-escalation.js';
import {
  resolveSecretInputUnsafe,
  type SecretRef,
} from '../security/secret-refs.js';
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
import { summarizeA2AEnvelopeForAudit } from './envelope.js';
import {
  isA2AAllowedHttpUrl,
  isA2ALoopbackHttpUrl,
  isRecord,
  normalizePositiveInteger,
} from './utils.js';

export const A2A_RETRY_BASE_DELAY_MS = 1_000;
export const A2A_RETRY_MAX_DELAY_MS = 5 * 60_000;

export interface A2AOutboxProcessOptions {
  /** Test hook for deterministic delivery without making live network calls. */
  fetchImpl?: typeof fetch;
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

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeSignedBearer(input: {
  item: A2AOutboxItem;
  secret: string;
  audience: string;
  now: Date;
}): string {
  const issuedAt = Math.trunc(input.now.getTime() / 1000);
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  // pre-F7 (#574): descriptor-key bearer auth only until trust-ledger auth lands.
  const payload = base64UrlJson({
    iss: 'hybridclaw',
    sub: input.item.envelope.sender_agent_id,
    aud: input.audience,
    jti: input.item.envelope.id,
    thread_id: input.item.envelope.thread_id,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + 300,
  });
  const signature = createHmac('sha256', input.secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function auditSecretEscape(params: {
  sessionId: string;
  runId: string;
  ref: SecretRef;
  url: string;
  reason: string;
}): void {
  recordAuditEvent({
    sessionId: params.sessionId,
    runId: params.runId,
    event: {
      type: 'secret.unsafe_escape',
      skill: 'a2a.outbound',
      secretRef: params.ref,
      sinkKind: 'http',
      host: new URL(params.url).host,
      selector: null,
      reason: params.reason,
    },
  });
}

function resolveItemSessionId(item: A2AOutboxItem): string {
  return item.sessionId || `a2a:outbound:${item.envelope.thread_id}`;
}

function resolveItemRunId(item: A2AOutboxItem, prefix: string): string {
  return item.runId || makeAuditRunId(prefix);
}

function resolveBearerSecret(
  item: A2AOutboxItem,
  authUrl: string,
): string | undefined {
  if (!item.bearerTokenRef) {
    if (isA2ALoopbackHttpUrl(authUrl)) return undefined;
    throw new A2AFailFastError(
      'a2a.bearerTokenRef is required for non-loopback peers',
    );
  }
  const secret = resolveSecretInputUnsafe(item.bearerTokenRef, {
    path: 'a2a.bearerTokenRef',
    required: true,
    reason: 'sign outbound A2A bearer token',
    audit: (handle, reason) =>
      auditSecretEscape({
        sessionId: resolveItemSessionId(item),
        runId: resolveItemRunId(item, 'a2a-outbound-secret'),
        ref: handle.ref,
        url: authUrl,
        reason,
      }),
  });
  if (!secret) {
    throw new Error(
      `a2a.bearerTokenRef resolved to an empty secret for ${item.bearerTokenRef.source}:${item.bearerTokenRef.id}`,
    );
  }
  return secret;
}

function authHeaders(params: {
  item: A2AOutboxItem;
  audience: string;
  now: Date;
}): Record<string, string> {
  const secret = resolveBearerSecret(params.item, params.audience);
  if (!secret) return {};
  return {
    authorization: `Bearer ${makeSignedBearer({
      item: params.item,
      secret,
      audience: params.audience,
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
      `Agent Card: ${item.agentCardUrl}`,
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
    agentCardUrl: failed.agentCardUrl,
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
    agentCardUrl: retry.agentCardUrl,
  });
  return retry;
}

function shouldRetryJsonRpcError(code: number): boolean {
  return code === -32603 || (code <= -32000 && code >= -32099);
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

  let card: A2AAgentCard;
  try {
    card = await fetchA2AAgentCard({
      agentCardUrl: item.agentCardUrl,
      fetchImpl: opts.fetchImpl,
      now,
      headers: authHeaders({ item, audience: item.agentCardUrl, now }),
      authCacheKey: agentCardAuthCacheKey(item),
      agentCardCacheTtlMs: opts.agentCardCacheTtlMs,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const statusCode =
      error instanceof A2AHttpError ? error.statusCode : undefined;
    if (error instanceof A2AFailFastError) {
      failA2AItem(item, now, reason);
      return 'failed';
    }
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      failA2AItem(item, now, reason, { statusCode });
      return 'failed';
    }
    if (attemptNumber >= maxAttempts) {
      failA2AItem(item, now, reason, { statusCode });
      return 'failed';
    }
    retryA2AItem(item, now, reason, retryOptions, { statusCode });
    return 'retried';
  }

  const request = encodeA2AJsonRpcRequest(item.envelope, card);
  if (!isA2AAllowedHttpUrl(card.url)) {
    failA2AItem(
      item,
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
        ...authHeaders({ item, audience: card.url, now }),
      },
      body,
      redirect: 'error',
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof A2AFailFastError) {
      failA2AItem(item, now, reason);
      return 'failed';
    }
    if (attemptNumber >= maxAttempts) {
      failA2AItem(item, now, reason);
      return 'failed';
    }
    retryA2AItem(item, now, reason, retryOptions);
    return 'retried';
  }

  if (response.status >= 400 && response.status < 500) {
    failA2AItem(item, now, `HTTP ${response.status}`, {
      statusCode: response.status,
    });
    return 'failed';
  }
  if (response.status >= 500) {
    if (attemptNumber >= maxAttempts) {
      failA2AItem(item, now, `HTTP ${response.status}`, {
        statusCode: response.status,
      });
      return 'failed';
    }
    retryA2AItem(item, now, `HTTP ${response.status}`, retryOptions, {
      statusCode: response.status,
    });
    return 'retried';
  }

  let jsonRpcResponse: unknown;
  try {
    jsonRpcResponse = await readJsonRpcResponse(response);
    if (request.method === 'tasks/send') {
      requireTasksSendResponse(jsonRpcResponse);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failA2AItem(item, now, reason, { statusCode: response.status });
    return 'failed';
  }

  if (isRecord(jsonRpcResponse) && isRecord(jsonRpcResponse.error)) {
    const code = Number(jsonRpcResponse.error.code);
    const message =
      typeof jsonRpcResponse.error.message === 'string'
        ? jsonRpcResponse.error.message
        : 'JSON-RPC error';
    const reason = `JSON-RPC ${Number.isFinite(code) ? code : 'error'}: ${message}`;
    if (Number.isFinite(code) && shouldRetryJsonRpcError(code)) {
      if (attemptNumber >= maxAttempts) {
        failA2AItem(item, now, reason, {
          statusCode: response.status,
          jsonRpcCode: code,
        });
        return 'failed';
      }
      retryA2AItem(item, now, reason, retryOptions, {
        statusCode: response.status,
        jsonRpcCode: code,
      });
      return 'retried';
    }
    failA2AItem(item, now, reason, {
      statusCode: response.status,
      ...(Number.isFinite(code) ? { jsonRpcCode: code } : {}),
    });
    return 'failed';
  }

  const delivered: A2AOutboxItem = {
    ...item,
    status: 'delivered',
    attempts: attemptNumber,
    updatedAt: nowIso(now),
    lastAttemptAt: nowIso(now),
    deliveredAt: nowIso(now),
    lastStatusCode: response.status,
    lastError: undefined,
  };
  persistA2AOutboxItem(delivered);
  recordA2AAudit(delivered, {
    type: 'a2a.outbound.delivered',
    statusCode: response.status,
    attempts: attemptNumber,
    method: request.method,
    envelope: summarizeA2AEnvelopeForAudit(delivered.envelope),
    agentCardUrl: delivered.agentCardUrl,
  });
  return 'delivered';
}
