import { expect, test } from 'vitest';

import {
  resolveInboundDebounceMs,
  shouldDebounceInbound,
} from '../src/channels/discord/debounce.js';
import {
  getHumanDelayMs,
  resolveHumanDelayConfig,
} from '../src/channels/discord/human-delay.js';
import { shouldSuppressAutoReply } from '../src/channels/discord/inbound.js';
import { SlidingWindowRateLimiter } from '../src/channels/discord/rate-limiter.js';

test('resolveHumanDelayConfig normalizes custom bounds', () => {
  const resolved = resolveHumanDelayConfig({
    mode: 'custom',
    minMs: 2_500,
    maxMs: 800,
  });
  expect(resolved).toEqual({
    mode: 'custom',
    minMs: 2_500,
    maxMs: 2_500,
  });
});

test('getHumanDelayMs returns 0 for off mode', () => {
  expect(getHumanDelayMs({ mode: 'off' })).toBe(0);
});

test('getHumanDelayMs respects configured range', () => {
  for (let i = 0; i < 20; i += 1) {
    const value = getHumanDelayMs({ mode: 'custom', minMs: 10, maxMs: 20 });
    expect(value).toBeGreaterThanOrEqual(10);
    expect(value).toBeLessThanOrEqual(20);
  }
});

test('shouldDebounceInbound skips media and control commands', () => {
  expect(
    shouldDebounceInbound({
      content: 'hello',
      hasAttachments: false,
      isPrefixedCommand: false,
    }),
  ).toBe(true);
  expect(
    shouldDebounceInbound({
      content: 'hello',
      hasAttachments: true,
      isPrefixedCommand: false,
    }),
  ).toBe(false);
  expect(
    shouldDebounceInbound({
      content: '/stop now',
      hasAttachments: false,
      isPrefixedCommand: false,
    }),
  ).toBe(false);
  expect(
    shouldDebounceInbound({
      content: '/reset',
      hasAttachments: false,
      isPrefixedCommand: false,
    }),
  ).toBe(false);
});

test('resolveInboundDebounceMs uses channel override when provided', () => {
  expect(resolveInboundDebounceMs(2500, undefined)).toBe(2500);
  expect(resolveInboundDebounceMs(2500, 5000)).toBe(5000);
});

test('shouldSuppressAutoReply matches patterns and greeting-only text', () => {
  expect(shouldSuppressAutoReply('brb', ['/stop', 'brb'])).toBe(true);
  expect(shouldSuppressAutoReply('hello', ['/stop'])).toBe(true);
  expect(shouldSuppressAutoReply('please help me debug this', ['/stop'])).toBe(
    false,
  );
});

test('SlidingWindowRateLimiter enforces per-minute limits', () => {
  const limiter = new SlidingWindowRateLimiter(60_000);
  const key = 'channel:user';
  expect(limiter.check(key, 2, 1_000).allowed).toBe(true);
  expect(limiter.check(key, 2, 2_000).allowed).toBe(true);
  const blocked = limiter.check(key, 2, 3_000);
  expect(blocked.allowed).toBe(false);
  expect(blocked.retryAfterMs).toBeGreaterThan(0);
  expect(limiter.check(key, 2, 62_000).allowed).toBe(true);
});
