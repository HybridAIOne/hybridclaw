import type { RuntimeProvider } from './providers/shared.js';
import {
  HybridAIRequestError,
  isPremiumModelPermissionError,
} from './providers/shared.js';

const TRANSIENT_NETWORK_ERROR_RE =
  /fetch failed|network|socket|timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|terminated/i;
const TRANSIENT_CODEX_STREAM_ERROR_RE =
  /an error occurred while processing your request|request id [0-9a-f-]{8}-[0-9a-f-]{27}|streaming response ended without payload|stream ended without payload|response\.incomplete|response\.failed/i;

export function shouldFallbackFromStreamError(error: unknown): boolean {
  if (error instanceof HybridAIRequestError) {
    // Keep 429 on retry/backoff path; fallback does not help throttling.
    if (error.status === 429) return false;
    if (isPremiumModelPermissionError(error)) return false;
    return error.status >= 400 && error.status <= 599;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!message.trim()) return false;
  // Keep 429 on retry/backoff path; fallback does not help throttling.
  if (/429|rate.?limit/i.test(message)) return false;
  return (
    TRANSIENT_NETWORK_ERROR_RE.test(message) ||
    TRANSIENT_CODEX_STREAM_ERROR_RE.test(message)
  );
}

export function shouldDowngradeStreamToNonStreaming(
  provider: RuntimeProvider | undefined,
  error: unknown,
): boolean {
  if (provider === 'openai-codex') return false;
  return shouldFallbackFromStreamError(error);
}

export function isRetryableModelError(error: unknown): boolean {
  if (error instanceof HybridAIRequestError) {
    return error.status === 429 || (error.status >= 500 && error.status <= 504);
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    TRANSIENT_NETWORK_ERROR_RE.test(message) ||
    TRANSIENT_CODEX_STREAM_ERROR_RE.test(message)
  );
}
