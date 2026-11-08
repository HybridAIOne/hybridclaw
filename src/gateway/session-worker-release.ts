/**
 * Per-session gateway turn queue, and the worker release that waits on it.
 * Stored IDs and keys of one session share its stored-session queue.
 *
 * `releaseSessionWorker` queues behind every turn already running or queued
 * for the session, so a finished conversation (a hung-up call) frees its
 * agent worker without cutting off a reply that is still being stored or
 * sent. It stops the worker through the same executor path as `/stop`.
 *
 * NOT an interrupt: `interruptGatewaySessionExecution` aborts the running
 * turn; this never does. A turn queued after the release starts a new worker.
 */
import { stopSessionExecution } from '../agent/executor.js';
import { getSessionById } from '../memory/db.js';
import { KeyedSerialQueue } from '../utils/keyed-serial-queue.js';

class SessionQueue extends KeyedSerialQueue {
  override run<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    return super.run(getSessionById(sessionId)?.id || sessionId, task);
  }
}

export const gatewaySessionQueue = new SessionQueue();

/** True when a worker was stopped; a session without one is a no-op. */
export function releaseSessionWorker(sessionId: string): Promise<boolean> {
  return gatewaySessionQueue.run(sessionId, async () =>
    stopSessionExecution(getSessionById(sessionId)?.id || sessionId),
  );
}
