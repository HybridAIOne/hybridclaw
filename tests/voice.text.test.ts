import { expect, test } from 'vitest';
import { formatTextForVoice } from '../src/voice/text.js';

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
