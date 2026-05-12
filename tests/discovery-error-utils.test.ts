import { describe, expect, test } from 'vitest';

import {
  formatDiscoveryDuration,
  formatDiscoveryFailure,
  isTimeoutError,
} from '../src/providers/discovery-error-utils.js';

describe('provider discovery error utils', () => {
  test('formats discovery durations compactly', () => {
    expect(formatDiscoveryDuration(5_000)).toBe('5s');
    expect(formatDiscoveryDuration(5_250)).toBe('5250ms');
  });

  test('detects timeout-shaped errors from fetch runtimes', () => {
    const timeout = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    );
    expect(isTimeoutError(timeout)).toBe(true);
    expect(isTimeoutError(new Error('request timed out'))).toBe(true);
    expect(isTimeoutError(new Error('fetch failed'))).toBe(false);
  });

  test('formats HTTP, timeout, and generic discovery failures', () => {
    const httpError = new Error('HTTP 404') as Error & { httpStatus?: number };
    httpError.httpStatus = 404;
    expect(
      formatDiscoveryFailure({
        error: httpError,
        url: 'https://example.test/models',
        timeoutMs: 5_000,
      }),
    ).toEqual({
      httpStatus: 404,
      message: 'HTTP 404 from https://example.test/models',
    });

    expect(
      formatDiscoveryFailure({
        error: new DOMException('timeout', 'TimeoutError'),
        url: 'https://example.test/models',
        timeoutMs: 5_000,
      }),
    ).toEqual({
      message: 'Timed out after 5s while fetching https://example.test/models.',
    });

    expect(
      formatDiscoveryFailure({
        error: new Error('connection refused'),
        url: 'https://example.test/models',
        timeoutMs: 5_000,
      }),
    ).toEqual({
      message:
        'Failed to fetch https://example.test/models: connection refused',
    });
  });
});
