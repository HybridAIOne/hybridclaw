/**
 * Async buffered token-usage recording.
 *
 * Producer-consumer pipeline that decouples model invocations from the
 * synchronous chargeback/SQLite write path. Producers call
 * {@link enqueueTokenUsage} from the request hot-path; a periodic flush
 * task drains the queue, batches inserts into a single SQLite transaction,
 * and emits a `usage.batch_flushed` event onto the existing tamper-evident
 * audit hash-chain so the chargeback feed remains attestable.
 *
 * Inspired by CoPaw PR #3766 (asynchronous buffered token usage recording).
 *
 * Integration points:
 *   - {@link recordUsageEventBatch} — batched SQLite writer
 *   - {@link recordAuditEvent}      — appends to the per-session hash chain
 *   - hybridai chargeback consumes the populated `usage_events` table.
 */

import { createHash } from 'node:crypto';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { logger } from '../logger.js';
import { recordUsageEventBatch } from '../memory/db.js';

export interface TokenUsageEvent {
  sessionId: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  toolCalls?: number;
  costUsd?: number;
  /** ISO-8601 timestamp; auto-generated if omitted. */
  timestamp?: string;
  /** Optional run/parent context to thread the batch audit event. */
  auditRunId?: string;
  auditParentRunId?: string;
}

export interface StartTokenUsageBufferOptions {
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxQueueSize?: number;
}

export interface TokenUsageBufferStats {
  started: boolean;
  queueSize: number;
  flushIntervalMs: number;
  maxBatchSize: number;
  maxQueueSize: number;
  totalEnqueued: number;
  totalFlushed: number;
  totalDropped: number;
  flushCount: number;
  lastFlushAt: string | null;
  lastError: string | null;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const MIN_FLUSH_INTERVAL_MS = 250;

interface BufferState {
  queue: TokenUsageEvent[];
  flushTimer: NodeJS.Timeout | null;
  flushIntervalMs: number;
  maxBatchSize: number;
  maxQueueSize: number;
  inFlight: Promise<void> | null;
  totalEnqueued: number;
  totalFlushed: number;
  totalDropped: number;
  flushCount: number;
  lastFlushAt: string | null;
  lastError: string | null;
  started: boolean;
}

const state: BufferState = {
  queue: [],
  flushTimer: null,
  flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
  maxBatchSize: DEFAULT_MAX_BATCH_SIZE,
  maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
  inFlight: null,
  totalEnqueued: 0,
  totalFlushed: 0,
  totalDropped: 0,
  flushCount: 0,
  lastFlushAt: null,
  lastError: null,
  started: false,
};

/**
 * Start the periodic flush timer. Idempotent; subsequent calls are no-ops
 * unless {@link stopTokenUsageBuffer} is invoked first.
 */
export function startTokenUsageBuffer(
  opts?: StartTokenUsageBufferOptions,
): void {
  if (state.started) return;

  state.flushIntervalMs = Math.max(
    MIN_FLUSH_INTERVAL_MS,
    opts?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
  );
  state.maxBatchSize = Math.max(
    1,
    opts?.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
  );
  state.maxQueueSize = Math.max(
    1,
    opts?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
  );

  state.flushTimer = setInterval(() => {
    void flushTokenUsageBuffer().catch((err) => {
      logger.warn({ err }, 'token_usage: periodic flush failed');
    });
  }, state.flushIntervalMs);
  // Don't keep the event loop alive solely for the flush ticker.
  if (typeof state.flushTimer.unref === 'function') {
    state.flushTimer.unref();
  }
  state.started = true;
  logger.info(
    {
      flushIntervalMs: state.flushIntervalMs,
      maxBatchSize: state.maxBatchSize,
      maxQueueSize: state.maxQueueSize,
    },
    'Token usage buffer started',
  );
}

/**
 * Stop the periodic flush timer and drain any remaining events. Safe to
 * call from process shutdown handlers — performs a final synchronous-ish
 * flush so chargeback never loses an in-flight event.
 */
export async function stopTokenUsageBuffer(): Promise<void> {
  if (state.flushTimer) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }
  state.started = false;
  // Drain any in-flight flush before triggering the final one.
  if (state.inFlight) {
    try {
      await state.inFlight;
    } catch {
      // Already logged inside flushTokenUsageBuffer.
    }
  }
  if (state.queue.length > 0) {
    try {
      await flushTokenUsageBuffer({ force: true });
    } catch (err) {
      logger.warn({ err }, 'token_usage: final flush failed');
    }
  }
  logger.info(
    {
      totalEnqueued: state.totalEnqueued,
      totalFlushed: state.totalFlushed,
      totalDropped: state.totalDropped,
    },
    'Token usage buffer stopped',
  );
}

