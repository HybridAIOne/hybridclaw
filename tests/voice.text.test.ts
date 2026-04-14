import { expect, test } from 'vitest';
import {
  createVoiceTextStreamFormatter,
  formatTextForVoice,
  normalizeVoiceUserTextForGateway,
} from '../src/channels/voice/text.js';

test('formatTextForVoice strips markdown formatting for speech output', () => {
  expect(
    formatTextForVoice(
      '**Yes**. Use `npm run test`. [Docs](https://example.com/docs)',
    ),
  ).toBe('Yes. Use npm run test. Docs');
});

test('formatTextForVoice removes leading orphan marker runs before speech output', () => {
  expect(formatTextForVoice('* * * **Yes**')).toBe('Yes');
});

test('formatTextForVoice preserves literal keypad characters', () => {
  expect(formatTextForVoice('Press * * to continue.')).toBe(
    'Press * * to continue.',
  );
  expect(formatTextForVoice('Dial *67 now.')).toBe('Dial *67 now.');
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

test('normalizeVoiceUserTextForGateway canonicalizes approval phrases from speech transcripts', () => {
  expect(normalizeVoiceUserTextForGateway('Yes for a session.')).toBe(
    'yes for session',
  );
  expect(normalizeVoiceUserTextForGateway('Yes. For session.')).toBe(
    'yes for session',
  );
  expect(normalizeVoiceUserTextForGateway('Yes for agent.')).toBe(
    'yes for agent',
  );
  expect(normalizeVoiceUserTextForGateway('No.')).toBe('no');
});

test('normalizeVoiceUserTextForGateway leaves normal prompts untouched', () => {
  expect(
    normalizeVoiceUserTextForGateway(
      "What's the weather going to be in Stockdorf Germany?",
    ),
  ).toBe("What's the weather going to be in Stockdorf Germany?");
});
