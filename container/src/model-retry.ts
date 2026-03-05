import { HybridAIRequestError } from './hybridai-client.js';

const TRANSIENT_NETWORK_ERROR_RE =
  /fetch failed|network|socket|timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i;

export function shouldFallbackFromStreamError(error: unknown): boolean {
  if (!(error instanceof HybridAIRequestError)) return false;
  // Keep 429 on retry/backoff path; fallback does not help throttling.
  if (error.status === 429) return false;
  return error.status >= 400 && error.status <= 599;
}

export function isRetryableModelError(error: unknown): boolean {
  if (error instanceof HybridAIRequestError) {
    return error.status === 429 || (error.status >= 500 && error.status <= 504);
  }
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_NETWORK_ERROR_RE.test(message);
}
