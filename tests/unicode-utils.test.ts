import { describe, expect, test } from 'vitest';

import {
  repairUnicodeForJson,
  replaceUnpairedSurrogates,
  replaceUnsafeJsonStorageChars,
} from '../container/shared/unicode-utils.js';

// The previous character-by-character implementation, kept as the reference
// the built-in fast paths must match.
function referenceSurrogates(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] + value[index + 1];
        index += 1;
      } else {
        output += '�';
      }
      continue;
    }
    output += code >= 0xdc00 && code <= 0xdfff ? '�' : value[index];
  }
  return output;
}

function referenceStorage(value: string): string {
  let output = '';
  for (const char of referenceSurrogates(value)) {
    const code = char.charCodeAt(0);
    const unsafe =
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f;
    output += unsafe ? '�' : char;
  }
  return output;
}

const ALPHABET = [
  'a',
  'ß',
  '東',
  '\t',
  '\n',
  '\r',
  '\u0000',
  '\u0008',
  '\u000b',
  '\u001f',
  '\u007f',
  '\ud83d',
  '\ude00',
  '😀',
];

function fuzzStrings(count: number): string[] {
  let seed = 42;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed;
  };
  return Array.from({ length: count }, () =>
    Array.from(
      { length: next() % 12 },
      () => ALPHABET[next() % ALPHABET.length],
    ).join(''),
  );
}

describe('unicode repair', () => {
  test.each([
    ['a lone high surrogate at the end', 'ab\ud83d'],
    ['a lone low surrogate', '\ude00cd'],
    ['a reversed pair', '\ude00\ud83d'],
    ['a valid pair', 'ok 😀'],
    ['two highs before a low', '\ud83d😀'],
    ['plain text', 'Größe 東京'],
  ])('matches the reference for %s', (_label, value) => {
    expect(replaceUnpairedSurrogates(value)).toBe(referenceSurrogates(value));
    expect(replaceUnsafeJsonStorageChars(value)).toBe(referenceStorage(value));
  });

  test('matches the reference on generated strings', () => {
    for (const value of fuzzStrings(2_000)) {
      expect(replaceUnpairedSurrogates(value)).toBe(referenceSurrogates(value));
      expect(replaceUnsafeJsonStorageChars(value)).toBe(
        referenceStorage(value),
      );
    }
  });

  test('keeps tab, newline, and carriage return in stored JSON text', () => {
    expect(replaceUnsafeJsonStorageChars('a\tb\nc\rd\u0001e')).toBe(
      'a\tb\nc\rd�e',
    );
  });

  test('repairs keys and nested values', () => {
    expect(
      repairUnicodeForJson({ 'k\u0000': ['v\ud83d', { n: 1 }] }),
    ).toEqual({ 'k�': ['v�', { n: 1 }] });
  });
});
