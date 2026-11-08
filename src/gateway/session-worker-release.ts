/**
 * Turns hold their admission key and every stored session they execute in.
 * Resolving an alias cannot bypass active work; replacement instances remain
 * independent. Unlike interruption, release waits and pins its known worker ID.
 */
import { stopSessionExecution } from '../agent/executor.js';
import { getSessionById } from '../memory/db.js';
import { KeyedSerialQueue } from '../utils/keyed-serial-queue.js';

export type BindSessionQueue = (sessionId: string) => Promise<void>;

class SessionQueue {
  private readonly queue = new KeyedSerialQueue();

  run<T>(
    sessionId: string,
    task: (bind: BindSessionQueue) => Promise<T>,
  ): Promise<T> {
    const key = getSessionById(sessionId)?.id || sessionId;
    return this.queue.run(key, async () => {
      const leases = new Map<string, Promise<() => void>>();
      const bind: BindSessionQueue = async (storedId) => {
        if (storedId === key) return;
        let lease = leases.get(storedId);
        if (!lease) {
          lease = this.queue.acquire(storedId);
          leases.set(storedId, lease);
        }
        await lease;
      };
      try {
        return await task(bind);
      } finally {
        for (const lease of leases.values()) (await lease)();
      }
    });
  }
}

export const gatewaySessionQueue = new SessionQueue();

/** True when a worker was stopped; a session without one is a no-op. */
export function releaseSessionWorker(sessionId: string): Promise<boolean> {
  const storedId = getSessionById(sessionId)?.id;
  return gatewaySessionQueue.run(storedId || sessionId, async () =>
    stopSessionExecution(
      storedId || getSessionById(sessionId)?.id || sessionId,
    ),
  );
}