/**
 * Reset all state. Test-only — not exported via the package barrel.
 */
export function _resetTokenUsageBufferForTests(): void {
  if (state.flushTimer) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }
  state.queue = [];
  state.inFlight = null;
  state.totalEnqueued = 0;
  state.totalFlushed = 0;
  state.totalDropped = 0;
  state.flushCount = 0;
  state.lastFlushAt = null;
  state.lastError = null;
  state.started = false;
  state.flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
  state.maxBatchSize = DEFAULT_MAX_BATCH_SIZE;
  state.maxQueueSize = DEFAULT_MAX_QUEUE_SIZE;
}

/**
 * Enqueue a usage event. Synchronous and bounded — never blocks the caller.
 *
 * If the queue is at capacity, the event is dropped and a warning is logged.
 * If enqueuing pushes the queue at or above {@link state.maxBatchSize}, an
 * opportunistic flush is scheduled (without awaiting) so callers don't pay
 * the disk-write cost.
 */
export function enqueueTokenUsage(event: TokenUsageEvent): void {
  if (!event.sessionId?.trim() || !event.agentId?.trim()) {
    // Match recordUsageEvent's silent ignore for invalid inputs.
    return;
  }
  if (state.queue.length >= state.maxQueueSize) {
    state.totalDropped += 1;
    logger.warn(
      {
        queueSize: state.queue.length,
        maxQueueSize: state.maxQueueSize,
        sessionId: event.sessionId,
        model: event.model,
      },
      'token_usage: queue full, dropping event',
    );
    return;
  }

  state.queue.push({
    ...event,
    timestamp: event.timestamp || new Date().toISOString(),
  });
  state.totalEnqueued += 1;

  if (state.queue.length >= state.maxBatchSize) {
    void flushTokenUsageBuffer().catch((err) => {
      logger.warn({ err }, 'token_usage: opportunistic flush failed');
    });
  }
}

/**
 * Drain queued events to the SQLite chargeback table and emit one
 * `usage.batch_flushed` audit event per affected session, anchoring the
 * batch into the hash chain.
 *
 * Concurrent calls are serialized — the second caller awaits the first
 * (and re-flushes only if `force` is set, to ensure post-shutdown drains
 * always run).
 */
export async function flushTokenUsageBuffer(opts?: {
  force?: boolean;
}): Promise<void> {
  if (state.inFlight) {
    try {
      await state.inFlight;
    } catch {
      // The first caller already logged.
    }
    if (!opts?.force) return;
  }
  if (state.queue.length === 0) return;

  const flushPromise = (async () => {
    const batch = state.queue.splice(0, state.queue.length);
    try {
      recordUsageEventBatch(batch);
      state.totalFlushed += batch.length;
      state.flushCount += 1;
      state.lastFlushAt = new Date().toISOString();
      state.lastError = null;
      emitBatchAuditEvents(batch);
    } catch (err) {
      // Re-queue the events at the head so we don't lose them. Bound the
      // re-queue to maxQueueSize so a persistently failing DB doesn't
      // unbounded-grow memory.
      const requeueCount = Math.min(
        batch.length,
        Math.max(0, state.maxQueueSize - state.queue.length),
      );
      if (requeueCount > 0) {
        state.queue.unshift(...batch.slice(0, requeueCount));
      }
      const dropped = batch.length - requeueCount;
      if (dropped > 0) state.totalDropped += dropped;
      state.lastError = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          err,
          batchSize: batch.length,
          requeued: requeueCount,
          dropped,
        },
        'token_usage: failed to flush batch to chargeback',
      );
      throw err;
    }
  })();

  state.inFlight = flushPromise;
  try {
    await flushPromise;
  } finally {
    state.inFlight = null;
  }
}

