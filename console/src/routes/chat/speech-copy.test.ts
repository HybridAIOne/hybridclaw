import { describe, expect, it } from 'vitest';
import { getSpeechCopy } from './speech-copy';

describe('getSpeechCopy', () => {
  it('localizes speech controls for supported browser locales', () => {
    expect(getSpeechCopy('de-DE').dictate).toBe('Spracheingabe');
    expect(getSpeechCopy('fr-FR').read).toBe('Lire la réponse à voix haute');
  });

  it('falls back to English for other locales', () => {
    expect(getSpeechCopy('ja-JP').dictate).toBe('Voice input');
  });
});
