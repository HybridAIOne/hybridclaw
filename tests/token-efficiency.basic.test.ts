import { expect, test } from 'vitest';

import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
} from '../src/session/token-efficiency.js';
import type { ChatMessage } from '../src/types.js';

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
