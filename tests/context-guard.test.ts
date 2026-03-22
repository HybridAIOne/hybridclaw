import { describe, expect, test } from 'vitest';

import {
  applyContextGuard,
  COMPACTED_TOOL_RESULT_PLACEHOLDER,
} from '../container/src/context-guard.js';
import { createTokenEstimateCache } from '../container/src/token-usage.js';
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
  test('truncates oversized tool results and compacts old ones first', () => {
    const history = buildHistory();
    const result = applyContextGuard({
      history,
      contextWindowTokens: 1_024,
      cache: createTokenEstimateCache(),
    });

    expect(result.truncatedToolResults).toBeGreaterThan(0);
    expect(result.compactedToolResults).toBe(0);
    expect(result.tier3Triggered).toBe(false);
    expect(typeof history[3]?.content).toBe('string');
    expect(String(history[3]?.content).length).toBeLessThan(1_600);
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

    expect(result.compactedToolResults).toBe(0);
    expect(result.tier3Triggered).toBe(true);
  });

  test('does not treat matching placeholder tool output as already compacted', () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'U'.repeat(1_800) },
      { role: 'assistant', content: 'A'.repeat(600) },
      {
        role: 'tool',
        content: COMPACTED_TOOL_RESULT_PLACEHOLDER,
        tool_call_id: 'call_1',
      },
      { role: 'assistant', content: 'B'.repeat(600) },
      {
        role: 'tool',
        content: 'C'.repeat(1_000),
        tool_call_id: 'call_2',
      },
      { role: 'assistant', content: 'Done.' },
    ];

    const result = applyContextGuard({
      history,
      contextWindowTokens: 1_024,
      cache: createTokenEstimateCache(),
    });

    expect(result.compactedToolResults).toBe(2);
    expect(history[3]?.content).toBe(COMPACTED_TOOL_RESULT_PLACEHOLDER);
    expect(history[5]?.content).toBe(COMPACTED_TOOL_RESULT_PLACEHOLDER);
  });
});
