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
