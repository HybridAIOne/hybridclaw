import { describe, expect, test } from 'vitest';
import {
  classifyModelError,
  formatModelFailureSummary,
  RoutedModelError,
} from '../container/src/model-error-classification.js';
import { shouldAutoRouteFromModelError } from '../container/src/model-retry.js';
import { ProviderRequestError } from '../container/src/providers/shared.js';

describe('classifyModelError', () => {
  test('classifies nested DNS transport failures', () => {
    const error = new Error('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), {
        code: 'ENOTFOUND',
      }),
    });

    expect(classifyModelError(error)).toMatchObject({
      kind: 'dns',
      retryable: true,
      autoRoute: true,
      detail: 'getaddrinfo ENOTFOUND api.example.com',
    });
  });

  test('classifies TLS transport failures', () => {
    const error = new Error('fetch failed', {
      cause: Object.assign(
        new Error(
          'certificate has expired or is not yet valid: CERT_HAS_EXPIRED',
        ),
        {
          code: 'CERT_HAS_EXPIRED',
        },
      ),
    });

    expect(classifyModelError(error)).toMatchObject({
      kind: 'tls',
      retryable: true,
      autoRoute: true,
    });
  });

  test('distinguishes generic 5xx responses from provider outages', () => {
    expect(
      classifyModelError(
        new ProviderRequestError(
          500,
          JSON.stringify({
            error: { message: 'Internal server error', type: 'server_error' },
          }),
        ),
      ),
    ).toMatchObject({
      kind: 'http_5xx',
      status: 500,
    });

    expect(
      classifyModelError(
        new ProviderRequestError(
          503,
          JSON.stringify({
            error: {
              message: 'Service temporarily unavailable',
              type: 'server_error',
            },
          }),
        ),
      ),
    ).toMatchObject({
      kind: 'provider_outage',
      status: 503,
    });
  });
});

describe('shouldAutoRouteFromModelError', () => {
  test('allows auto-routing for network and outage classes only', () => {
    expect(
      shouldAutoRouteFromModelError(
        new Error('fetch failed', {
          cause: Object.assign(
            new Error('getaddrinfo ENOTFOUND api.example.com'),
            {
              code: 'ENOTFOUND',
            },
          ),
        }),
      ),
    ).toBe(true);
    expect(
      shouldAutoRouteFromModelError(
        new ProviderRequestError(503, '{"error":"temporarily unavailable"}'),
      ),
    ).toBe(true);
    expect(
      shouldAutoRouteFromModelError(
        new ProviderRequestError(400, '{"error":"bad request"}'),
      ),
    ).toBe(false);
    expect(
      shouldAutoRouteFromModelError(
        new ProviderRequestError(429, '{"error":"rate limited"}'),
      ),
    ).toBe(false);
  });
});

describe('RoutedModelError', () => {
  test('summarizes exhausted fallback routes with classified messages', () => {
    const failures = [
      {
        target: {
          provider: 'openrouter' as const,
          model: 'openrouter/anthropic/claude-sonnet-4',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
        classification: classifyModelError(
          new Error('fetch failed', {
            cause: Object.assign(
              new Error('getaddrinfo ENOTFOUND openrouter.ai'),
              {
                code: 'ENOTFOUND',
              },
            ),
          }),
        ),
        error: new Error('fetch failed', {
          cause: Object.assign(
            new Error('getaddrinfo ENOTFOUND openrouter.ai'),
            {
              code: 'ENOTFOUND',
            },
          ),
        }),
      },
      {
        target: {
          provider: 'openai-codex' as const,
          model: 'openai-codex/gpt-5-codex',
          baseUrl: 'https://api.openai.com/v1',
        },
        classification: classifyModelError(
          new ProviderRequestError(
            503,
            '{"error":{"message":"Service temporarily unavailable"}}',
          ),
        ),
        error: new ProviderRequestError(
          503,
          '{"error":{"message":"Service temporarily unavailable"}}',
        ),
      },
    ];

    const summary = formatModelFailureSummary(failures);
    expect(summary).toContain('All configured model routes failed.');
    expect(summary).toContain('DNS lookup failed');
    expect(summary).toContain('provider outage detected');

    const error = new RoutedModelError(failures);
    expect(error.message).toBe(summary);
  });
});
