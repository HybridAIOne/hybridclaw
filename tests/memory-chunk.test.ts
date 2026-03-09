import { describe, expect, test } from 'vitest';

import { chunkMessage } from '../src/memory/chunk.js';

describe('chunkMessage', () => {
  test('returns no chunks for blank input', () => {
    expect(chunkMessage('  \n\t  ')).toEqual([]);
  });

  test('normalizes newlines and leaves short messages untouched', () => {
    expect(chunkMessage('hello\r\nworld')).toEqual(['hello\nworld']);
  });

  test('splits long prose at sentence boundaries when available', () => {
    const sentence = `${'A'.repeat(70)}. `;
    const text = sentence.repeat(4);

    const chunks = chunkMessage(text, { maxChars: 200 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.length).toBeLessThanOrEqual(200);
    expect(chunks[1]?.length).toBeLessThanOrEqual(200);
    expect(chunks[0]?.endsWith('.')).toBe(true);
    expect(chunks[1]?.trimEnd().endsWith('.')).toBe(true);
  });

  test('splits long text at word boundaries when no sentence boundary exists', () => {
    const text = Array.from({ length: 80 }, () => 'chunk').join(' ');

    const chunks = chunkMessage(text, { maxChars: 200 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true);
    expect(chunks[0]?.endsWith(' ')).toBe(false);
    expect(chunks[1]?.startsWith(' ')).toBe(false);
  });

  test('falls back to hard character splits when no better boundary exists', () => {
    const text = 'x'.repeat(450);

    const chunks = chunkMessage(text, { maxChars: 200 });

    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 200, 50]);
  });

  test('falls back safely when a preferred split would trim to an empty head', () => {
    const text = `${' '.repeat(210)}tail`;

    const chunks = chunkMessage(text, { maxChars: 200 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(' '.repeat(200));
    expect(chunks[1]).toContain('tail');
  });

  test('splits on maxLines boundaries', () => {
    const text = Array.from(
      { length: 9 },
      (_, index) => `line ${index + 1}`,
    ).join('\n');

    const chunks = chunkMessage(text, { maxLines: 4 });

    expect(chunks).toEqual([
      'line 1\nline 2\nline 3\nline 4',
      'line 5\nline 6\nline 7\nline 8',
      'line 9',
    ]);
  });

  test('reopens fenced code blocks across chunks and closes them cleanly', () => {
    const text = [
      '```ts',
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
      'const d = 4;',
      '```',
    ].join('\n');

    const chunks = chunkMessage(text, { maxLines: 4 });

    expect(chunks).toEqual([
      '```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```',
      '```ts\nconst d = 4;\n```',
    ]);
  });
});
