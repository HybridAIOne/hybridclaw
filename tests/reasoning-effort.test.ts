import { describe, expect, test } from 'vitest';
import {
  getSupportedReasoningEfforts,
  isReasoningEffort,
} from '../container/shared/reasoning-effort.js';

describe('reasoning effort support', () => {
  test('advertises the verified HybridAI Qwen3.8 27B family', () => {
    expect(
      getSupportedReasoningEfforts('hybridai', 'qwen/qwen3.8-27b'),
    ).toEqual(['none', 'low', 'medium', 'xhigh']);
    expect(
      getSupportedReasoningEfforts(
        'hybridai',
        'hybridai/qwen/qwen3.8-27b-instruct',
      ),
    ).toEqual(['none', 'low', 'medium', 'xhigh']);
  });

  test('fails closed for unverified models and providers', () => {
    expect(
      getSupportedReasoningEfforts('hybridai', 'qwen/qwen3.6-27b'),
    ).toEqual([]);
    expect(
      getSupportedReasoningEfforts('openrouter', 'qwen/qwen3.8-27b'),
    ).toEqual([]);
  });

  test('accepts only values supported by the gateway boundary', () => {
    expect(isReasoningEffort('none')).toBe(true);
    expect(isReasoningEffort('xhigh')).toBe(true);
    expect(isReasoningEffort('high')).toBe(false);
    expect(isReasoningEffort(undefined)).toBe(false);
  });
});
