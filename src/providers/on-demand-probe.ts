import { logger } from '../logger.js';

export interface OnDemandProbe<T> {
  /** Async — returns cached value if fresh, otherwise probes and caches. Concurrent calls coalesce. */
  get(): Promise<T>;
  /** Sync — returns last cached value or null. Never triggers a probe. */
  peek(): T | null;
  /** Clears the TTL so the next get() re-probes. */
  invalidate(): void;
}

export function createOnDemandProbe<T>(
  probeFn: () => Promise<T>,
  ttlMs: number,
): OnDemandProbe<T> {
  let cached: { value: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;

  async function refresh(): Promise<T> {
    try {
      const value = await probeFn();
      cached = { value, at: Date.now() };
      return value;
    } catch (error) {
      logger.warn({ err: error }, 'On-demand probe failed');
      throw error;
    } finally {
      inflight = null;
    }
  }

  return {
    get() {
      if (cached && Date.now() - cached.at < ttlMs) {
        return Promise.resolve(cached.value);
      }
      if (inflight) return inflight;
      inflight = refresh();
      return inflight;
    },

    peek() {
      return cached?.value ?? null;
    },

    invalidate() {
      cached = null;
    },
  };
}
