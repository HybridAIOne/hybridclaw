import { logger } from '../logger.js';
import { sleep } from './sleep.js';

export interface TransportRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  isRetryable: (error: unknown) => boolean;
  extractRetryAfter?: (
    error: unknown,
    fallbackMs: number,
  ) => number | null | undefined;
  logMessage?: string;
}

function normalizeRetryValue(value: number, minimum: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `Retry values must be finite numbers; received ${value}`,
    );
  }
  return Math.max(minimum, Math.floor(value));
}

export async function withTransportRetry<T>(
  label: string,
  run: () => Promise<T>,
  options: TransportRetryOptions,
): Promise<T> {
  const maxAttempts = normalizeRetryValue(options.maxAttempts, 1);
  const maxDelayMs =
    options.maxDelayMs == null
      ? Number.POSITIVE_INFINITY
      : normalizeRetryValue(options.maxDelayMs, 0);
  let attempt = 0;
  let delayMs = Math.min(
    normalizeRetryValue(options.baseDelayMs, 0),
    maxDelayMs,
  );

  while (true) {
    attempt += 1;
    try {
      return await run();
    } catch (error) {
      if (attempt >= maxAttempts || !options.isRetryable(error)) {
        throw error;
      }

      const fallbackMs = delayMs;
      const extractedDelayMs = options.extractRetryAfter?.(error, fallbackMs);
      const waitMs =
        extractedDelayMs == null
          ? fallbackMs
          : normalizeRetryValue(extractedDelayMs, 0);

      logger.warn(
        { label, attempt, waitMs, error },
        options.logMessage ?? 'Transport request failed; retrying',
      );
      await sleep(waitMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}
