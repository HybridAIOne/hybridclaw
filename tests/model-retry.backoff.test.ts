import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  isRetryableModelError,
  retryDelayMs,
} from '../container/src/model-retry.js';
import {
  ProviderRequestError,
  readRetryAfterMs,
} from '../container/src/providers/shared.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isRetryableModelError', () => {
  test.each([
    [408, true],
    [429, true],
    [500, true],
    [503, true],
    [504, true],
    [529, true],
    [400, false],
    [401, false],
    [413, false],
  ])('status %i is retryable: %s', (status, expected) => {
    expect(isRetryableModelError(new ProviderRequestError(status, '{}'))).toBe(
      expected,
    );
  });
});

describe('retryDelayMs', () => {
  test.each([
    [0, 1_600],
    [0.5, 2_000],
    [0.999_999, 2_400],
  ])('jitters a 2 s backoff (random %f gives %i ms)', (random, expected) => {
    vi.spyOn(Math, 'random').mockReturnValue(random);

    expect(retryDelayMs(2_000, new Error('fetch failed'))).toBe(expected);
  });

  test('waits at least as long as the provider asks', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    expect(retryDelayMs(2_000, new ProviderRequestError(429, '{}', 7_000))).toBe(
      7_000,
    );
    expect(retryDelayMs(2_000, new ProviderRequestError(429, '{}', 500))).toBe(
      2_000,
    );
  });

  test('gives up when the provider asks for more than a minute', () => {
    expect(
      retryDelayMs(2_000, new ProviderRequestError(429, '{}', 120_000)),
    ).toBeNull();
  });
});

describe('readRetryAfterMs', () => {
  test.each<[Record<string, string>, number | undefined]>([
    [{ 'retry-after': '3' }, 3_000],
    [{ 'retry-after': '1.5' }, 1_500],
    [{ 'retry-after-ms': '250', 'retry-after': '9' }, 250],
    [{ 'retry-after': 'soon' }, undefined],
    [{ 'retry-after': '' }, undefined],
    [{}, undefined],
  ])('reads %o as %s', (headers, expected) => {
    expect(readRetryAfterMs(new Headers(headers))).toBe(expected);
  });

  test('reads an HTTP date relative to now', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-27T10:00:00Z'));

    expect(
      readRetryAfterMs(
        new Headers({ 'retry-after': 'Sun, 27 Sep 2026 10:00:10 GMT' }),
      ),
    ).toBe(10_000);
  });
});
