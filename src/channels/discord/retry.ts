import { withTransportRetry } from '../../utils/transport-retry.js';

interface DiscordErrorLike {
  status?: number;
  httpStatus?: number;
  retryAfter?: number;
  data?: {
    retry_after?: number;
  };
}

const DISCORD_RETRY_MAX_ATTEMPTS = 3;
const DISCORD_RETRY_BASE_DELAY_MS = 500;
const DISCORD_RETRY_MAX_DELAY_MS = 4_000;

function isRetryableDiscordError(error: unknown): boolean {
  const maybe = error as DiscordErrorLike;
  const status = maybe.status ?? maybe.httpStatus;
  return (
    status === 429 ||
    (typeof status === 'number' && status >= 500 && status <= 599)
  );
}

function extractDiscordRetryDelayMs(
  error: unknown,
  fallbackMs: number,
): number {
  const maybe = error as DiscordErrorLike;
  const retryAfterSeconds = maybe.retryAfter ?? maybe.data?.retry_after;
  if (
    typeof retryAfterSeconds === 'number' &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
  ) {
    return Math.max(50, Math.ceil(retryAfterSeconds * 1_000));
  }
  const jitter = Math.floor(Math.random() * 250);
  return fallbackMs + jitter;
}

export function withDiscordRetry<T>(
  label: string,
  run: () => Promise<T>,
  options?: {
    logMessage?: string;
  },
): Promise<T> {
  return withTransportRetry(label, run, {
    maxAttempts: DISCORD_RETRY_MAX_ATTEMPTS,
    baseDelayMs: DISCORD_RETRY_BASE_DELAY_MS,
    maxDelayMs: DISCORD_RETRY_MAX_DELAY_MS,
    isRetryable: isRetryableDiscordError,
    extractRetryAfter: extractDiscordRetryDelayMs,
    logMessage: options?.logMessage ?? 'Discord API call failed; retrying',
  });
}
