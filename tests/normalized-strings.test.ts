import { expect, test } from 'vitest';
import { dedupeStrings } from '../src/utils/normalized-strings.js';

test('dedupeStrings trims before deduping and drops blank entries', () => {
  expect(dedupeStrings([' foo', 'foo', '', '  ', 'bar ', 'bar'])).toEqual([
    'foo',
    'bar',
  ]);
});

test('dedupeStrings preserves legacy value coercion', () => {
  expect(dedupeStrings(['0', 0, false, 'false', true])).toEqual([
    '0',
    'false',
    'true',
  ]);
});
