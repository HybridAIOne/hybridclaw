import { logger } from '../logger.js';
import {
  type A2AOutboxProcessOptions,
  deliverA2AItem,
} from './a2a-outbox-delivery.js';
import { listA2AOutboxItems } from './a2a-outbox-persistence.js';
import { normalizePositiveInteger } from './utils.js';

export const A2A_OUTBOX_CONCURRENCY = 4;
export const A2A_OUTBOX_DRAIN_INTERVAL_MS = 5_000;

export interface A2AOutboxProcessResult {
  processed: number;
  delivered: number;
  retried: number;
  failed: number;
}

let a2aOutboxProcessorTimer: ReturnType<typeof setInterval> | null = null;
let a2aOutboxProcessorRunning = false;

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
