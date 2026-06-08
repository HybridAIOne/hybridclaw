import { expect, test } from 'vitest';

import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
  truncateHeadTailText,
  truncateMessageContent,
} from '../src/session/token-efficiency.js';
import type { ChatMessage } from '../src/types/api.js';

test('estimateTokenCountFromText uses simple chars-per-token heuristic', () => {
  expect(estimateTokenCountFromText('')).toBe(0);
  expect(estimateTokenCountFromText('abcd')).toBe(1);
  expect(estimateTokenCountFromText('abcde')).toBe(2);
});

test('estimateTokenCountFromMessages supports multimodal content arrays', () => {
  const messages: Array<Pick<ChatMessage, 'role' | 'content'>> = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        {
          type: 'image_url',
          image_url: { url: '/discord-media-cache/example.png' },
        },
      ],
    },
  ];
  const tokenCount = estimateTokenCountFromMessages(messages);
  expect(tokenCount).toBe(11);
});

test('estimateTokenCountFromMessages handles null message content', () => {
  const messages: Array<Pick<ChatMessage, 'role' | 'content'>> = [
    { role: 'assistant', content: null },
  ];
  const tokenCount = estimateTokenCountFromMessages(messages);
  expect(tokenCount).toBe(9);
});

test('prompt truncation does not split UTF-16 surrogate pairs', () => {
  const content = `prefix ${'a'.repeat(20)} 🏠 suffix`;
  const truncated = truncateMessageContent(content, 30);
  expect(truncated).not.toContain('\ud83d\n');
  expect(truncated).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
  expect(truncated).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/u);

  const headTail = truncateHeadTailText(content, 36, 0.85, 0.15);
  expect(headTail).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
  expect(headTail).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/u);
});
