import { expect, test } from 'vitest';

import { normalizeLower } from '../plugins/brevo-email/src/normalize.js';

test('normalizeLower trims and lowercases string-like values', () => {
  expect(normalizeLower('  Steve-CF4  ')).toBe('steve-cf4');
  expect(normalizeLower(null)).toBe('');
  expect(normalizeLower(42)).toBe('42');
});
