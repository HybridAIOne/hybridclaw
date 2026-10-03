import { describe, expect, test, vi } from 'vitest';

import { compactInLoop } from '../container/src/in-loop-compaction.js';
import { estimateMessageTokens } from '../container/src/token-usage.js';
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
    { role: 'assistant', content: 'Assistant 3 '.repeat(50) },
    { role: 'user', content: 'User 3 '.repeat(50) },
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
      archive: () => 'archive.json',
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
      archive: () => 'archive.json',
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
      { role: 'user', content: 'User 3 '.repeat(50) },
      { role: 'assistant', content: null, tool_calls: calls },
      { role: 'tool', content: 'Tool A', tool_call_id: 'call_a' },
      { role: 'tool', content: 'Tool B', tool_call_id: 'call_b' },
      { role: 'assistant', content: 'Assistant 3 '.repeat(50) },
      { role: 'user', content: 'User 4' },
      { role: 'assistant', content: 'Assistant 4' },
      { role: 'user', content: 'User 5' },
      { role: 'assistant', content: 'Assistant 5' },
      { role: 'user', content: 'User 6' },
    ];

    const result = await compactInLoop({
      history,
      archive: () => 'archive.json',
      summarize: async () => 'Summary',
    });

    const summaryIndex = result.history.findIndex((message) =>
      String(message.content).startsWith('[In-loop compaction summary]'),
    );
    expect(result.history.slice(summaryIndex + 1, summaryIndex + 4)).toEqual(
      history.slice(6, 9),
    );
  });

  test('summarizes all 28 selected messages without truncating content or metadata', async () => {
    const pendingDecision =
      'Pending decision: confirm the migration before deployment.';
    const history: ChatMessage[] = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${index}: ${'x'.repeat(4_000)}`,
    }));
    history[25].content = `${'x'.repeat(3_000)}${pendingDecision}${'y'.repeat(1_000)}`;
    history[10] = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          ...toolCall('call_full'),
          function: {
            name: 'test_tool',
            arguments: JSON.stringify({ text: 'z'.repeat(4_000) }),
          },
        },
      ],
    };
    history[11] = {
      role: 'tool',
      content: 'result '.repeat(1_000),
      tool_call_id: 'call_full',
      is_error: true,
    };
    history[12].content = [
      { type: 'text', text: 'Multimodal detail '.repeat(200) },
      {
        type: 'image_url',
        image_url: { url: 'https://example.com/image.png' },
      },
    ];
    const original = structuredClone(history);
    const archive = vi.fn(() => 'archive.json');
    const summarize = vi.fn(async (messages: ChatMessage[]) => {
      expect(messages.slice(0, -1)).toEqual(original.slice(4, 32));
      expect(messages.at(-1)?.role).toBe('user');
      expect(
        messages.some((message) =>
          String(message.content).includes(pendingDecision),
        ),
      ).toBe(true);
      return pendingDecision;
    });

    const result = await compactInLoop({ history, summarize, archive });

    expect(result.compactedMessages).toBe(28);
    expect(summarize).toHaveBeenCalledOnce();
    expect(archive).toHaveBeenCalledExactlyOnceWith(original.slice(4, 32));
    expect(result.history[4].content).toContain(pendingDecision);
    expect(result.history[4].content).toContain('archive.json');
    expect(estimateMessageTokens(result.history)).toBeLessThan(
      estimateMessageTokens(history),
    );
    expect(history).toEqual(original);
  });

  test.each([
    {
      name: 'fails',
      summarize: async () => {
        throw new Error('boom');
      },
    },
    { name: 'is empty', summarize: async () => '' },
    { name: 'is whitespace', summarize: async () => '  \n  ' },
    {
      name: 'is an empty code fence',
      summarize: async () => '\x60\x60\x60md\n\x60\x60\x60',
    },
    { name: 'grows the region', summarize: async () => 'x'.repeat(7_000) },
  ])('preserves history when summarization $name', async ({ summarize }) => {
    const history = buildHistory();
    const archive = vi.fn(() => 'archive.json');
    const result = await compactInLoop({ history, summarize, archive });

    expect(result).toEqual({
      history,
      changed: false,
      compactedMessages: 0,
      summarySource: 'none',
    });
    expect(result.history).toBe(history);
    expect(archive).not.toHaveBeenCalled();
  });

  test('counts summary framing and archive references in the shrink check', async () => {
    const summary = 'Summary';
    const content = `[In-loop compaction summary]\n${summary}\n\nOriginal messages: archive.json`;
    const history: ChatMessage[] = Array.from({ length: 13 }, () => ({
      role: 'assistant',
      content,
    }));
    const result = await compactInLoop({
      history,
      summarize: async () => summary,
      archive: () => 'archive.json',
    });

    expect(result.changed).toBe(false);
    expect(result.history).toBe(history);
  });

  test('does not replace messages when archiving fails', async () => {
    const history = buildHistory();
    const result = await compactInLoop({
      history,
      summarize: async () => 'Summary',
      archive: () => {
        throw new Error('disk full');
      },
    });

    expect(result.changed).toBe(false);
    expect(result.history).toBe(history);
  });

  test('keeps original messages independent of summarizer mutations', async () => {
    const history = buildHistory();
    const original = structuredClone(history);
    const archive = vi.fn(() => 'archive.json');
    const result = await compactInLoop({
      history,
      archive,
      summarize: async (messages) => {
        messages[0].content = 'Provider rewrite';
        return '\x60\x60\x60md\nSummary\n\x60\x60\x60';
      },
    });

    expect(result.changed).toBe(true);
    expect(result.history[6].content).toContain('Summary');
    expect(result.history[6].content).not.toContain('```');
    expect(history).toEqual(original);
    expect(archive).toHaveBeenCalledExactlyOnceWith(original.slice(6, 8));
  });

  test('does not summarize when no complete tool-safe region is available', async () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User request' },
    ];
    const summarize = vi.fn(async () => 'Summary');
    const archive = vi.fn(() => 'archive.json');
    const result = await compactInLoop({ history, summarize, archive });

    expect(result.changed).toBe(false);
    expect(result.history).toBe(history);
    expect(summarize).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });
});
