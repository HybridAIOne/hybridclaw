import { expect, test } from 'vitest';

import { summarizeMediaFilenames } from '../src/media/media-summary.js';

test('summarizeMediaFilenames returns a single filename unchanged', () => {
  expect(summarizeMediaFilenames(['report.pdf'])).toBe('report.pdf');
});

test('summarizeMediaFilenames truncates long filename lists consistently', () => {
  expect(
    summarizeMediaFilenames([
      'one.png',
      'two.png',
      'three.png',
      'four.png',
      'five.png',
    ]),
  ).toBe('one.png, two.png, three.png, and 2 more');
});
