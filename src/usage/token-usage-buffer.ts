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

import { createHash, randomUUID } from 'node:crypto';
import {
  makeAuditRunId,
  recordAuditEventStrict,
} from '../audit/audit-events.js';
import { logger } from '../logger.js';
import {
  normalizeUsageCost,
  normalizeUsageNumber,
  recordUsageEventBatch,
  resolveSessionIdCompat,
} from '../memory/db.js';

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
  totalEnqueued: number;
  totalFlushed: number;
  totalDropped: number;
  flushCount: number;
  lastFlushAt: string | null;
  lastError: string | null;
  started: boolean;
}

export interface TokenUsageBatchHashRow {
  sessionId: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  costUsd: number;
  timestamp: string;
  batchId: string;
}

interface PreparedUsageEvent extends TokenUsageBatchHashRow {
  id: string;
  auditRunId?: string;
  auditParentRunId?: string;
  batchHash: string;
}

interface PreparedUsageBatchGroup {
  sessionId: string;
  batchId: string;
  batchHash: string;
  events: PreparedUsageEvent[];
  auditRunId?: string;
  auditParentRunId?: string;
}

const state: BufferState = {
  queue: [],
  flushTimer: null,
  flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
  maxBatchSize: DEFAULT_MAX_BATCH_SIZE,
  maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
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
 * call from process shutdown handlers — performs a final flush so chargeback
 * never loses a queued event.
 */
export async function stopTokenUsageBuffer(): Promise<void> {
  if (state.flushTimer) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }
  state.started = false;
  if (state.queue.length > 0) {
    try {
      await flushTokenUsageBuffer();
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
 */
export async function flushTokenUsageBuffer(): Promise<void> {
  if (state.queue.length === 0) return;

  const batch = state.queue.splice(0, state.queue.length);
  try {
    const groups = prepareUsageBatchGroups(batch);
    emitBatchAuditEvents(groups);
    recordUsageEventBatch(
      groups.flatMap((group) =>
        group.events.map((event) => ({
          id: event.id,
          sessionId: event.sessionId,
          agentId: event.agentId,
          model: event.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
          toolCalls: event.toolCalls,
          costUsd: event.costUsd,
          timestamp: event.timestamp,
          batchId: event.batchId,
          batchHash: event.batchHash,
        })),
      ),
    );
    state.totalFlushed += batch.length;
    state.flushCount += 1;
    state.lastFlushAt = new Date().toISOString();
    state.lastError = null;
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
}

function usageBatchGroupKey(event: PreparedUsageEvent): string {
  return JSON.stringify([
    event.sessionId,
    event.auditRunId || '',
    event.auditParentRunId || '',
  ]);
}

function prepareUsageBatchGroups(
  batch: TokenUsageEvent[],
): PreparedUsageBatchGroup[] {
  const grouped = new Map<string, PreparedUsageEvent[]>();
  for (const event of batch) {
    const sessionId = resolveSessionIdCompat(event.sessionId.trim());
    const agentId = event.agentId.trim();
    if (!sessionId || !agentId) continue;
    const inputTokens = normalizeUsageNumber(event.inputTokens);
    const outputTokens = normalizeUsageNumber(event.outputTokens);
    const totalTokens = normalizeUsageNumber(
      event.totalTokens ?? inputTokens + outputTokens,
    );
    const prepared: PreparedUsageEvent = {
      id: randomUUID(),
      sessionId,
      agentId,
      model: event.model.trim() || 'unknown',
      inputTokens,
      outputTokens,
      totalTokens,
      toolCalls: normalizeUsageNumber(event.toolCalls),
      costUsd: normalizeUsageCost(event.costUsd),
      timestamp:
        typeof event.timestamp === 'string' && event.timestamp.trim()
          ? event.timestamp.trim()
          : new Date().toISOString(),
      batchId: '',
      batchHash: '',
      auditRunId: event.auditRunId,
      auditParentRunId: event.auditParentRunId,
    };
    const groupKey = usageBatchGroupKey(prepared);
    const list = grouped.get(groupKey);
    if (list) {
      list.push(prepared);
    } else {
      grouped.set(groupKey, [prepared]);
    }
  }

  const groups: PreparedUsageBatchGroup[] = [];
  for (const events of grouped.values()) {
    const batchId = makeUsageBatchId();
    for (const event of events) {
      event.batchId = batchId;
    }
    const batchHash = computeTokenUsageBatchHash(events);
    for (const event of events) {
      event.batchHash = batchHash;
    }
    groups.push({
      sessionId: events[0]?.sessionId || '',
      batchId,
      batchHash,
      events,
      auditRunId: events[0]?.auditRunId,
      auditParentRunId: events[0]?.auditParentRunId,
    });
  }
  return groups;
}

function emitBatchAuditEvents(groups: PreparedUsageBatchGroup[]): void {
  // Group by session so each affected session's hash chain gets its own
  // batch attestation.
  for (const group of groups) {
    const { batchHash, batchId, events, sessionId } = group;
    const inputTokens = sumInt(events, (e) => e.inputTokens);
    const outputTokens = sumInt(events, (e) => e.outputTokens);
    const totalTokens = sumInt(events, (e) => e.totalTokens);
    const toolCalls = sumInt(events, (e) => e.toolCalls ?? 0);
    const costUsd = events.reduce((acc, e) => acc + (e.costUsd ?? 0), 0);
    const models = Array.from(new Set(events.map((e) => e.model))).sort();
    const agents = Array.from(new Set(events.map((e) => e.agentId))).sort();
    const runId = group.auditRunId || makeAuditRunId('usage-batch');
    const parentRunId = group.auditParentRunId;

    recordAuditEventStrict({
      sessionId,
      runId,
      parentRunId,
      event: {
        type: 'usage.batch_flushed',
        batchId,
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

function makeUsageBatchId(): string {
  return `usage_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export function computeTokenUsageBatchHash(
  rows: TokenUsageBatchHashRow[],
): string {
  const canonicalRows = rows
    .map((row) => ({
      agentId: row.agentId,
      batchId: row.batchId,
      costUsd: row.costUsd,
      inputTokens: row.inputTokens,
      model: row.model,
      outputTokens: row.outputTokens,
      sessionId: row.sessionId,
      timestamp: row.timestamp,
      toolCalls: row.toolCalls,
      totalTokens: row.totalTokens,
    }))
    .sort(
      (a, b) =>
        [
          a.sessionId.localeCompare(b.sessionId),
          a.agentId.localeCompare(b.agentId),
          a.model.localeCompare(b.model),
          a.timestamp.localeCompare(b.timestamp),
          a.inputTokens - b.inputTokens,
          a.outputTokens - b.outputTokens,
          a.totalTokens - b.totalTokens,
          a.toolCalls - b.toolCalls,
          a.costUsd - b.costUsd,
          a.batchId.localeCompare(b.batchId),
        ].find((result) => result !== 0) ?? 0,
    );
  const payload = JSON.stringify(
    canonicalRows.map((row) => [
      row.sessionId,
      row.agentId,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.totalTokens,
      row.toolCalls,
      row.costUsd,
      row.timestamp,
      row.batchId,
    ]),
  );
  return createHash('sha256').update(payload).digest('hex');
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
