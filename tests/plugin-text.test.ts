import { expect, test } from 'vitest';

import {
  appendTruncationNotice,
  latestMessageByRole,
  normalizeText,
  truncateText,
} from '../src/plugins/plugin-text.ts';

test.each([
  { value: 'a  \t\r\nb', options: {}, expected: 'a\nb' },
  { value: '\n\na\n\n\n\nb  \n', options: {}, expected: 'a\n\nb' },
  { value: 'a  \t b', options: {}, expected: 'a  \t b' },
  { value: 'a  \t b', options: { collapseSpaces: true }, expected: 'a b' },
  {
    value: `a${'\t'.repeat(100_000)}b`,
    options: {},
    expected: `a${'\t'.repeat(100_000)}b`,
  },
  { value: undefined, options: {}, expected: '' },
])('normalizeText($value, $options)', ({ value, options, expected }) => {
  expect(normalizeText(value, options)).toBe(expected);
});

test.each([
  { value: '  short  ', maxChars: 10, expected: 'short' },
  { value: 'abcdefghij', maxChars: 5, expected: 'abcd…' },
  { value: 'abc   defgh', maxChars: 6, expected: 'abc…' },
  { value: 'no limit', maxChars: undefined, expected: 'no limit' },
  { value: 'zero means none', maxChars: 0, expected: 'zero means none' },
  { value: 42, maxChars: 10, expected: '42' },
  { value: null, maxChars: 10, expected: '' },
])('truncateText($value, $maxChars)', ({ value, maxChars, expected }) => {
  expect(truncateText(value, maxChars)).toBe(expected);
});

test.each([
  { text: 'body', expected: 'body\n\n[QMD output truncated]' },
  { text: '', expected: '[QMD output truncated]' },
])('appendTruncationNotice($text)', ({ text, expected }) => {
  expect(appendTruncationNotice(text, 'QMD output')).toBe(expected);
});

test.each([
  {
    name: 'the latest timestamp, whatever the array order',
    messages: [
      { role: 'user', content: 'new', created_at: '2026-03-19T10:05:00Z' },
      { role: 'user', content: 'old', created_at: '2026-03-19T10:00:00Z' },
    ],
    expected: 'new',
  },
  {
    name: 'the higher id on a timestamp tie',
    messages: [
      { role: 'user', content: 'high', created_at: '2026-03-19T10:00:00Z', id: 9 },
      { role: 'user', content: 'low', created_at: '2026-03-19T10:00:00Z', id: 3 },
    ],
    expected: 'high',
  },
  {
    name: 'the later entry when nothing else orders them',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ],
    expected: 'second',
  },
  {
    name: 'only the requested role, case-insensitively',
    messages: [
      { role: 'USER', content: 'question' },
      { role: 'assistant', content: 'reply' },
    ],
    expected: 'question',
  },
  {
    name: 'null when no message has the role',
    messages: [{ role: 'assistant', content: 'reply' }],
    expected: undefined,
  },
])('latestMessageByRole picks $name', ({ messages, expected }) => {
  expect(latestMessageByRole(messages, 'user')?.content).toBe(expected);
});

test('latestMessageByRole tolerates a missing transcript', () => {
  expect(latestMessageByRole(undefined, 'user')).toBeNull();
});
