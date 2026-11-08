/**
 * A queue flush owns background delivery until every selected row settles.
 * Dispatch handles channel policy; this module only drains durable rows.
 * It cannot promise exactly-once delivery across a process crash.
 */
import { isWithinActiveHours } from '../agent/proactive-policy.js';
import { logger } from '../logger.js';
import {
  deleteQueuedProactiveMessage,
  getFailedProactiveMessageCount,
  getQueuedProactiveMessageCount,
  listQueuedProactiveMessages,
  markQueuedProactiveMessageFailed,
  pruneFailedProactiveMessages,
} from '../memory/db.js';
import {
  hasImmediateProactiveDeliveryPath,
  shouldDropQueuedProactiveMessage,
} from './proactive-delivery.js';
import {
  MAX_QUEUED_PROACTIVE_MESSAGES,
  sendProactiveMessageNow,
} from './proactive-dispatch.js';

let flushing = false;
export async function flushQueuedProactiveMessages(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    await flushQueue();
  } finally {
    flushing = false;
  }
}

async function flushQueue(): Promise<void> {
  if (!isWithinActiveHours()) return;
  const pending = listQueuedProactiveMessages(MAX_QUEUED_PROACTIVE_MESSAGES);
  if (pending.length === 0) return;
  logger.info(
    { flushing: pending.length, queued: getQueuedProactiveMessageCount() },
    'Flushing queued proactive messages',
  );

  pruneFailedProactiveMessages();
  let failedUndeliverable = 0;
  for (const item of pending) {
    if (!isWithinActiveHours()) break;
    if (shouldDropQueuedProactiveMessage(item)) {
      markQueuedProactiveMessageFailed(
        item.id,
        `No proactive delivery path for channel "${item.channel_id}"`,
      );
      failedUndeliverable += 1;
      continue;
    }
    if (!hasImmediateProactiveDeliveryPath(item)) {
      continue;
    }
    const outcome = await sendProactiveMessageNow(
      item.channel_id,
      item.text,
      `${item.source}:queued`,
    );
    if (outcome.status === 'failed') {
      markQueuedProactiveMessageFailed(
        item.id,
        outcome.reason || 'Delivery failed',
      );
      failedUndeliverable += 1;
      continue;
    }
    deleteQueuedProactiveMessage(item.id);
  }

  if (failedUndeliverable > 0) {
    logger.warn(
      {
        failed: failedUndeliverable,
        totalFailed: getFailedProactiveMessageCount(),
      },
      'Queued proactive messages marked as failed (undeliverable)',
    );
  }
}
