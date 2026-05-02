import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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
  type A2AEnvelope,
  summarizeA2AEnvelopeForAudit,
  validateA2AEnvelope,
} from './envelope.js';
import type { WebhookPeerDescriptor } from './peer-descriptor.js';
import type {
  TransportAdapter,
  TransportAdapterContext,
} from './transport-registry.js';

export const WEBHOOK_SIGNATURE_HEADER = 'X-HybridClaw-Signature';
export const WEBHOOK_BODY_VERSION = '1';
export const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60_000;
export const WEBHOOK_RETRY_BASE_DELAY_MS = 1_000;
export const WEBHOOK_RETRY_MAX_DELAY_MS = 5 * 60_000;
export const WEBHOOK_RETRY_MAX_ATTEMPTS = 8;
export const WEBHOOK_OUTBOX_CONCURRENCY = 4;
export const WEBHOOK_OUTBOX_DRAIN_INTERVAL_MS = 5_000;
const WEBHOOK_OUTBOX_SCHEMA_VERSION = 1;
const WEBHOOK_OUTBOX_ASSET_PREFIX = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'a2a',
  'outbox',
  'webhook',
);

export type WebhookOutboxStatus = 'pending' | 'delivered' | 'failed';

export interface WebhookOutboxItem {
  schemaVersion: typeof WEBHOOK_OUTBOX_SCHEMA_VERSION;
  id: string;
  status: WebhookOutboxStatus;
  envelope: A2AEnvelope;
  url: string;
  secretRef: SecretRef;
  signatureHeader: string;
  version: string;
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
}

export interface WebhookOutboundAdapterOptions {
  autoProcess?: boolean;
  maxAttempts?: number;
}

export interface WebhookOutboxProcessOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  random?: () => number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  concurrency?: number;
}

export interface WebhookOutboxProcessResult {
  processed: number;
  delivered: number;
  retried: number;
  failed: number;
}

let webhookOutboxProcessorTimer: ReturnType<typeof setInterval> | null = null;
let webhookOutboxProcessorRunning = false;

export interface WebhookSignatureVerificationInput {
  header: string | null | undefined;
  body: string;
  secret: string;
  nowMs?: number;
  replayWindowMs?: number;
}

function outboxAssetPath(id: string): string {
  return path.join(WEBHOOK_OUTBOX_ASSET_PREFIX, `${id}.json`);
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry ?? null)).join(',')}]`;
  }
  if (typeof value !== 'object') return 'null';

  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${parts.join(',')}}`;
}

export function canonicalWebhookBody(
  envelope: A2AEnvelope,
  version = WEBHOOK_BODY_VERSION,
): string {
  const canonicalEnvelope = validateA2AEnvelope(envelope);
  return stableJson({
    ...canonicalEnvelope,
    version,
  });
}

export function signWebhookBody(input: {
  body: string;
  secret: string;
  timestampSeconds?: number;
}): string {
  const timestamp = Math.trunc(input.timestampSeconds ?? Date.now() / 1000);
  const signature = createHmac('sha256', input.secret)
    .update(`${timestamp}.${input.body}`)
    .digest('hex');
  return `t=${timestamp}, v1=${signature}`;
}

function parseSignatureHeader(
  header: string | null | undefined,
): { timestamp: number; signature: string } | null {
  if (!header) return null;
  const segments = header.split(',').map((segment) => segment.trim());
  const values = new Map<string, string>();
  for (const segment of segments) {
    const separator = segment.indexOf('=');
    if (separator <= 0) continue;
    values.set(segment.slice(0, separator), segment.slice(separator + 1));
  }
  const timestamp = Number(values.get('t'));
  const signature = values.get('v1') || '';
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  if (!/^[a-f0-9]{64}$/i.test(signature)) return null;
  return { timestamp, signature: signature.toLowerCase() };
}

