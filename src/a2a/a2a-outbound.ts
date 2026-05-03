import { createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';

import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  listRuntimeAssetRevisionStates,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import {
  createSuspendedSession,
  emitInteractionNeededEvent,
} from '../gateway/interactive-escalation.js';
import { logger } from '../logger.js';
import {
  resolveSecretInputUnsafe,
  type SecretRef,
} from '../security/secret-refs.js';
import type { EscalationTarget } from '../types/execution.js';
import {
  A2AFailFastError,
  A2AHttpError,
  fetchA2AAgentCard,
} from './a2a-agent-card.js';
import {
  type A2AAgentCard,
  type A2AJsonRpcMethod,
  decodeA2AJsonRpcRequest,
  encodeA2AJsonRpcRequest,
} from './a2a-json-rpc.js';
import {
  type A2AEnvelope,
  summarizeA2AEnvelopeForAudit,
  validateA2AEnvelope,
} from './envelope.js';
import type { A2APeerDescriptor } from './peer-descriptor.js';
import type {
  TransportAdapter,
  TransportAdapterContext,
} from './transport-registry.js';
import { isRecord } from './utils.js';

export {
  A2A_AGENT_CARD_CACHE_TTL_MS,
  clearA2AAgentCardCache,
} from './a2a-agent-card.js';
export {
  type A2AAgentCard,
  type A2AJsonRpcMethod,
  type A2AOutboundJsonRpcRequest,
  decodeA2AJsonRpcRequest,
  encodeA2AJsonRpcRequest,
} from './a2a-json-rpc.js';

export const A2A_RETRY_BASE_DELAY_MS = 1_000;
export const A2A_RETRY_MAX_DELAY_MS = 5 * 60_000;
export const A2A_RETRY_MAX_ATTEMPTS = 8;
export const A2A_OUTBOX_CONCURRENCY = 4;
export const A2A_OUTBOX_DRAIN_INTERVAL_MS = 5_000;
const A2A_OUTBOX_SCHEMA_VERSION = 1;
const A2A_OUTBOX_ASSET_PREFIX = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'a2a',
  'outbox',
  'a2a',
);

export type A2AOutboundStatus = 'pending' | 'delivered' | 'failed';

export interface A2AOutboxItem {
  schemaVersion: typeof A2A_OUTBOX_SCHEMA_VERSION;
  id: string;
  status: A2AOutboundStatus;
  envelope: A2AEnvelope;
  agentCardUrl: string;
  bearerTokenRef?: SecretRef;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  runId?: string;
  escalationTarget?: EscalationTarget;
  lastAttemptAt?: string;
  deliveredAt?: string;
  failedAt?: string;
  lastError?: string;
  lastStatusCode?: number;
  lastJsonRpcCode?: number;
  lastMethod?: A2AJsonRpcMethod;
}

export interface A2AOutboundAdapterOptions {
  autoProcess?: boolean;
  maxAttempts?: number;
}

export interface A2AOutboxProcessOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  random?: () => number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  concurrency?: number;
  agentCardCacheTtlMs?: number;
}

export interface A2AOutboxProcessResult {
  processed: number;
  delivered: number;
  retried: number;
  failed: number;
}

let a2aOutboxProcessorTimer: ReturnType<typeof setInterval> | null = null;
let a2aOutboxProcessorRunning = false;

function outboxAssetPath(id: string): string {
  return path.join(A2A_OUTBOX_ASSET_PREFIX, `${id}.json`);
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value as number));
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
  const payload = base64UrlJson({
    iss: 'hybridclaw',
    sub: input.item.envelope.sender_agent_id,
    aud: input.audience,
    jti: input.item.envelope.id,
    thread_id: input.item.envelope.thread_id,
    iat: issuedAt,
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

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
    return (
      hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname)
    );
  } catch {
    return false;
  }
}

