import { describe, expect, test } from 'vitest';

import { applyContextGuard } from '../container/src/context-guard.js';
import {
  createTokenEstimateCache,
  estimateMessageTokens,
} from '../container/src/token-usage.js';
import type { ChatMessage } from '../container/src/types.js';

function buildHistory(): ChatMessage[] {
  return [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'Start the task' },
    { role: 'assistant', content: 'Calling tools.' },
    {
      role: 'tool',
      content: 'A'.repeat(1_600),
      tool_call_id: 'call_1',
    },
    { role: 'assistant', content: 'Reviewing first result.' },
    {
      role: 'tool',
      content: 'B'.repeat(1_200),
      tool_call_id: 'call_2',
    },
    { role: 'assistant', content: 'Continue.' },
  ];
}

describe('applyContextGuard', () => {
  test('triggers compaction without rewriting tool results or their cached estimates', () => {
    const history = buildHistory();
    const original = structuredClone(history);
    const cache = createTokenEstimateCache();
    const before = estimateMessageTokens(history, cache);
    const result = applyContextGuard({
      history,
      contextWindowTokens: 1_024,
      cache,
    });
    expect(result.tier3Triggered).toBe(true);
    expect(history).toEqual(original);
    expect(estimateMessageTokens(history, cache)).toBe(before);
  });

  test('preserves an oversized individual result when the full context fits', () => {
    const content = 'evidence-middle'.repeat(12_000);
    const history: ChatMessage[] = [
      { role: 'tool', content, tool_call_id: 'a' },
    ];
    const result = applyContextGuard({ history, contextWindowTokens: 128_000 });
    expect(history[0].content).toBe(content);
  });

  test('triggers tier 3 when non-tool history still overflows the budget', () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'U'.repeat(5_000) },
      { role: 'assistant', content: 'A'.repeat(5_000) },
    ];
    const result = applyContextGuard({
      history,
      contextWindowTokens: 1_024,
      cache: createTokenEstimateCache(),
    });

    expect(result.tier3Triggered).toBe(true);
  });

  test('includes provider prompt overhead in overflow decisions', () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Small request' },
    ];
    const result = applyContextGuard({
      history,
      contextWindowTokens: 1_024,
      promptOverheadTokens: 2_000,
      cache: createTokenEstimateCache(),
    });

    expect(result.totalTokensAfter).toBeGreaterThan(1_024);
    expect(result.tier3Triggered).toBe(true);
  });

  test('does not trigger tier 3 for prompt overhead within the hard context window', () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Small request' },
    ];
    const result = applyContextGuard({
      history,
      contextWindowTokens: 1_024,
      promptOverheadTokens: 920,
      cache: createTokenEstimateCache(),
    });

    expect(result.totalTokensAfter).toBeGreaterThan(
      result.overflowBudgetTokens,
    );
    expect(result.totalTokensAfter).toBeLessThanOrEqual(1_024);
    expect(result.tier3Triggered).toBe(false);
  });

  test('preserves history when pressure triggers compaction repeatedly', () => {
    const history = buildHistory();
    const original = structuredClone(history);
    const params = {
      history,
      contextWindowTokens: 1_024,
      cache: createTokenEstimateCache(),
    };
    expect(applyContextGuard(params).tier3Triggered).toBe(true);
    expect(applyContextGuard(params).tier3Triggered).toBe(true);
    expect(history).toEqual(original);
  });
});