export function verifyWebhookSignature(
  input: WebhookSignatureVerificationInput,
): boolean {
  const parsed = parseSignatureHeader(input.header);
  if (!parsed || !input.secret) return false;
  const now = Math.trunc((input.nowMs ?? Date.now()) / 1000);
  const replayWindowSeconds = Math.max(
    0,
    Math.trunc((input.replayWindowMs ?? WEBHOOK_REPLAY_WINDOW_MS) / 1000),
  );
  if (Math.abs(now - parsed.timestamp) > replayWindowSeconds) return false;

  const expected = signWebhookBody({
    body: input.body,
    secret: input.secret,
    timestampSeconds: parsed.timestamp,
  })
    .split('v1=')[1]
    ?.toLowerCase();
  if (!expected) return false;

  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(parsed.signature, 'hex');
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function parseOutboxItem(raw: string): WebhookOutboxItem | null {
  try {
    const parsed = JSON.parse(raw) as WebhookOutboxItem;
    if (parsed.schemaVersion !== WEBHOOK_OUTBOX_SCHEMA_VERSION) return null;
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

function persistOutboxItem(item: WebhookOutboxItem): void {
  syncRuntimeAssetRevisionState(
    'a2a',
    outboxAssetPath(item.id),
    {
      route: 'a2a.webhook.outbox',
      source: 'a2a-webhook',
    },
    {
      exists: true,
      content: JSON.stringify(item),
    },
  );
}

export function listWebhookOutboxItems(): WebhookOutboxItem[] {
  return listRuntimeAssetRevisionStates('a2a', {
    assetPathPrefix: WEBHOOK_OUTBOX_ASSET_PREFIX,
  })
    .map((state) => parseOutboxItem(state.content))
    .filter((item): item is WebhookOutboxItem => item !== null)
    .sort((left, right) => {
      const nextAttemptOrder = left.nextAttemptAt.localeCompare(
        right.nextAttemptAt,
      );
      if (nextAttemptOrder !== 0) return nextAttemptOrder;
      return left.id.localeCompare(right.id);
    });
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
      skill: 'a2a.webhook',
      secretRef: params.ref,
      sinkKind: 'http',
      host: new URL(params.url).host,
      selector: null,
      reason: params.reason,
    },
  });
}

function resolveWebhookSecret(item: WebhookOutboxItem): string {
  const secret = resolveSecretInputUnsafe(item.secretRef, {
    path: 'a2a.webhook.secretRef',
    required: true,
    reason: 'sign outbound webhook envelope',
    audit: (handle, reason) =>
      auditSecretEscape({
        sessionId: resolveItemSessionId(item),
        runId: item.runId || makeAuditRunId('a2a-webhook-secret'),
        ref: handle.ref,
        url: item.url,
        reason,
      }),
  });
  if (!secret) {
    throw new Error(
      `a2a.webhook.secretRef resolved to an empty secret for ${item.secretRef.source}:${item.secretRef.id}`,
    );
  }
  return secret;
}

function makeOutboxItem(
  envelope: A2AEnvelope,
  descriptor: WebhookPeerDescriptor,
  context?: TransportAdapterContext,
  opts?: WebhookOutboundAdapterOptions,
): WebhookOutboxItem {
  const createdAt = new Date();
  const createdAtIso = nowIso(createdAt);
  return {
    schemaVersion: WEBHOOK_OUTBOX_SCHEMA_VERSION,
    id: randomUUID(),
    status: 'pending',
    envelope: validateA2AEnvelope(envelope),
    url: descriptor.url,
    secretRef: descriptor.secretRef,
    signatureHeader: descriptor.signatureHeader || WEBHOOK_SIGNATURE_HEADER,
    version: descriptor.version || WEBHOOK_BODY_VERSION,
    attempts: 0,
    maxAttempts: normalizePositiveInteger(
      opts?.maxAttempts,
      WEBHOOK_RETRY_MAX_ATTEMPTS,
    ),
    nextAttemptAt: createdAtIso,
    createdAt: createdAtIso,
    updatedAt: createdAtIso,
    sessionId: context?.sessionId,
    runId: context?.runId,
    escalationTarget: context?.escalationTarget,
  };
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value as number));
}

