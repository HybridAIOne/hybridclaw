import { expect, test } from 'vitest';
import {
  createVoiceTextStreamFormatter,
  formatTextForVoice,
} from '../src/channels/voice/text.js';

test('formatTextForVoice strips markdown formatting for speech output', () => {
  expect(
    formatTextForVoice(
      '**Yes**. Use `npm run test`. [Docs](https://example.com/docs)',
    ),
  ).toBe('Yes. Use npm run test. Docs');
});

test('createVoiceTextStreamFormatter batches short deltas and removes markdown markers', () => {
  const formatter = createVoiceTextStreamFormatter();

  expect(formatter.push('**Yes')).toEqual([]);
  expect(formatter.push('** that works.')).toEqual(['Yes that works.']);
  expect(formatter.push(' Next answer')).toEqual([]);
  expect(formatter.flush()).toEqual(['Next answer']);
});

test('createVoiceTextStreamFormatter emits longer text at whitespace boundaries', () => {
  const formatter = createVoiceTextStreamFormatter();

  expect(
    formatter.push(
      'This response keeps streaming without punctuation so it should still flush once it is long enough ',
    ),
  ).toEqual([
    'This response keeps streaming without punctuation so it should still flush once it is long enough',
  ]);
  expect(formatter.flush()).toEqual([]);
});