function resolveBearerSecret(item: A2AOutboxItem): string | undefined {
  if (!item.bearerTokenRef) {
    if (isLoopbackUrl(item.agentCardUrl)) return undefined;
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
        url: item.agentCardUrl,
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
  const secret = resolveBearerSecret(params.item);
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

function parseOutboxItem(raw: string): A2AOutboxItem | null {
  try {
    const parsed = JSON.parse(raw) as A2AOutboxItem;
    if (parsed.schemaVersion !== A2A_OUTBOX_SCHEMA_VERSION) return null;
    validateA2AEnvelope(parsed.envelope);
    if (
      parsed.status !== 'pending' &&
      parsed.status !== 'delivered' &&
      parsed.status !== 'failed'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function persistOutboxItem(item: A2AOutboxItem): void {
  syncRuntimeAssetRevisionState(
    'a2a',
    outboxAssetPath(item.id),
    {
      route: 'a2a.outbound.outbox',
      source: 'a2a-outbound',
    },
    {
      exists: true,
      content: JSON.stringify(item),
    },
  );
}

export function listA2AOutboxItems(): A2AOutboxItem[] {
  return listRuntimeAssetRevisionStates('a2a', {
    assetPathPrefix: A2A_OUTBOX_ASSET_PREFIX,
  })
    .map((state) => parseOutboxItem(state.content))
    .filter((item): item is A2AOutboxItem => item !== null)
    .sort((left, right) => {
      const nextAttemptOrder = left.nextAttemptAt.localeCompare(
        right.nextAttemptAt,
      );
      if (nextAttemptOrder !== 0) return nextAttemptOrder;
      return left.id.localeCompare(right.id);
    });
}

function makeOutboxItem(
  envelope: A2AEnvelope,
  descriptor: A2APeerDescriptor,
  context?: TransportAdapterContext,
  opts?: A2AOutboundAdapterOptions,
): A2AOutboxItem {
  const createdAt = new Date();
  const createdAtIso = nowIso(createdAt);
  return {
    schemaVersion: A2A_OUTBOX_SCHEMA_VERSION,
    id: randomUUID(),
    status: 'pending',
    envelope: validateA2AEnvelope(envelope),
    agentCardUrl: descriptor.agentCardUrl,
    bearerTokenRef: descriptor.bearerTokenRef,
    attempts: 0,
    maxAttempts: normalizePositiveInteger(
      opts?.maxAttempts,
      A2A_RETRY_MAX_ATTEMPTS,
    ),
    nextAttemptAt: createdAtIso,
    createdAt: createdAtIso,
    updatedAt: createdAtIso,
    sessionId: context?.sessionId,
    runId: context?.runId,
    escalationTarget: context?.escalationTarget,
  };
}

export function enqueueA2AEnvelope(
  envelope: A2AEnvelope,
  descriptor: A2APeerDescriptor,
  context?: TransportAdapterContext,
  opts?: A2AOutboundAdapterOptions,
): A2AOutboxItem {
  const item = makeOutboxItem(envelope, descriptor, context, opts);
  persistOutboxItem(item);
  return item;
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
  persistOutboxItem(failed);
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
  persistOutboxItem(retry);
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

async function deliverA2AItem(
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
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
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
    lastMethod: request.method,
    lastError: undefined,
  };
  persistOutboxItem(delivered);
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

export async function processA2AOutbox(
  opts: A2AOutboxProcessOptions = {},
): Promise<A2AOutboxProcessResult> {
  const now = opts.now?.() ?? new Date();
  const concurrency = normalizePositiveInteger(
    opts.concurrency,
    A2A_OUTBOX_CONCURRENCY,
  );
  const due = listA2AOutboxItems().filter(
    (item) =>
      item.status === 'pending' &&
      Date.parse(item.nextAttemptAt) <= now.getTime(),
  );
  const result: A2AOutboxProcessResult = {
    processed: 0,
    delivered: 0,
    retried: 0,
    failed: 0,
  };

  for (let index = 0; index < due.length; index += concurrency) {
    const batch = due.slice(index, index + concurrency);
    result.processed += batch.length;
    const outcomes = await Promise.allSettled(
      batch.map((item) => deliverA2AItem(item, opts)),
    );
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') {
        result[outcome.value] += 1;
      } else {
        result.failed += 1;
        logger.warn(
          { err: outcome.reason },
          'A2A outbound delivery rejected unexpectedly',
        );
      }
    }
  }
  return result;
}

async function drainA2AOutbox(source: 'startup' | 'interval'): Promise<void> {
  if (a2aOutboxProcessorRunning) {
    logger.debug(
      { source },
      'A2A outbound outbox drain skipped because a previous drain is still running',
    );
    return;
  }

  a2aOutboxProcessorRunning = true;
  try {
    const result = await processA2AOutbox();
    if (result.processed > 0) {
      logger.info({ source, ...result }, 'A2A outbound outbox drained');
    }
  } catch (error) {
    logger.warn({ source, error }, 'A2A outbound outbox drain failed');
  } finally {
    a2aOutboxProcessorRunning = false;
  }
}

export function startA2AOutboxProcessor(
  intervalMs = A2A_OUTBOX_DRAIN_INTERVAL_MS,
): void {
  stopA2AOutboxProcessor();
  const normalizedIntervalMs = normalizePositiveInteger(
    intervalMs,
    A2A_OUTBOX_DRAIN_INTERVAL_MS,
  );
  void drainA2AOutbox('startup');
  a2aOutboxProcessorTimer = setInterval(() => {
    void drainA2AOutbox('interval');
  }, normalizedIntervalMs);
  logger.info(
    { intervalMs: normalizedIntervalMs },
    'A2A outbound outbox processor started',
  );
}

export function stopA2AOutboxProcessor(): void {
  if (a2aOutboxProcessorTimer) {
    clearInterval(a2aOutboxProcessorTimer);
    a2aOutboxProcessorTimer = null;
    logger.info('A2A outbound outbox processor stopped');
  }
  a2aOutboxProcessorRunning = false;
}

export class A2AOutboundAdapter implements TransportAdapter<A2AOutboxItem> {
  readonly transport = 'a2a' as const;

  constructor(private readonly opts: A2AOutboundAdapterOptions = {}) {}

  encode(
    envelope: A2AEnvelope,
    descriptor?: A2APeerDescriptor,
    context?: TransportAdapterContext,
  ): A2AOutboxItem {
    if (!descriptor || descriptor.transport !== 'a2a') {
      const receivedTransport = descriptor?.transport ?? 'undefined';
      throw new Error(
        `A2AOutboundAdapter requires an a2a descriptor; received "${receivedTransport}".`,
      );
    }
    const item = enqueueA2AEnvelope(envelope, descriptor, context, this.opts);
    if (this.opts.autoProcess !== false) {
      void processA2AOutbox().catch((error) => {
        logger.warn({ err: error }, 'Failed to process A2A outbound outbox');
      });
    }
    return item;
  }

  decode(payload: unknown): A2AEnvelope {
    return decodeA2AJsonRpcRequest(payload);
  }
}

export const a2aOutboundAdapter = new A2AOutboundAdapter();
