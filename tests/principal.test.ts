import { describe, expect, test } from 'vitest';
import {
  normalizePrincipal,
  PrincipalValidationError,
  tryNormalizePrincipal,
} from '../src/identity/principal.js';

describe('principal normalization', () => {
  test('maps HybridAI email addresses to canonical HybridAI user ids', () => {
    expect(normalizePrincipal(' Guest.User@HybridAI.One ')).toBe(
      'guest.user@hybridai',
    );
  });

  test('normalizes canonical and non-HybridAI authorities without remapping them', () => {
    expect(normalizePrincipal('Guest.User@HybridAI')).toBe(
      'guest.user@hybridai',
    );
    expect(normalizePrincipal('Guest@Example.Com')).toBe('guest@example.com');
  });

  test('rejects malformed untrusted values without inventing a principal', () => {
    for (const value of [null, '', 'stephan', 'a@@hybridai.one']) {
      expect(() => normalizePrincipal(value)).toThrow(PrincipalValidationError);
      expect(tryNormalizePrincipal(value)).toBeNull();
    }
  });
});
