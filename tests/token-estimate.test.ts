import type { ChatMessage } from '@hybridclaw/contracts/agent-io';
import {
  createTokenEstimateCache,
  estimateChatMessageTokens,
  estimateMessageTokens,
  estimateTextTokens,
} from '@hybridclaw/shared/token-estimate';
import { describe, expect, test } from 'vitest';

const IMAGE = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } };

describe('token estimate', () => {
  test('counts text at four characters per token', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens(null)).toBe(0);
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('abcde')).toBe(2);
  });

  test('adds request priming and per-message framing', () => {
    expect(estimateMessageTokens([])).toBe(0);
    expect(estimateMessageTokens([{ role: 'assistant', content: null }])).toBe(
      2 + 4 + estimateTextTokens('assistant'),
    );
    expect(
      estimateMessageTokens([
        { role: 'user', content: [{ type: 'text', text: 'hello' }, IMAGE] },
      ] as ChatMessage[]),
    ).toBe(2 + 4 + estimateTextTokens('user') + estimateTextTokens('hello\n[image]'));
  });

  test('counts tool results denser than prose', () => {
    const content = 'x'.repeat(200);
    expect(estimateChatMessageTokens({ role: 'tool', content })).toBe(
      estimateChatMessageTokens({ role: 'user', content }) + 50,
    );
  });

  test.each([
    ['tool_calls', { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] }],
    ['tool_call_id', { tool_call_id: 'call_1' }],
    ['anthropic_content', { anthropic_content: [{ type: 'thinking', thinking: 'plan' }] }],
    ['openai_response_items', { openai_response_items: [{ type: 'reasoning', summary: [] }] }],
  ] as const)('counts %s, which can reach a provider', (_field, extra) => {
    const base: ChatMessage = { role: 'assistant', content: 'done' };
    expect(
      estimateChatMessageTokens({ ...base, ...extra } as ChatMessage),
    ).toBeGreaterThan(estimateChatMessageTokens(base));
  });

  test('reserves a fixed budget per visual page', () => {
    const base: ChatMessage = { role: 'user', content: 'see' };
    const plain = estimateChatMessageTokens(base);
    expect(
      estimateChatMessageTokens({
        ...base,
        visualAttachments: [
          { id: 'img', pages: [] },
          { id: 'pdf', pages: [1, 2] },
        ],
      }),
    ).toBe(plain + 3 * 4_000);
  });

  test('reuses cached message estimates until the caller invalidates them', () => {
    const cache = createTokenEstimateCache();
    const message: ChatMessage = {
      role: 'tool',
      content: 'x'.repeat(240),
      tool_call_id: 'call_1',
    };

    const original = estimateChatMessageTokens(message, cache);
    message.content = 'short';
    expect(estimateChatMessageTokens(message, cache)).toBe(original);

    cache.delete(message);
    expect(estimateChatMessageTokens(message, cache)).toBeLessThan(original);
  });
});
