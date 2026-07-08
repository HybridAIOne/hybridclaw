import { resolveAgentEscalationTarget } from '../agents/agent-registry.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { parseAgentIdentity } from '../identity/agent-id.js';
import { logger } from '../logger.js';
import { buildSessionKey } from '../session/session-key.js';
import type { AddressEnvelope } from '../types/container.js';
import {
  type A2AInboxDispatchItem,
  getA2AInboxDispatchItem,
  listA2AInboxDispatchItems,
  persistA2AInboxDispatchItem,
} from './a2a-inbox-dispatch-store.js';
import { getA2AAuditSessionId, recordA2AMessageAudit } from './audit.js';
import {
  type A2AEnvelope,
  createA2AEnvelope,
  summarizeA2AEnvelopeForAudit,
} from './envelope.js';
import { isLocalA2AAgentId, resolveLocalA2AAgentId } from './identity.js';
import { normalizePositiveInteger } from './utils.js';

export const A2A_INBOX_DISPATCH_CONCURRENCY = 2;
export const A2A_INBOX_DISPATCH_DRAIN_INTERVAL_MS = 5_000;
export const A2A_INBOX_DISPATCH_RETRY_BASE_DELAY_MS = 1_000;
export const A2A_INBOX_DISPATCH_RETRY_MAX_DELAY_MS = 5 * 60_000;
export const A2A_INBOX_DISPATCH_LOOP_WINDOW_MS = 60_000;
export const A2A_INBOX_DISPATCH_LOOP_MAX_PER_THREAD = 20;

export interface A2AInboxDispatchInvocation {
  item: A2AInboxDispatchItem;
  envelope: A2AEnvelope;
  agentId: string;
  sessionId: string;
  channelId: 'a2a';
  userId: string;
  username: string;
  source: 'a2a.dispatch';
  content: string;
  addressEnvelope: AddressEnvelope;
}

export type A2AInboxDispatchHandlerResult =
  | { status: 'success'; result?: string | null }
  | { status: 'error'; error?: string | null };

export type A2AInboxDispatchHandler = (
  invocation: A2AInboxDispatchInvocation,
) => Promise<A2AInboxDispatchHandlerResult | undefined>;

export interface A2AInboxDispatchProcessOptions {
  dispatch: A2AInboxDispatchHandler;
  now?: () => Date;
  concurrency?: number;
  loopWindowMs?: number;
  loopMaxPerThread?: number;
}

export interface A2AInboxDispatchProcessResult {
  processed: number;
  dispatched: number;
  ignored: number;
  suppressed: number;
  retried: number;
  failed: number;
}

type DispatchOutcome =
  | 'dispatched'
  | 'ignored'
  | 'suppressed'
  | 'retried'
  | 'failed'
  | 'skipped';

let a2aInboxDispatchProcessorTimer: ReturnType<typeof setInterval> | null =
  null;
let a2aInboxDispatchProcessorRunning = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampErrorMessage(error: unknown): string {
  return errorMessage(error).slice(0, 2_000);
}

