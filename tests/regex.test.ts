import { expect, test } from 'vitest';
import { escapeRegExp } from '../container/shared/regex.js';

const SYNTAX_CHARACTERS = '^$\\.*+?()[]{}|';

test.each([
  '',
  'plain words',
  SYNTAX_CHARACTERS,
  'a.b*c?(d)[e]{2}|f^g$h\\i',
  'dash-slash/ümlaut😀',
])('escapeRegExp(%j) matches itself with and without the u flag', (value) => {
  for (const flags of ['', 'u']) {
    expect(new RegExp(`^${escapeRegExp(value)}$`, flags).test(value)).toBe(
      true,
    );
  }
});

test('escapeRegExp escapes only syntax characters and adds no anchors', () => {
  expect(escapeRegExp(SYNTAX_CHARACTERS)).toBe(
    [...SYNTAX_CHARACTERS].map((char) => `\\${char}`).join(''),
  );
  expect(escapeRegExp('a-b/c')).toBe('a-b/c');
  expect(new RegExp(escapeRegExp('b.c')).test('ab.cd')).toBe(true);
  expect(new RegExp(escapeRegExp('b.c')).test('abxcd')).toBe(false);
});
