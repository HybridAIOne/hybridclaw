import { describe, expect, test } from 'vitest';
import {
  canReplayModelRequestAfterStreamError,
  formatModelErrorForLog,
  isContextWindowExceededError,
  isRetryableModelError,
  shouldDowngradeStreamToNonStreaming,
  shouldFallbackFromStreamError,
} from '../container/src/model-retry.js';
import { ProviderRequestError } from '../container/src/providers/shared.js';

describe('canReplayModelRequestAfterStreamError', () => {
  test('blocks fallback and retries after visible partial output', () => {
    expect(
      canReplayModelRequestAfterStreamError({
        receivedTextDelta: true,
        textDeltasVisible: true,
      }),
    ).toBe(false);
  });

  test('allows replay before output or when deltas remain buffered', () => {
    expect(
      canReplayModelRequestAfterStreamError({
        receivedTextDelta: false,
        textDeltasVisible: true,
      }),
    ).toBe(true);
    expect(
      canReplayModelRequestAfterStreamError({
        receivedTextDelta: true,
        textDeltasVisible: false,
      }),
    ).toBe(true);
  });
});

describe('shouldFallbackFromStreamError', () => {
  test.each([
    ['a 500', new ProviderRequestError(500, '{"error":"server_error"}')],
    ['a 502', new ProviderRequestError(502, '{"error":"bad_gateway"}')],
    ['a 400', new ProviderRequestError(400, '{"error":"bad_request"}')],
    ['a 401', new ProviderRequestError(401, '{"error":"unauthorized"}')],
    ['a 429', new ProviderRequestError(429, '{"error":"rate_limited"}')],
    [
      'a premium-model permission error',
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
    ],
    [
      'a context-length rejection',
      new ProviderRequestError(
        400,
        '{"error":{"message":"Input rejected.","code":"context_length_exceeded"}}',
      ),
    ],
    [
      'a 5xx that mentions streaming',
      new ProviderRequestError(503, '{"error":"upstream stream unavailable"}'),
    ],
  ])('re-streams instead of replaying %s without streaming', (_name, error) => {
    expect(shouldFallbackFromStreamError(error)).toBe(false);
  });

  test('replays without streaming when the provider refuses to stream', () => {
    expect(
      shouldFallbackFromStreamError(
        new ProviderRequestError(
          400,
          JSON.stringify({
            error: {
              message: 'Your organization must be verified to stream this model.',
              type: 'invalid_request_error',
              param: 'stream',
              code: 'unsupported_value',
            },
          }),
        ),
      ),
    ).toBe(true);
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

  test('falls back when the response headers never arrive', () => {
    expect(
      shouldFallbackFromStreamError(
        new Error(
          'Stream idle timeout after 90000ms waiting for response headers',
        ),
      ),
    ).toBe(true);
  });
});

describe('isContextWindowExceededError', () => {
  test.each([
    [
      'OpenAI-style code',
      new ProviderRequestError(
        400,
        '{"error":{"message":"Input rejected.","type":"invalid_request_error","code":"context_length_exceeded"}}',
      ),
    ],
    [
      'OpenAI-compatible message',
      new ProviderRequestError(
        400,
        '{"object":"error","message":"This model\'s maximum context length is 4096 tokens. However, you requested 5000 tokens.","code":400}',
      ),
    ],
    [
      'Anthropic prompt length',
      new ProviderRequestError(
        400,
        '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 208000 tokens > 200000 maximum"}}',
      ),
    ],
    [
      'Anthropic input plus max_tokens',
      new ProviderRequestError(
        400,
        '{"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 188000 + 21333 > 200000"}}',
      ),
    ],
    [
      'Gemini input token count',
      new ProviderRequestError(
        400,
        '[{"error":{"code":400,"message":"The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}]',
      ),
    ],
    [
      'xAI prompt length',
      new ProviderRequestError(
        400,
        '{"error":"This model\'s maximum prompt length is 131072 but the request contains 140000 tokens."}',
      ),
    ],
    [
      'Kimi token limit',
      new ProviderRequestError(
        400,
        '{"error":{"message":"Invalid request: Your request exceeded model token limit: 131072","type":"invalid_request_error"}}',
      ),
    ],
    [
      'llama.cpp context size',
      new ProviderRequestError(
        400,
        '{"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error"}}',
      ),
    ],
    [
      'LM Studio loaded context',
      new ProviderRequestError(
        400,
        '{"error":"The model is loaded with context length of only 4096 tokens, which is not enough."}',
      ),
    ],
    [
      'Codex stream failure',
      new Error(
        'Your input exceeds the context window of this model. Please adjust your input and try again.',
      ),
    ],
  ])('recognizes %s', (_name, error) => {
    expect(isContextWindowExceededError(error)).toBe(true);
  });

  test.each([
    [
      'an output-token cap',
      new ProviderRequestError(
        400,
        '{"error":{"message":"max_tokens is too large: 50000. This model supports at most 16384 completion tokens.","code":"invalid_value"}}',
      ),
    ],
    [
      'a tokens-per-minute limit',
      new ProviderRequestError(
        429,
        '{"error":{"message":"Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 50000.","code":"rate_limit_exceeded"}}',
      ),
    ],
    [
      'a request byte limit',
      new ProviderRequestError(
        413,
        '{"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum allowed number of bytes."}}',
      ),
    ],
    ['a network failure', new Error('fetch failed')],
  ])('ignores %s', (_name, error) => {
    expect(isContextWindowExceededError(error)).toBe(false);
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
      shouldDowngradeStreamToNonStreaming('hybridai', new Error('terminated')),
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
