import { describe, expect, test } from 'vitest';

import { SlidingWindowByteQuota } from '../src/gateway/media-upload-quota.js';

describe('SlidingWindowByteQuota', () => {
  test('allows uploads within the rolling byte limit', () => {
    const quota = new SlidingWindowByteQuota(1_000);

    expect(quota.consume('web-token', 40, 100, 0)).toEqual({
      allowed: true,
      remainingBytes: 60,
      retryAfterMs: 0,
      usedBytes: 40,
    });
    expect(quota.consume('web-token', 50, 100, 100)).toEqual({
      allowed: true,
      remainingBytes: 10,
      retryAfterMs: 0,
      usedBytes: 90,
    });
  });

  test('denies uploads until enough prior bytes expire', () => {
    const quota = new SlidingWindowByteQuota(1_000);

    quota.consume('web-token', 3, 100, 0);
    quota.consume('web-token', 4, 100, 100);
    quota.consume('web-token', 90, 100, 200);

    expect(quota.consume('web-token', 10, 100, 300)).toEqual({
      allowed: false,
      remainingBytes: 3,
      retryAfterMs: 800,
      usedBytes: 97,
    });
    expect(quota.consume('web-token', 10, 100, 1_101)).toEqual({
      allowed: true,
      remainingBytes: 0,
      retryAfterMs: 0,
      usedBytes: 100,
    });
  });
});