export function enqueueWebhookEnvelope(
  envelope: A2AEnvelope,
  descriptor: WebhookPeerDescriptor,
  context?: TransportAdapterContext,
  opts?: WebhookOutboundAdapterOptions,
): WebhookOutboxItem {
  const item = makeOutboxItem(envelope, descriptor, context, opts);
  persistOutboxItem(item);
  return item;
}

function webhookSessionId(item: WebhookOutboxItem): string {
  return `a2a:webhook:${item.envelope.thread_id}`;
}

function resolveItemSessionId(item: WebhookOutboxItem): string {
  return item.sessionId || webhookSessionId(item);
}

function resolveItemRunId(item: WebhookOutboxItem, prefix: string): string {
  return item.runId || makeAuditRunId(prefix);
}

function recordWebhookAudit(
  item: WebhookOutboxItem,
  event: Record<string, unknown> & { type: string },
): void {
  recordAuditEvent({
    sessionId: resolveItemSessionId(item),
    runId: resolveItemRunId(item, 'a2a-webhook'),
    event,
  });
}

function createWebhookEscalation(
  item: WebhookOutboxItem,
  reason: string,
): void {
  const sessionId = resolveItemSessionId(item);
  const runId = resolveItemRunId(item, 'a2a-webhook');
  const approvalId = `a2a-webhook-${item.envelope.id}`;
  const session = createSuspendedSession({
    sessionId,
    approvalId,
    prompt: [
      'A2A webhook delivery failed.',
      `URL: ${item.url}`,
      `Message: ${item.envelope.id}`,
      `Reason: ${reason}`,
      'Reply `approved` after fixing the endpoint, or `declined` to cancel this delivery.',
    ].join('\n'),
    userId: item.escalationTarget?.recipient || 'operator',
    modality: 'push',
    expectedReturnKinds: ['approved', 'declined', 'timeout'],
    frameSnapshot: {
      url: 'hybridclaw://a2a/webhook-outbox',
      title: 'A2A webhook delivery failed',
    },
    context: {
      host: 'a2a.webhook',
      pageTitle: 'Webhook delivery failure',
    },
    skillId: 'a2a.webhook-outbound',
    escalationTarget: item.escalationTarget,
  });
  emitInteractionNeededEvent({ session, runId });
}

function failWebhookItem(
  item: WebhookOutboxItem,
  now: Date,
  reason: string,
  statusCode?: number,
): WebhookOutboxItem {
  const failed: WebhookOutboxItem = {
    ...item,
    status: 'failed',
    attempts: item.attempts + 1,
    updatedAt: nowIso(now),
    lastAttemptAt: nowIso(now),
    failedAt: nowIso(now),
    lastError: reason,
    ...(statusCode ? { lastStatusCode: statusCode } : {}),
  };
  persistOutboxItem(failed);
  recordWebhookAudit(failed, {
    type: 'a2a.webhook.delivery_failed',
    reason,
    statusCode: statusCode ?? null,
    envelope: summarizeA2AEnvelopeForAudit(failed.envelope),
    url: failed.url,
  });
  recordWebhookAudit(failed, {
    type: 'escalation.decision',
    action: 'a2a.webhook:deliver',
    proposedAction: 'deliver A2A envelope via webhook transport',
    escalationRoute: 'approval_request',
    target: failed.escalationTarget || null,
    stakes: 'high',
    classifier: 'a2a.webhook-outbound',
    classifierReasoning: [reason],
    approvalDecision: 'required',
    reason,
    envelope: summarizeA2AEnvelopeForAudit(failed.envelope),
  });
  createWebhookEscalation(failed, reason);
  return failed;
}

