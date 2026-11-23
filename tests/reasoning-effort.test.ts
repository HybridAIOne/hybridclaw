import { describe, expect, test } from 'vitest';
import {
  isReasoningEffort,
  normalizeReasoningEfforts,
} from '@hybridclaw/shared/reasoning-effort';

describe('reasoning effort support', () => {
  test('accepts only values supported by the gateway boundary', () => {
    expect(isReasoningEffort('none')).toBe(true);
    expect(isReasoningEffort('minimal')).toBe(true);
    expect(isReasoningEffort('low')).toBe(true);
    expect(isReasoningEffort('medium')).toBe(true);
    expect(isReasoningEffort('high')).toBe(true);
    expect(isReasoningEffort('xhigh')).toBe(true);
    expect(isReasoningEffort('max')).toBe(false);
    expect(isReasoningEffort(undefined)).toBe(false);
  });

  test('normalizes discovered effort arrays into canonical order and drops unknowns', () => {
    expect(
      normalizeReasoningEfforts(['xhigh', 'HIGH', 'none', 'max', 'high', 42]),
    ).toEqual(['none', 'high', 'xhigh']);
    expect(normalizeReasoningEfforts(null)).toEqual([]);
    expect(normalizeReasoningEfforts('high')).toEqual([]);
  });
});