function recordDispatchAudit(params: {
  item: A2AInboxDispatchItem;
  eventType:
    | 'a2a.dispatch.start'
    | 'a2a.dispatch.success'
    | 'a2a.dispatch.retry'
    | 'a2a.dispatch.failed'
    | 'a2a.dispatch.ignored'
    | 'a2a.dispatch.suppressed';
  dispatchRunId?: string;
  dispatchSessionId?: string;
  agentId?: string;
  reason?: string;
  attempts?: number;
  nextAttemptAt?: string;
}): void {
  let actor: { type: 'agent'; id: string } | undefined;
  try {
    actor = {
      type: 'agent',
      id: parseAgentIdentity(params.item.envelope.sender_agent_id).id,
    };
  } catch {
    actor = undefined;
  }

  recordAuditEvent({
    sessionId:
      params.dispatchSessionId ||
      params.item.dispatchSessionId ||
      params.item.sessionId ||
      getA2AAuditSessionId(params.item.envelope),
    runId:
      params.dispatchRunId ||
      params.item.dispatchRunId ||
      params.item.runId ||
      makeAuditRunId('a2a-dispatch'),
    event: {
      type: params.eventType,
      ...(actor ? { actor } : {}),
      dispatchId: params.item.id,
      recipientAgentId: params.item.envelope.recipient_agent_id,
      recipientLocalAgentId: params.agentId ?? null,
      attempts: params.attempts ?? params.item.attempts,
      ...(params.nextAttemptAt ? { nextAttemptAt: params.nextAttemptAt } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
      envelope: summarizeA2AEnvelopeForAudit(params.item.envelope),
    },
  });
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(
    A2A_INBOX_DISPATCH_RETRY_BASE_DELAY_MS * 2 ** exponent,
    A2A_INBOX_DISPATCH_RETRY_MAX_DELAY_MS,
  );
}

function dueAtOrBefore(item: A2AInboxDispatchItem, now: Date): boolean {
  const dueAt = Date.parse(item.nextAttemptAt);
  return Number.isNaN(dueAt) || dueAt <= now.getTime();
}

function resolveLocalRecipientAgentId(
  envelope: A2AEnvelope,
): { agentId: string } | { reason: string } {
  try {
    parseAgentIdentity(envelope.recipient_agent_id);
  } catch (error) {
    return { reason: errorMessage(error) };
  }
  const agentId = resolveLocalA2AAgentId(envelope.recipient_agent_id);
  if (agentId) return { agentId };

  if (!isLocalA2AAgentId(envelope.recipient_agent_id)) {
    return {
      reason: 'recipient_agent_id instance-id does not match this instance',
    };
  }

  return { reason: 'recipient_agent_id does not resolve to a local agent' };
}

function buildA2ADispatchSessionId(params: {
  agentId: string;
  envelope: A2AEnvelope;
}): string {
  return buildSessionKey(
    params.agentId,
    'a2a',
    'thread',
    params.envelope.sender_agent_id,
    { threadId: params.envelope.thread_id },
  );
}

export function buildA2AInboxDispatchPrompt(envelope: A2AEnvelope): string {
  return [
    'You received an A2A message addressed to you.',
    '',
    `Intent: ${envelope.intent}`,
    `Sender: ${envelope.sender_agent_id}`,
    `Recipient: ${envelope.recipient_agent_id}`,
    `Thread: ${envelope.thread_id}`,
    `Message ID: ${envelope.id}`,
    envelope.parent_message_id
      ? `Parent message ID: ${envelope.parent_message_id}`
      : '',
    '',
    'Handle this as the addressed agent. For handoffs, take ownership of the work. For escalations, treat it as urgent. For chat, respond or act on the request.',
    '',
    envelope.content,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function buildDispatchInvocation(params: {
  item: A2AInboxDispatchItem;
  agentId: string;
}): A2AInboxDispatchInvocation {
  const sessionId = buildA2ADispatchSessionId({
    agentId: params.agentId,
    envelope: params.item.envelope,
  });
  return {
    item: params.item,
    envelope: params.item.envelope,
    agentId: params.agentId,
    sessionId,
    channelId: 'a2a',
    userId: params.item.envelope.sender_agent_id,
    username: params.item.envelope.sender_agent_id,
    source: 'a2a.dispatch',
    content: buildA2AInboxDispatchPrompt(params.item.envelope),
    addressEnvelope: {
      to: params.agentId,
      from: params.item.envelope.sender_agent_id,
    },
  };
}

function recentDispatchedThreadCount(params: {
  item: A2AInboxDispatchItem;
  now: Date;
  windowMs: number;
}): number {
  const cutoff = params.now.getTime() - params.windowMs;
  return listA2AInboxDispatchItems({
    threadId: params.item.envelope.thread_id,
    status: ['running', 'succeeded'],
  }).filter((entry) => {
    if (entry.id === params.item.id) return false;
    const timestamp = Date.parse(
      entry.startedAt || entry.completedAt || entry.updatedAt,
    );
    return !Number.isNaN(timestamp) && timestamp >= cutoff;
  }).length;
}

function shouldSuppressLoop(params: {
  item: A2AInboxDispatchItem;
  now: Date;
  loopWindowMs: number;
  loopMaxPerThread: number;
}): boolean {
  if (params.loopMaxPerThread < 1) return true;
  return (
    recentDispatchedThreadCount({
      item: params.item,
      now: params.now,
      windowMs: params.loopWindowMs,
    }) >= params.loopMaxPerThread
  );
}

function markTerminal(params: {
  item: A2AInboxDispatchItem;
  status: 'ignored' | 'suppressed' | 'failed';
  now: Date;
  reason: string;
  agentId?: string;
}): DispatchOutcome {
  const timestamp = params.now.toISOString();
  const next: A2AInboxDispatchItem = {
    ...params.item,
    status: params.status,
    updatedAt: timestamp,
    nextAttemptAt: timestamp,
    lastError: params.reason,
    ...(params.status === 'ignored' ? { ignoredAt: timestamp } : {}),
    ...(params.status === 'suppressed' ? { suppressedAt: timestamp } : {}),
    ...(params.status === 'failed' ? { failedAt: timestamp } : {}),
  };
  persistA2AInboxDispatchItem(next);
  recordDispatchAudit({
    item: next,
    eventType:
      params.status === 'ignored'
        ? 'a2a.dispatch.ignored'
        : params.status === 'suppressed'
          ? 'a2a.dispatch.suppressed'
          : 'a2a.dispatch.failed',
    agentId: params.agentId,
    reason: params.reason,
  });
  return params.status === 'ignored'
    ? 'ignored'
    : params.status === 'suppressed'
      ? 'suppressed'
      : 'failed';
}

/**
 * Send the addressed agent's response back to the original sender as an
 * outbound A2A message on the same thread, so a remote chat sees the reply
 * (store-and-forward, not live streaming).
 *
 * Guards keep any agent<->agent exchange bounded: we only reply to `chat`
 * intents, only when the agent produced text, and never to a message that is
 * itself a reply (`parent_message_id` set). That caps a symmetric two-agent
 * conversation at one round trip, in addition to the per-thread loop budget.
 */
async function enqueueA2AReply(params: {
  inbound: A2AEnvelope;
  recipientLocalAgentId: string;
  replyText: string | null | undefined;
  dispatchRunId: string;
  dispatchSessionId: string;
}): Promise<void> {
  const text = params.replyText?.trim();
  if (!text) return;
  if (params.inbound.intent !== 'chat') return;
  if (params.inbound.parent_message_id) return;

  try {
    // Imported lazily so the reply path stays a runtime side-effect rather than
    // pulling the transport registry into the dispatcher's static import graph
    // (which callers like the gateway load eagerly).
    const { sendMessage } = await import('./runtime.js');
    const replyEnvelope = createA2AEnvelope({
      sender_agent_id: params.inbound.recipient_agent_id,
      recipient_agent_id: params.inbound.sender_agent_id,
      thread_id: params.inbound.thread_id,
      intent: 'chat',
      content: text,
      parent_message_id: params.inbound.id,
    });
    const confirmation = sendMessage(replyEnvelope, {
      actor: params.inbound.recipient_agent_id,
      auditRole: 'sender',
      sessionId: params.dispatchSessionId,
      auditRunId: params.dispatchRunId,
      peerDescriptor: {
        transport: 'a2a',
        canonicalId: params.inbound.sender_agent_id,
      },
      escalationTarget: resolveAgentEscalationTarget(
        params.recipientLocalAgentId,
      ),
    });
    if (confirmation.delivered === false) {
      logger.warn(
        {
          reason: confirmation.failure_reason,
          threadId: params.inbound.thread_id,
          recipient: params.inbound.sender_agent_id,
        },
        'A2A reply-back could not be delivered',
      );
      return;
    }
    logger.info(
      {
        messageId: confirmation.message_id,
        threadId: confirmation.thread_id,
        recipient: confirmation.recipient_agent_id,
      },
      'A2A reply-back enqueued',
    );
  } catch (error) {
    logger.warn(
      { err: error, threadId: params.inbound.thread_id },
      'Failed to enqueue A2A reply-back',
    );
  }
}

async function processA2AInboxDispatchItem(
  item: A2AInboxDispatchItem,
  opts: Required<
    Pick<
      A2AInboxDispatchProcessOptions,
      'dispatch' | 'loopWindowMs' | 'loopMaxPerThread'
    >
  > & { now: Date },
): Promise<DispatchOutcome> {
  const latest = getA2AInboxDispatchItem(item.id);
  if (!latest) {
    return 'skipped';
  }
  if (latest.status !== 'pending' || !dueAtOrBefore(latest, opts.now)) {
    return 'skipped';
  }

  if (latest.envelope.intent === 'ack') {
    return markTerminal({
      item: latest,
      status: 'ignored',
      now: opts.now,
      reason: 'ack envelopes are stored but not auto-dispatched',
    });
  }
  if (latest.envelope.intent === 'policy.update') {
    return markTerminal({
      item: latest,
      status: 'ignored',
      now: opts.now,
      reason: 'policy.update envelopes are handled by the policy pipeline',
    });
  }

  const recipient = resolveLocalRecipientAgentId(latest.envelope);
  if ('reason' in recipient) {
    return markTerminal({
      item: latest,
      status: 'failed',
      now: opts.now,
      reason: recipient.reason,
    });
  }

  if (
    shouldSuppressLoop({
      item: latest,
      now: opts.now,
      loopWindowMs: opts.loopWindowMs,
      loopMaxPerThread: opts.loopMaxPerThread,
    })
  ) {
    return markTerminal({
      item: latest,
      status: 'suppressed',
      now: opts.now,
      agentId: recipient.agentId,
      reason: 'A2A dispatch loop budget exceeded for this thread',
    });
  }

  const invocation = buildDispatchInvocation({
    item: latest,
    agentId: recipient.agentId,
  });
  const dispatchRunId = makeAuditRunId('a2a-dispatch');
  const startedAt = opts.now.toISOString();
  const running: A2AInboxDispatchItem = {
    ...latest,
    status: 'running',
    attempts: latest.attempts + 1,
    updatedAt: startedAt,
    startedAt,
    dispatchSessionId: invocation.sessionId,
    dispatchRunId,
  };
  persistA2AInboxDispatchItem(running);
  recordDispatchAudit({
    item: running,
    eventType: 'a2a.dispatch.start',
    dispatchRunId,
    dispatchSessionId: invocation.sessionId,
    agentId: recipient.agentId,
  });

  try {
    const result = await opts.dispatch({ ...invocation, item: running });
    if (result?.status === 'error') {
      throw new Error(result.error || 'A2A recipient agent returned an error');
    }
    const completedAt = new Date().toISOString();
    const succeeded: A2AInboxDispatchItem = {
      ...running,
      status: 'succeeded',
      updatedAt: completedAt,
      completedAt,
      nextAttemptAt: completedAt,
    };
    persistA2AInboxDispatchItem(succeeded);
    recordDispatchAudit({
      item: succeeded,
      eventType: 'a2a.dispatch.success',
      dispatchRunId,
      dispatchSessionId: invocation.sessionId,
      agentId: recipient.agentId,
    });
    recordA2AMessageAudit({
      type: 'a2a.deliver',
      envelope: succeeded.envelope,
      sessionId: invocation.sessionId,
      runId: dispatchRunId,
      actor: succeeded.envelope.sender_agent_id,
      route: 'a2a.inbox.dispatch',
      source: 'a2a-inbox-dispatcher',
      transport: 'internal',
      attempts: succeeded.attempts,
    });
    // Best-effort reply back to the sender; failures are logged inside and must
    // never fail the (already successful) dispatch.
    void enqueueA2AReply({
      inbound: succeeded.envelope,
      recipientLocalAgentId: recipient.agentId,
      replyText: result?.result,
      dispatchRunId,
      dispatchSessionId: invocation.sessionId,
    });
    return 'dispatched';
  } catch (error) {
    const reason = clampErrorMessage(error);
    const retry = running.attempts < running.maxAttempts;
    const finishedAt = new Date();
    const nextAttemptAt = retry
      ? new Date(finishedAt.getTime() + retryDelayMs(running.attempts))
      : finishedAt;
    const next: A2AInboxDispatchItem = {
      ...running,
      status: retry ? 'pending' : 'failed',
      updatedAt: finishedAt.toISOString(),
      nextAttemptAt: nextAttemptAt.toISOString(),
      lastError: reason,
      ...(retry ? {} : { failedAt: finishedAt.toISOString() }),
    };
    persistA2AInboxDispatchItem(next);
    recordDispatchAudit({
      item: next,
      eventType: retry ? 'a2a.dispatch.retry' : 'a2a.dispatch.failed',
      dispatchRunId,
      dispatchSessionId: invocation.sessionId,
      agentId: recipient.agentId,
      reason,
      attempts: next.attempts,
      nextAttemptAt: retry ? next.nextAttemptAt : undefined,
    });
    return retry ? 'retried' : 'failed';
  }
}

export async function processA2AInboxDispatchQueue(
  opts: A2AInboxDispatchProcessOptions,
): Promise<A2AInboxDispatchProcessResult> {
  const now = opts.now?.() ?? new Date();
  const concurrency = normalizePositiveInteger(
    opts.concurrency,
    A2A_INBOX_DISPATCH_CONCURRENCY,
  );
  const loopWindowMs = normalizePositiveInteger(
    opts.loopWindowMs,
    A2A_INBOX_DISPATCH_LOOP_WINDOW_MS,
  );
  const loopMaxPerThread =
    typeof opts.loopMaxPerThread === 'number' &&
    Number.isSafeInteger(opts.loopMaxPerThread) &&
    opts.loopMaxPerThread >= 0
      ? opts.loopMaxPerThread
      : A2A_INBOX_DISPATCH_LOOP_MAX_PER_THREAD;
  const due = listA2AInboxDispatchItems({ status: 'pending' }).filter((item) =>
    dueAtOrBefore(item, now),
  );
  const result: A2AInboxDispatchProcessResult = {
    processed: 0,
    dispatched: 0,
    ignored: 0,
    suppressed: 0,
    retried: 0,
    failed: 0,
  };

  for (let index = 0; index < due.length; index += concurrency) {
    const batch = due.slice(index, index + concurrency);
    result.processed += batch.length;
    const outcomes = await Promise.allSettled(
      batch.map((item) =>
        processA2AInboxDispatchItem(item, {
          dispatch: opts.dispatch,
          now,
          loopWindowMs,
          loopMaxPerThread,
        }),
      ),
    );
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') {
        if (outcome.value !== 'skipped') {
          result[outcome.value] += 1;
        }
      } else {
        result.failed += 1;
        logger.warn(
          { err: outcome.reason },
          'A2A inbox dispatch rejected unexpectedly',
        );
      }
    }
  }

  return result;
}

async function drainA2AInboxDispatch(
  source: 'startup' | 'interval',
  dispatch: A2AInboxDispatchHandler,
): Promise<void> {
  if (a2aInboxDispatchProcessorRunning) {
    logger.debug(
      { source },
      'A2A inbox dispatch drain skipped because a previous drain is still running',
    );
    return;
  }
  a2aInboxDispatchProcessorRunning = true;
  try {
    const result = await processA2AInboxDispatchQueue({ dispatch });
    if (result.processed > 0) {
      logger.info({ source, ...result }, 'A2A inbox dispatch queue drained');
    }
  } catch (error) {
    logger.warn({ source, error }, 'A2A inbox dispatch drain failed');
  } finally {
    a2aInboxDispatchProcessorRunning = false;
  }
}

export function startA2AInboxDispatchProcessor(
  dispatch: A2AInboxDispatchHandler,
  intervalMs = A2A_INBOX_DISPATCH_DRAIN_INTERVAL_MS,
): void {
  stopA2AInboxDispatchProcessor();
  const normalizedIntervalMs = normalizePositiveInteger(
    intervalMs,
    A2A_INBOX_DISPATCH_DRAIN_INTERVAL_MS,
  );
  void drainA2AInboxDispatch('startup', dispatch);
  a2aInboxDispatchProcessorTimer = setInterval(() => {
    void drainA2AInboxDispatch('interval', dispatch);
  }, normalizedIntervalMs);
  logger.info(
    { intervalMs: normalizedIntervalMs },
    'A2A inbox dispatch processor started',
  );
}

export function stopA2AInboxDispatchProcessor(): void {
  if (a2aInboxDispatchProcessorTimer) {
    clearInterval(a2aInboxDispatchProcessorTimer);
    a2aInboxDispatchProcessorTimer = null;
    logger.info('A2A inbox dispatch processor stopped');
  }
  a2aInboxDispatchProcessorRunning = false;
}
