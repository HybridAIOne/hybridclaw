import { describe, expect, it } from 'vitest';
import { oneOfOr } from './oneof';

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
