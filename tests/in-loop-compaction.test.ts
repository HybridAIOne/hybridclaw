import { describe, expect, test } from 'vitest';

import { compactInLoop } from '../container/src/in-loop-compaction.js';
import type { ChatMessage, ToolCall } from '../container/src/types.js';

function toolCall(id: string): ToolCall {
  return {
    id,
    type: 'function',
    function: { name: 'test_tool', arguments: '{}' },
  };
}

function buildHistory(): ChatMessage[] {
  return [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'User 1' },
    { role: 'assistant', content: 'Assistant 1' },
    { role: 'user', content: 'User 2' },
    {
      role: 'assistant',
      content: 'Assistant 2',
      tool_calls: [toolCall('call_1')],
    },
    { role: 'tool', content: 'Tool 1', tool_call_id: 'call_1' },
    { role: 'assistant', content: 'Assistant 3' },
    { role: 'user', content: 'User 3' },
    {
      role: 'assistant',
      content: 'Assistant 4',
      tool_calls: [toolCall('call_2')],
    },
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

  test('does not leave protected prefix tool calls unanswered', async () => {
    const history = buildHistory();
    const result = await compactInLoop({
      history,
      summarize: async () => 'Summary',
    });

    const summaryIndex = result.history.findIndex((message) =>
      String(message.content).startsWith('[In-loop compaction summary]'),
    );
    expect(result.history[summaryIndex - 1]).toEqual(history[5]);
    expect(result.history[summaryIndex - 1]?.role).toBe('tool');
  });

  test('keeps parallel tool calls with every result when adjusting the protected tail', async () => {
    const calls = [toolCall('call_a'), toolCall('call_b')];
    const history: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User 1' },
      { role: 'assistant', content: 'Assistant 1' },
      { role: 'user', content: 'User 2' },
      { role: 'assistant', content: 'Assistant 2' },
      { role: 'user', content: 'User 3' },
      { role: 'assistant', content: null, tool_calls: calls },
      { role: 'tool', content: 'Tool A', tool_call_id: 'call_a' },
      { role: 'tool', content: 'Tool B', tool_call_id: 'call_b' },
      { role: 'assistant', content: 'Assistant 3' },
      { role: 'user', content: 'User 4' },
      { role: 'assistant', content: 'Assistant 4' },
      { role: 'user', content: 'User 5' },
      { role: 'assistant', content: 'Assistant 5' },
      { role: 'user', content: 'User 6' },
    ];

    const result = await compactInLoop({
      history,
      summarize: async () => 'Summary',
    });

    const summaryIndex = result.history.findIndex((message) =>
      String(message.content).startsWith('[In-loop compaction summary]'),
    );
    expect(result.history.slice(summaryIndex + 1, summaryIndex + 4)).toEqual(
      history.slice(6, 9),
    );
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

  test('keeps the normalized summary within maxSummaryChars when truncating', async () => {
    const result = await compactInLoop({
      history: buildHistory(),
      contextWindowTokens: 128_000,
      summarize: async () => `\`\`\`md\n${'x'.repeat(7_000)}\n\`\`\``,
    });

    const summaryMessage = result.history.find((message) =>
      String(message.content).startsWith('[In-loop compaction summary]\n'),
    );
    expect(summaryMessage).toBeDefined();

    const summaryBody = String(summaryMessage?.content).slice(
      '[In-loop compaction summary]\n'.length,
    );
    expect(summaryBody.length).toBeLessThanOrEqual(6_000);
    expect(summaryBody.includes('```')).toBe(false);
    expect(summaryBody.endsWith('\n\n...[truncated]')).toBe(true);
  });
});
