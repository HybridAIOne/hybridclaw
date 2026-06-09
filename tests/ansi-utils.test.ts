import { expect, test } from 'vitest';

import {
  getAnsiSequenceLength,
  stripAnsi,
  truncateAnsi,
  visibleAnsiWidth,
} from '../src/utils/ansi.js';

test('strips ANSI escape sequences without removing visible text', () => {
  expect(stripAnsi('\x1b[31mred\x1b[0m plain')).toBe('red plain');
  expect(getAnsiSequenceLength('\x1b[1;33mtext', 0)).toBe(7);
});

test('treats incomplete trailing CSI sequences as non-visible control text', () => {
  expect(stripAnsi('ready\x1b[')).toBe('ready');
  expect(visibleAnsiWidth('ready\x1b[')).toBe(5);
  expect(getAnsiSequenceLength('ready\x1b[', 5)).toBe(2);
});

test('counts terminal cell width for ANSI-styled and wide glyph text', () => {
  expect(visibleAnsiWidth('\x1b[32m界e\u0301✅\x1b[0m')).toBe(5);
});

test('truncates ANSI-styled text without splitting escape sequences', () => {
  expect(
    truncateAnsi('\x1b[36malpha beta\x1b[0m', 8, {
      ellipsis: '...',
      reset: '\x1b[0m',
      resetMode: 'ansi',
    }),
  ).toBe('\x1b[36malpha...\x1b[0m');
});

test('omits truncation markers that cannot fit in the target width', () => {
  expect(truncateAnsi('abc', 1, { ellipsis: '...' })).toBe('a');
});
