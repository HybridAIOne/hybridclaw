import { describe, expect, it } from 'vitest';
import { cacheHitRatio, formatTokenBreakdown, pluralize } from './format';

describe('pluralize', () => {
  it('returns singular when n is 1', () => {
    expect(pluralize(1, 'call')).toBe('1 call');
  });

  it('returns plural when n is 0', () => {
    expect(pluralize(0, 'call')).toBe('0 calls');
  });

  it('returns plural when n is greater than 1', () => {
    expect(pluralize(2, 'call')).toBe('2 calls');
    expect(pluralize(100, 'call')).toBe('100 calls');
  });

  it('uses a custom plural form for irregular plurals', () => {
    expect(pluralize(1, 'person', 'people')).toBe('1 person');
    expect(pluralize(3, 'person', 'people')).toBe('3 people');
  });

  it('handles negative numbers as plural', () => {
    expect(pluralize(-1, 'call')).toBe('-1 calls');
  });
});

describe('formatTokenBreakdown', () => {
  it('shows in/out only when no cache was reported', () => {
    expect(formatTokenBreakdown({ inputTokens: 1200, outputTokens: 300 })).toBe(
      '1.2K in / 300 out',
    );
  });

  it('appends the cache hit share when cached input is present', () => {
    expect(
      formatTokenBreakdown({
        inputTokens: 1_000_000,
        outputTokens: 50_000,
        cacheReadTokens: 700_000,
      }),
    ).toBe('1M in / 50K out · 70% cached');
  });

  it('clamps the hit ratio to the input total', () => {
    expect(cacheHitRatio(100, 250)).toBe(1);
    expect(cacheHitRatio(0, 250)).toBeNull();
    expect(cacheHitRatio(100, 0)).toBeNull();
  });
});
