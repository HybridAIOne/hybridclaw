import { describe, expect, test } from 'vitest';

import { compactInLoop } from '../container/src/in-loop-compaction.js';
import type { ChatMessage } from '../container/src/types.js';

function buildHistory(): ChatMessage[] {
  return [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'User 1' },
    { role: 'assistant', content: 'Assistant 1' },
    { role: 'user', content: 'User 2' },
    { role: 'assistant', content: 'Assistant 2' },
    { role: 'tool', content: 'Tool 1', tool_call_id: 'call_1' },
    { role: 'assistant', content: 'Assistant 3' },
    { role: 'user', content: 'User 3' },
    { role: 'assistant', content: 'Assistant 4' },
    { role: 'tool', content: 'Tool 2', tool_call_id: 'call_2' },
    { role: 'assistant', content: 'Assistant 5' },
    { role: 'user', content: 'User 4' },
    { role: 'assistant', content: 'Assistant 6' },
    { role: 'user', content: 'User 5' },
    { role: 'assistant', content: 'Assistant 7' },
    { role: 'user', content: 'User 6' },
  ];
}

describe('compactInLoop', () => {
  test('preserves the protected prefix and suffix and inserts a summary', async () => {
    const history = buildHistory();
    const result = await compactInLoop({
      history,
      contextWindowTokens: 128_000,
      summarize: async () =>
        '## Goals\nKeep going.\n\n## Next\nUse the latest tool state.',
    });

    expect(result.changed).toBe(true);
    expect(result.compactedMessages).toBeGreaterThan(0);
    expect(result.summarySource).toBe('llm');
    expect(result.history.slice(0, 5)).toEqual(history.slice(0, 5));
    expect(result.history.slice(-8)).toEqual(history.slice(-8));
    expect(
      result.history.some((message) =>
        String(message.content).includes('[In-loop compaction summary]'),
      ),
    ).toBe(true);
  });

  test('falls back to a heuristic summary when the summarizer fails', async () => {
    const result = await compactInLoop({
      history: buildHistory(),
      contextWindowTokens: 128_000,
      summarize: async () => {
        throw new Error('boom');
      },
    });

    expect(result.changed).toBe(true);
    expect(result.summarySource).toBe('heuristic');
    expect(
      result.history.some((message) =>
        String(message.content).includes(
          'Compacted earlier conversation to stay within the active model context window.',
        ),
      ),
    ).toBe(true);
  });
});
