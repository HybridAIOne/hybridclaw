import { expect, test } from 'vitest';
import { SILENT_REPLY_TOKEN } from '../src/agent/silent-reply.js';
import {
  buildVoiceChatRecap,
  VOICE_CHAT_RECAP_MAX_CHARS,
  VOICE_CHAT_RECAP_MAX_MESSAGES,
} from '../src/channels/voice/chat-recap.js';

function turn(role: string, content: string) {
  return { role, content };
}

test.each([
  ['no messages and no summary', { messages: [] }],
  ['a blank summary', { summary: '  \n ', messages: [] }],
  [
    'only empty or non-chat rows',
    {
      summary: null,
      messages: [
        turn('user', '   '),
        turn('assistant', ''),
        turn('system', 'You are a helpful assistant.'),
        turn('tool', '{"ok":true}'),
        turn('assistant', SILENT_REPLY_TOKEN),
      ],
    },
  ],
])('returns null for %s', (_label, input) => {
  expect(buildVoiceChatRecap(input)).toBeNull();
});

test('a summary alone yields a single labelled line', () => {
  const recap = buildVoiceChatRecap({
    summary: 'Planning the\n\nLisbon offsite.',
    messages: [],
  });

  expect(recap?.split('\n')).toHaveLength(1);
  expect(recap).toContain('Planning the Lisbon offsite.');
});

test('numbers, links and emphasis reach the recap unchanged', () => {
  const recap = buildVoiceChatRecap({
    messages: [
      turn(
        'assistant',
        'Roughly 9.600 Euro, or 1,5 per head: **see** https://example.test/p',
      ),
    ],
  });

  expect(recap).toBe(
    'Assistant: Roughly 9.600 Euro, or 1,5 per head: **see** https://example.test/p',
  );
});

test('keeps user and assistant turns oldest first, summary ahead of them', () => {
  const recap = buildVoiceChatRecap({
    summary: 'Earlier: budget talk.',
    messages: [
      turn('user', 'Which venue is cheaper?'),
      turn('system', 'internal note'),
      turn('tool', 'venue lookup output'),
      turn('assistant', '\nThe **riverside** one,   by a wide\tmargin.\n'),
      turn('user', 'Book it.'),
    ],
  });

  const lines = recap?.split('\n') ?? [];
  expect(lines).toHaveLength(4);
  expect(lines[0]).toContain('Earlier: budget talk.');
  expect(lines.slice(1)).toEqual([
    'User: Which venue is cheaper?',
    'Assistant: The **riverside** one, by a wide margin.',
    'User: Book it.',
  ]);
  expect(recap).not.toContain('internal note');
  expect(recap).not.toContain('venue lookup output');
});

test('long messages and summaries are truncated with an ellipsis', () => {
  const recap = buildVoiceChatRecap({
    summary: `summary ${'s'.repeat(2_000)}`,
    messages: [turn('user', `question ${'q'.repeat(2_000)}`)],
  });

  const [summaryLine, userLine] = recap?.split('\n') ?? [];
  expect(summaryLine.endsWith('...')).toBe(true);
  expect(userLine.endsWith('...')).toBe(true);
  expect(summaryLine.length).toBeLessThan(700);
  expect(userLine.length).toBeLessThan(320);
});

test('only the newest messages of a long chat are kept', () => {
  const messages = Array.from({ length: 30 }, (_value, index) =>
    turn(index % 2 === 0 ? 'user' : 'assistant', `turn ${index}`),
  );

  const lines = buildVoiceChatRecap({ messages })?.split('\n') ?? [];

  expect(lines).toHaveLength(VOICE_CHAT_RECAP_MAX_MESSAGES);
  expect(lines[0]).toBe('User: turn 18');
  expect(lines.at(-1)).toBe('Assistant: turn 29');
});

test('over the total cap the oldest messages go first and the newest stays', () => {
  const messages = Array.from({ length: VOICE_CHAT_RECAP_MAX_MESSAGES }, (
    _value,
    index,
  ) => turn('user', `turn ${index} ${'x'.repeat(400)}`));

  const recap = buildVoiceChatRecap({
    summary: `summary ${'s'.repeat(2_000)}`,
    messages,
  });
  const lines = recap?.split('\n') ?? [];
  const keptTurns = lines.slice(1).map((line) => line.split(' ')[2]);

  expect(recap?.length).toBeLessThanOrEqual(VOICE_CHAT_RECAP_MAX_CHARS);
  expect(lines[0]).toContain('summary');
  expect(keptTurns.length).toBeGreaterThan(0);
  expect(keptTurns.length).toBeLessThan(VOICE_CHAT_RECAP_MAX_MESSAGES);
  // A contiguous tail: every dropped message is older than every kept one.
  const newest = VOICE_CHAT_RECAP_MAX_MESSAGES - 1;
  expect(keptTurns).toEqual(
    keptTurns.map((_turn, index) =>
      String(newest - (keptTurns.length - 1) + index),
    ),
  );
});
