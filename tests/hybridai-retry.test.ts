import { describe, expect, test } from 'vitest';
import { HybridAIRequestError } from '../container/src/model-client.js';
import {
  isRetryableModelError,
  shouldFallbackFromStreamError,
} from '../container/src/model-retry.js';

describe('shouldFallbackFromStreamError', () => {
  test('allows fallback for 500 stream errors', () => {
    expect(
      shouldFallbackFromStreamError(
        new HybridAIRequestError(500, '{"error":"server_error"}'),
      ),
    ).toBe(true);
  });

  test('allows fallback for non-429 4xx errors', () => {
    expect(
      shouldFallbackFromStreamError(
        new HybridAIRequestError(400, '{"error":"bad_request"}'),
      ),
    ).toBe(true);
  });

  test('keeps 429 on retry/backoff path (no fallback)', () => {
    expect(
      shouldFallbackFromStreamError(
        new HybridAIRequestError(429, '{"error":"rate_limited"}'),
      ),
    ).toBe(false);
  });

  test('does not fallback for non-HTTP typed errors', () => {
    expect(shouldFallbackFromStreamError(new Error('socket closed'))).toBe(
      false,
    );
  });
});

describe('isRetryableModelError', () => {
  test('treats 429 and 5xx(<=504) as retryable', () => {
    expect(
      isRetryableModelError(
        new HybridAIRequestError(429, '{"error":"rate_limited"}'),
      ),
    ).toBe(true);
    expect(
      isRetryableModelError(
        new HybridAIRequestError(500, '{"error":"server_error"}'),
      ),
    ).toBe(true);
    expect(
      isRetryableModelError(
        new HybridAIRequestError(504, '{"error":"gateway_timeout"}'),
      ),
    ).toBe(true);
  });

  test('does not retry non-retryable status codes', () => {
    expect(
      isRetryableModelError(
        new HybridAIRequestError(400, '{"error":"bad_request"}'),
      ),
    ).toBe(false);
    expect(
      isRetryableModelError(
        new HybridAIRequestError(505, '{"error":"http_version_not_supported"}'),
      ),
    ).toBe(false);
  });

  test('retries known transient network errors', () => {
    expect(isRetryableModelError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableModelError(new Error('ECONNRESET upstream'))).toBe(true);
    expect(isRetryableModelError(new Error('timed out'))).toBe(true);
  });

  test('does not retry unrelated generic errors', () => {
    expect(isRetryableModelError(new Error('validation failed'))).toBe(false);
  });
});
