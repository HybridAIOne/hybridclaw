import { describe, expect, it } from 'vitest';
import { isOneOf, oneOfOr } from './oneof';

const COLORS = ['red', 'green', 'blue'] as const;

describe('oneOfOr', () => {
  it('returns the value when it is in the allowed set', () => {
    expect(oneOfOr(COLORS, 'red', 'blue')).toBe('red');
  });

  it('returns the fallback when the value is not allowed', () => {
    expect(oneOfOr(COLORS, 'purple', 'blue')).toBe('blue');
  });

  it('returns the fallback for the empty string', () => {
    expect(oneOfOr(COLORS, '', 'red')).toBe('red');
  });
});

describe('isOneOf', () => {
  it('returns true for allowed values', () => {
    expect(isOneOf(COLORS, 'red')).toBe(true);
  });

  it('returns false for disallowed values', () => {
    expect(isOneOf(COLORS, 'purple')).toBe(false);
    expect(isOneOf(COLORS, '')).toBe(false);
  });

  it('narrows the value type', () => {
    const candidate: string = 'green';
    if (isOneOf(COLORS, candidate)) {
      const narrowed: (typeof COLORS)[number] = candidate;
      expect(narrowed).toBe('green');
    }
  });
});
