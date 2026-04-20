import { describe, expect, test } from 'vitest';
import {
  formatModelErrorForLog,
  isRetryableModelError,
  shouldDowngradeStreamToNonStreaming,
  shouldFallbackFromStreamError,
} from '../container/src/model-retry.js';
import { ProviderRequestError } from '../container/src/providers/shared.js';

describe('shouldFallbackFromStreamError', () => {
  test('allows fallback for 500 stream errors', () => {
    expect(
      shouldFallbackFromStreamError(
        new ProviderRequestError(500, '{"error":"server_error"}'),
      ),
    ).toBe(true);
  });

  test('allows fallback for non-429 4xx errors', () => {
    expect(
      shouldFallbackFromStreamError(
        new ProviderRequestError(400, '{"error":"bad_request"}'),
      ),
    ).toBe(true);
  });

  test('keeps 429 on retry/backoff path (no fallback)', () => {
    expect(
      shouldFallbackFromStreamError(
        new ProviderRequestError(429, '{"error":"rate_limited"}'),
      ),
    ).toBe(false);
  });

  test('does not fall back for premium-model permission errors', () => {
    expect(
      shouldFallbackFromStreamError(
        new ProviderRequestError(
          403,
          JSON.stringify({
            error: {
              message:
                'Premium models require a paid plan or token-credit balance.',
              type: 'permission_error',
              code: 403,
            },
          }),
        ),
      ),
    ).toBe(false);
  });

  test('falls back for transient network stream errors', () => {
    expect(shouldFallbackFromStreamError(new Error('socket closed'))).toBe(
      true,
    );
    expect(shouldFallbackFromStreamError(new Error('terminated'))).toBe(true);
  });

  test('falls back for generic Codex stream failures with request ids', () => {
    expect(
      shouldFallbackFromStreamError(
        new Error(
          'An error occurred while processing your request. Please include request ID 3f700c22-8979-4803-a858-c1ae3a4c7110.',
        ),
      ),
    ).toBe(true);
  });
});

describe('shouldDowngradeStreamToNonStreaming', () => {
  test('does not downgrade openai-codex stream failures to non-streaming', () => {
    expect(
      shouldDowngradeStreamToNonStreaming(
        'openai-codex',
        new Error(
          'An error occurred while processing your request. Please include request ID 3f700c22-8979-4803-a858-c1ae3a4c7110.',
        ),
      ),
    ).toBe(false);
  });

  test('still downgrades other provider stream failures when fallback is valid', () => {
    expect(
      shouldDowngradeStreamToNonStreaming(
        'hybridai',
        new ProviderRequestError(500, '{"error":"server_error"}'),
      ),
    ).toBe(true);
  });
});

describe('isRetryableModelError', () => {
  test('treats 429 and 5xx(<=504) as retryable', () => {
    expect(
      isRetryableModelError(
        new ProviderRequestError(429, '{"error":"rate_limited"}'),
      ),
    ).toBe(true);
    expect(
      isRetryableModelError(
        new ProviderRequestError(500, '{"error":"server_error"}'),
      ),
    ).toBe(true);
    expect(
      isRetryableModelError(
        new ProviderRequestError(504, '{"error":"gateway_timeout"}'),
      ),
    ).toBe(true);
  });

  test('does not retry non-retryable status codes', () => {
    expect(
      isRetryableModelError(
        new ProviderRequestError(400, '{"error":"bad_request"}'),
      ),
    ).toBe(false);
    expect(
      isRetryableModelError(
        new ProviderRequestError(
          403,
          JSON.stringify({
            error: {
              message:
                'Premium models require a paid plan or token-credit balance.',
              type: 'permission_error',
              code: 403,
            },
          }),
        ),
      ),
    ).toBe(false);
    expect(
      isRetryableModelError(
        new ProviderRequestError(505, '{"error":"http_version_not_supported"}'),
      ),
    ).toBe(false);
  });

  test('retries known transient network errors', () => {
    expect(isRetryableModelError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableModelError(new Error('ECONNRESET upstream'))).toBe(true);
    expect(isRetryableModelError(new Error('timed out'))).toBe(true);
    expect(isRetryableModelError(new Error('terminated'))).toBe(true);
  });

  test('retries generic Codex processing failures', () => {
    expect(
      isRetryableModelError(
        new Error(
          'An error occurred while processing your request. Please include request ID 3f700c22-8979-4803-a858-c1ae3a4c7110.',
        ),
      ),
    ).toBe(true);
  });

  test('does not retry unrelated generic errors', () => {
    expect(isRetryableModelError(new Error('validation failed'))).toBe(false);
  });
});

describe('formatModelErrorForLog', () => {
  test('uses nested transport causes to describe fetch failures', () => {
    const error = new Error('fetch failed', {
      cause: Object.assign(
        new Error('getaddrinfo ENOTFOUND api.hybridai.one'),
        {
          code: 'ENOTFOUND',
          hostname: 'api.hybridai.one',
        },
      ),
    });

    expect(
      formatModelErrorForLog(error, 'https://api.hybridai.one/v1/chat'),
    ).toBe('DNS lookup failed for api.hybridai.one');
  });

  test('falls back to the model API host for generic network failures', () => {
    expect(
      formatModelErrorForLog(
        new Error('fetch failed'),
        'https://api.hybridai.one/v1/chat',
      ),
    ).toBe('Model API at api.hybridai.one is temporarily unavailable');
  });
});