function retryWebhookItem(
  item: WebhookOutboxItem,
  now: Date,
  reason: string,
  options: Required<
    Pick<
      WebhookOutboxProcessOptions,
      'baseDelayMs' | 'maxDelayMs' | 'jitterRatio' | 'random'
    >
  >,
  statusCode?: number,
): WebhookOutboxItem {
  const attempts = item.attempts + 1;
  const exponentialDelay = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * 2 ** Math.max(0, attempts - 1),
  );
  const jitter = exponentialDelay * options.jitterRatio * options.random();
  const delayMs = Math.max(0, Math.trunc(exponentialDelay + jitter));
  const retry: WebhookOutboxItem = {
    ...item,
    attempts,
    updatedAt: nowIso(now),
    lastAttemptAt: nowIso(now),
    lastError: reason,
    nextAttemptAt: nowIso(new Date(now.getTime() + delayMs)),
    ...(statusCode ? { lastStatusCode: statusCode } : {}),
  };
  persistOutboxItem(retry);
  recordWebhookAudit(retry, {
    type: 'a2a.webhook.delivery_retry',
    reason,
    attempts,
    nextAttemptAt: retry.nextAttemptAt,
    statusCode: statusCode ?? null,
    envelope: summarizeA2AEnvelopeForAudit(retry.envelope),
    url: retry.url,
  });
  return retry;
}

