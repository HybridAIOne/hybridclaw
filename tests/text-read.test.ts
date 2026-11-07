import { describe, expect, test } from 'vitest';
import { readTextExcerpt } from '../container/src/text-read.js';

describe('bounded text reads', () => {
  test('pages through a single line without repeating or losing characters', () => {
    const text = 'abcdef'.repeat(1_000);
    let offset: number | null = 0;
    let recovered = '';
    while (offset !== null) {
      const page = JSON.parse(
        readTextExcerpt(text, { char_offset: offset, max_chars: 100_000 })!,
      );
      expect(page.text.length).toBeLessThanOrEqual(2_000);
      recovered += page.text;
      offset = page.nextOffset;
    }
    expect(recovered).toBe(text);
  });

  test('searches literal text beyond the head excerpt and continues to later matches', () => {
    const needle = '[item.*]';
    const text = 'x'.repeat(50_000) + needle + 'y'.repeat(50_000) + needle;
    const first = JSON.parse(
      readTextExcerpt(text, { query: needle, max_chars: 100 })!,
    );
    const second = JSON.parse(
      readTextExcerpt(text, { query: needle, char_offset: first.nextOffset })!,
    );
    expect(first.matchOffset).toBe(50_000);
    expect(second.matchOffset).toBe(100_000 + needle.length);
    expect(second.text).toContain(needle);
    expect(
      JSON.parse(readTextExcerpt(text, { query: 'missing' })!),
    ).toMatchObject({ found: false, nextOffset: null });
  });

  test('leaves ordinary line reads unchanged and bounds JSON escaping', () => {
    expect(readTextExcerpt('ordinary', {})).toBeUndefined();
    expect(
      readTextExcerpt('\u0001'.repeat(100_000), { char_offset: 0 })!.length,
    ).toBeLessThan(16_000);
  });

  test.each([
    { char_offset: -1 },
    { char_offset: 1.5 },
    { char_offset: 100 },
    { max_chars: 0 },
    { max_chars: Infinity },
    { query: '' },
    { query: {} },
  ])('rejects invalid arguments %j', (args) => {
    expect(() => readTextExcerpt('example', args)).toThrow();
  });
});
