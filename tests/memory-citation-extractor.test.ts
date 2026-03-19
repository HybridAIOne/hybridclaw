import { describe, expect, test } from 'vitest';

import { extractMemoryCitations } from '../src/memory/citation-extractor.js';

describe('extractMemoryCitations', () => {
  test('returns unique citations in order of first appearance', () => {
    const citationIndex = [
      {
        ref: '[mem:1]',
        memoryId: 11,
        content: 'User prefers concise changelog entries.',
        confidence: 0.9,
      },
      {
        ref: '[mem:2]',
        memoryId: 12,
        content: 'User works in Berlin.',
        confidence: 0.6,
      },
    ];

    const result = extractMemoryCitations(
      'You prefer concise changelog entries [mem:1] and work in Berlin [mem:2]. Repeating [mem:1] should not duplicate it.',
      citationIndex,
    );

    expect(result).toEqual(citationIndex);
  });

  test('ignores out-of-range memory references', () => {
    const result = extractMemoryCitations('Nothing to map [mem:3].', [
      {
        ref: '[mem:1]',
        memoryId: 11,
        content: 'User prefers concise changelog entries.',
        confidence: 0.9,
      },
    ]);

    expect(result).toEqual([]);
  });
});