async function deliverWebhookItem(
  item: WebhookOutboxItem,
  opts: WebhookOutboxProcessOptions,
): Promise<'delivered' | 'retried' | 'failed'> {
  const now = opts.now?.() ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attemptNumber = item.attempts + 1;
  const retryOptions = normalizeRetryOptions(opts);
  const maxAttempts = normalizePositiveInteger(
    opts.maxAttempts,
    item.maxAttempts,
  );
  let body: string;
  let signature: string;

  try {
    body = canonicalWebhookBody(item.envelope, item.version);
    const secret = resolveWebhookSecret(item);
    signature = signWebhookBody({
      body,
      secret,
      timestampSeconds: Math.trunc(now.getTime() / 1000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failWebhookItem(item, now, reason);
    return 'failed';
  }

  let response: Response;
  try {
    response = await fetchImpl(item.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [item.signatureHeader]: signature,
      },
      body,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (attemptNumber >= maxAttempts) {
      failWebhookItem(item, now, reason);
      return 'failed';
    }
    retryWebhookItem(item, now, reason, retryOptions);
    return 'retried';
  }

  if (response.status >= 200 && response.status < 300) {
    const delivered: WebhookOutboxItem = {
      ...item,
      status: 'delivered',
      attempts: attemptNumber,
      updatedAt: nowIso(now),
      lastAttemptAt: nowIso(now),
      deliveredAt: nowIso(now),
      lastStatusCode: response.status,
      lastError: undefined,
    };
    persistOutboxItem(delivered);
    recordWebhookAudit(delivered, {
      type: 'a2a.webhook.delivered',
      statusCode: response.status,
      attempts: attemptNumber,
      envelope: summarizeA2AEnvelopeForAudit(delivered.envelope),
      url: delivered.url,
    });
    return 'delivered';
  }

  const reason = `HTTP ${response.status}`;
  if (response.status >= 400 && response.status < 500) {
    failWebhookItem(item, now, reason, response.status);
    return 'failed';
  }

  if (attemptNumber >= maxAttempts) {
    failWebhookItem(item, now, reason, response.status);
    return 'failed';
  }
  retryWebhookItem(item, now, reason, retryOptions, response.status);
  return 'retried';
}

function normalizeRetryOptions(
  opts: WebhookOutboxProcessOptions,
): Required<
  Pick<
    WebhookOutboxProcessOptions,
    'baseDelayMs' | 'maxDelayMs' | 'jitterRatio' | 'random'
  >
> {
  return {
    baseDelayMs: normalizePositiveInteger(
      opts.baseDelayMs,
      WEBHOOK_RETRY_BASE_DELAY_MS,
    ),
    maxDelayMs: normalizePositiveInteger(
      opts.maxDelayMs,
      WEBHOOK_RETRY_MAX_DELAY_MS,
    ),
    jitterRatio: Math.max(0, opts.jitterRatio ?? 0.2),
    random: opts.random ?? Math.random,
  };
}

export async function processWebhookOutbox(
  opts: WebhookOutboxProcessOptions = {},
): Promise<WebhookOutboxProcessResult> {
  const now = opts.now?.() ?? new Date();
  const concurrency = normalizePositiveInteger(
    opts.concurrency,
    WEBHOOK_OUTBOX_CONCURRENCY,
  );
  const due = listWebhookOutboxItems().filter(
    (item) =>
      item.status === 'pending' &&
      Date.parse(item.nextAttemptAt) <= now.getTime(),
  );
  const result: WebhookOutboxProcessResult = {
    processed: 0,
    delivered: 0,
    retried: 0,
    failed: 0,
  };

  for (let index = 0; index < due.length; index += concurrency) {
    const batch = due.slice(index, index + concurrency);
    result.processed += batch.length;
    const outcomes = await Promise.allSettled(
      batch.map((item) => deliverWebhookItem(item, opts)),
    );
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') {
        result[outcome.value] += 1;
      } else {
        result.failed += 1;
        logger.warn(
          { err: outcome.reason },
          'A2A webhook outbox delivery rejected unexpectedly',
        );
      }
    }
  }

  return result;
}

async function drainWebhookOutbox(
  source: 'startup' | 'interval',
): Promise<void> {
  if (webhookOutboxProcessorRunning) {
    logger.debug(
      { source },
      'A2A webhook outbox drain skipped because a previous drain is still running',
    );
    return;
  }

  webhookOutboxProcessorRunning = true;
  try {
    const result = await processWebhookOutbox();
    if (result.processed > 0) {
      logger.info({ source, ...result }, 'A2A webhook outbox drained');
    }
  } catch (error) {
    logger.warn({ source, error }, 'A2A webhook outbox drain failed');
  } finally {
    webhookOutboxProcessorRunning = false;
  }
}

export function startWebhookOutboxProcessor(
  intervalMs = WEBHOOK_OUTBOX_DRAIN_INTERVAL_MS,
): void {
  stopWebhookOutboxProcessor();
  const normalizedIntervalMs = normalizePositiveInteger(
    intervalMs,
    WEBHOOK_OUTBOX_DRAIN_INTERVAL_MS,
  );
  void drainWebhookOutbox('startup');
  webhookOutboxProcessorTimer = setInterval(() => {
    void drainWebhookOutbox('interval');
  }, normalizedIntervalMs);
  logger.info(
    { intervalMs: normalizedIntervalMs },
    'A2A webhook outbox processor started',
  );
}

export function stopWebhookOutboxProcessor(): void {
  if (webhookOutboxProcessorTimer) {
    clearInterval(webhookOutboxProcessorTimer);
    webhookOutboxProcessorTimer = null;
    logger.info('A2A webhook outbox processor stopped');
  }
  webhookOutboxProcessorRunning = false;
}

export class WebhookOutboundAdapter
  implements TransportAdapter<WebhookOutboxItem>
{
  readonly transport = 'webhook' as const;

  constructor(private readonly opts: WebhookOutboundAdapterOptions = {}) {}

  encode(
    envelope: A2AEnvelope,
    descriptor?: WebhookPeerDescriptor,
    context?: TransportAdapterContext,
  ): WebhookOutboxItem {
    if (!descriptor || descriptor.transport !== 'webhook') {
      const receivedTransport = descriptor?.transport ?? 'undefined';
      throw new Error(
        `WebhookOutboundAdapter requires a webhook descriptor; received "${receivedTransport}".`,
      );
    }
    const item = enqueueWebhookEnvelope(
      envelope,
      descriptor,
      context,
      this.opts,
    );
    if (this.opts.autoProcess !== false) {
      void processWebhookOutbox().catch((error) => {
        logger.warn({ err: error }, 'Failed to process A2A webhook outbox');
      });
    }
    return item;
  }

  decode(): A2AEnvelope {
    throw new Error(
      'Webhook outbound adapter does not decode inbound payloads.',
    );
  }
}

export const webhookOutboundAdapter = new WebhookOutboundAdapter();
