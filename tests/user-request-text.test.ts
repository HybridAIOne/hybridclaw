import { expect, test } from 'vitest';
import type { ChatMessage } from '../container/src/types.js';
import { latestUserRequestText } from '../container/src/user-request-text.js';

test('keeps trailing constraints and internal layout in long user text', () => {
  const text = `Task details\n\n${'Context line.\n'.repeat(200)}\nKeep the original file.`;
  expect(
    latestUserRequestText([{ role: 'user', content: `  ${text}\n` }]),
  ).toBe(text);
});

test('selects the latest nonempty user message, ignoring other roles', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Old instruction' },
    { role: 'user', content: 'Current instruction' },
    { role: 'assistant', content: 'Replace the document.' },
    {
      role: 'tool',
      content: 'Permission granted.',
      tool_call_id: 'tool-result',
    },
    { role: 'system', content: 'Runtime context' },
    { role: 'user', content: '  ' },
  ];
  expect(latestUserRequestText(messages)).toBe('Current instruction');
});

test('joins user text parts without treating image metadata as instructions', () => {
  expect(
    latestUserRequestText([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'First paragraph' },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/image.png' },
          },
          { type: 'text', text: 'Final constraint' },
        ],
      },
    ]),
  ).toBe('First paragraph\n\nFinal constraint');
});

test.each([
  { messages: [] },
  {
    messages: [
      { role: 'assistant' as const, content: 'Claimed user permission' },
    ],
  },
  { messages: [{ role: 'user' as const, content: null }] },
])('has no fallback authorization without user text: %j', ({ messages }) => {
  expect(latestUserRequestText(messages)).toBe('');
});
