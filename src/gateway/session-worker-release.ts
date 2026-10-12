/**
 * Per-session gateway turn queue, and the worker release that waits on it.
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
import { KeyedSerialQueue } from '../utils/keyed-serial-queue.js';

export const gatewaySessionQueue = new KeyedSerialQueue();

/** True when a worker was stopped; a session without one is a no-op. */
export function releaseSessionWorker(sessionId: string): Promise<boolean> {
  return gatewaySessionQueue.run(sessionId, async () =>
    stopSessionExecution(sessionId),
  );
}