function emitBatchAuditEvents(batch: TokenUsageEvent[]): void {
  // Group by session so each affected session's hash chain gets its own
  // batch attestation.
  const bySession = new Map<string, TokenUsageEvent[]>();
  for (const event of batch) {
    const key = event.sessionId;
    const list = bySession.get(key);
    if (list) {
      list.push(event);
    } else {
      bySession.set(key, [event]);
    }
  }

  for (const [sessionId, events] of bySession) {
    const inputTokens = sumInt(events, (e) => e.inputTokens);
    const outputTokens = sumInt(events, (e) => e.outputTokens);
    const declaredTotal = sumInt(events, (e) => e.totalTokens ?? 0);
    const totalTokens = declaredTotal || inputTokens + outputTokens;
    const toolCalls = sumInt(events, (e) => e.toolCalls ?? 0);
    const costUsd = events.reduce((acc, e) => acc + (e.costUsd ?? 0), 0);
    const batchHash = computeBatchHash(events);
    const models = Array.from(new Set(events.map((e) => e.model))).sort();
    const agents = Array.from(new Set(events.map((e) => e.agentId))).sort();
    const runId = events[0]?.auditRunId || makeAuditRunId('usage-batch');
    const parentRunId = events[0]?.auditParentRunId;

    try {
      recordAuditEvent({
        sessionId,
        runId,
        parentRunId,
        event: {
          type: 'usage.batch_flushed',
          eventCount: events.length,
          inputTokens,
          outputTokens,
          totalTokens,
          toolCalls,
          costUsd,
          batchHash,
          models,
          agents,
        },
      });
    } catch (err) {
      // Audit-trail failures must never break the chargeback path.
      logger.warn(
        { err, sessionId, batchSize: events.length },
        'token_usage: failed to append batch audit event',
      );
    }
  }
}

function sumInt(
  events: TokenUsageEvent[],
  pick: (e: TokenUsageEvent) => number | undefined,
): number {
  let total = 0;
  for (const event of events) {
    const value = pick(event);
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      total += Math.floor(value);
    }
  }
  return total;
}

function computeBatchHash(events: TokenUsageEvent[]): string {
  // Deterministic, order-sensitive hash of the batch payload — enough to
  // detect tampering between the buffer flush and the SQLite write.
  const lines = events.map((e) =>
    [
      e.sessionId,
      e.agentId,
      e.model,
      e.inputTokens ?? 0,
      e.outputTokens ?? 0,
      e.totalTokens ?? 0,
      e.toolCalls ?? 0,
      e.costUsd ?? 0,
      e.timestamp ?? '',
    ].join('|'),
  );
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export function getTokenUsageBufferStats(): TokenUsageBufferStats {
  return {
    started: state.started,
    queueSize: state.queue.length,
    flushIntervalMs: state.flushIntervalMs,
    maxBatchSize: state.maxBatchSize,
    maxQueueSize: state.maxQueueSize,
    totalEnqueued: state.totalEnqueued,
    totalFlushed: state.totalFlushed,
    totalDropped: state.totalDropped,
    flushCount: state.flushCount,
    lastFlushAt: state.lastFlushAt,
    lastError: state.lastError,
  };
}
