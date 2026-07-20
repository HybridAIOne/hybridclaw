import { expect, test } from 'vitest';

import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
  optimizeHistoryMessagesForPrompt,
  truncateHeadTailText,
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
  const headTail = truncateHeadTailText(content, 36, 0.85, 0.15);
  expect(headTail).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
  expect(headTail).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/u);
});

test('history optimization drops whole old turns without changing retained bytes', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: `old user ${'a'.repeat(40)}` },
    { role: 'assistant', content: `old answer ${'b'.repeat(40)}` },
    { role: 'user', content: `kept user ${'c'.repeat(40)}` },
    { role: 'assistant', content: `kept answer ${'d'.repeat(40)}` },
  ];

  const optimized = optimizeHistoryMessagesForPrompt(messages, {
    maxTotalChars: 110,
  });

  expect(optimized.messages).toEqual(messages.slice(2));
  expect(optimized.messages[0]?.content).toBe(messages[2]?.content);
  expect(optimized.messages[1]?.content).toBe(messages[3]?.content);
  expect(optimized.stats.droppedCount).toBe(2);
});

test('history optimization retains the newest whole turn when it exceeds the budget', () => {
  const newestTurn: ChatMessage[] = [
    { role: 'user', content: 'latest user request' },
    { role: 'assistant', content: 'x'.repeat(200) },
  ];
  const optimized = optimizeHistoryMessagesForPrompt(
    [
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old answer' },
      ...newestTurn,
    ],
    { maxTotalChars: 50 },
  );

  expect(optimized.messages).toEqual(newestTurn);
  expect(optimized.stats.includedChars).toBeGreaterThan(50);
});
