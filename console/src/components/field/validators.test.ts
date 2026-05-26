import { describe, expect, it } from 'vitest';
import {
  compose,
  loopbackUrl,
  maxLength,
  minLength,
  oneOf,
  pattern,
  required,
  url,
} from './validators';

describe('validators', () => {
  describe('required', () => {
    it('rejects empty and whitespace strings, accepts non-empty', () => {
      const rule = required<string>();
      expect(rule('')).toBe('Required.');
      expect(rule('   ')).toBe('Required.');
      expect(rule('x')).toBeNull();
    });

    it('rejects null and undefined', () => {
      const rule = required<string | null | undefined>();
      expect(rule(null)).toBe('Required.');
      expect(rule(undefined)).toBe('Required.');
    });

    it('uses a custom message when provided', () => {
      expect(required<string>('Name is required.')('')).toBe(
        'Name is required.',
      );
    });

    it('honors the custom message for null and undefined', () => {
      const rule = required<string | null | undefined>('Pick one.');
      expect(rule(null)).toBe('Pick one.');
      expect(rule(undefined)).toBe('Pick one.');
    });
  });

  describe('pattern', () => {
    it('returns the message when the value does not match', () => {
      const rule = pattern(/^\d+$/, 'Numbers only.');
      expect(rule('abc')).toBe('Numbers only.');
      expect(rule('123')).toBeNull();
    });

    it('is stable across calls with a global/sticky regex', () => {
      // `RegExp.test` advances `lastIndex` on /g and /y patterns; without a
      // reset the same input would flip pass/fail on alternating calls.
      const rule = pattern(/\d+/g, 'Numbers only.');
      expect(rule('123')).toBeNull();
      expect(rule('123')).toBeNull();
      expect(rule('123')).toBeNull();
    });

    it('passes non-string values (defers to required)', () => {
      const rule = pattern(/^\d+$/, 'Numbers only.');
      expect(rule(undefined as unknown as string)).toBeNull();
      expect(rule(null as unknown as string)).toBeNull();
    });
  });

  describe('minLength / maxLength', () => {
    it('enforces inclusive bounds', () => {
      expect(minLength(3)('ab')).toBe('Must be at least 3 characters.');
      expect(minLength(3)('abc')).toBeNull();
      expect(maxLength(3)('abcd')).toBe('Must be at most 3 characters.');
      expect(maxLength(3)('abc')).toBeNull();
    });

    it('passes non-string values instead of throwing', () => {
      expect(minLength(3)(undefined as unknown as string)).toBeNull();
      expect(minLength(3)(null as unknown as string)).toBeNull();
      expect(maxLength(3)(undefined as unknown as string)).toBeNull();
      expect(maxLength(3)(null as unknown as string)).toBeNull();
    });
  });

  describe('oneOf', () => {
    it('rejects values outside the allowed set', () => {
      const rule = oneOf(['a', 'b', 'c'] as const);
      expect(rule('a')).toBeNull();
      expect(rule('z' as 'a')).toBe('Invalid value.');
    });
  });

  describe('url', () => {
    it('passes empty input (combine with required for non-empty enforcement)', () => {
      expect(url()('')).toBeNull();
    });

    it('accepts well-formed urls and rejects garbage', () => {
      expect(url()('https://example.com')).toBeNull();
      expect(url()('not a url')).toBe('Enter a valid URL.');
    });

    it('uses a custom message when provided', () => {
      const rule = url('Bad URL.');
      expect(rule('')).toBeNull();
      expect(rule('https://example.com')).toBeNull();
      expect(rule('not a url')).toBe('Bad URL.');
    });
  });

  describe('loopbackUrl', () => {
    it('accepts loopback hosts and rejects remote hosts', () => {
      expect(loopbackUrl()('http://127.0.0.1:8787')).toBeNull();
      expect(loopbackUrl()('http://localhost')).toBeNull();
      expect(loopbackUrl()('https://example.com')).toBe(
        'Must be a loopback URL.',
      );
    });

    it('accepts the IPv6 loopback literal (hostname keeps brackets)', () => {
      expect(loopbackUrl()('http://[::1]:8787')).toBeNull();
      expect(loopbackUrl()('http://[::1]')).toBeNull();
    });

    it('passes empty input', () => {
      expect(loopbackUrl()('')).toBeNull();
    });

    it('returns "Enter a valid URL." when the input cannot be parsed', () => {
      expect(loopbackUrl()('not a url')).toBe('Enter a valid URL.');
      expect(loopbackUrl('Loopback only.')('not a url')).toBe(
        'Enter a valid URL.',
      );
    });

    it('uses a custom message when the host is not loopback', () => {
      const rule = loopbackUrl('Loopback only.');
      expect(rule('http://127.0.0.1')).toBeNull();
      expect(rule('https://example.com')).toBe('Loopback only.');
    });
  });

  describe('compose', () => {
    it('returns the first failing rule', () => {
      const rule = compose<string>(
        required(),
        pattern(/^\d+$/, 'Numbers only.'),
      );
      expect(rule('')).toBe('Required.');
      expect(rule('abc')).toBe('Numbers only.');
      expect(rule('42')).toBeNull();
    });

    it('skips falsy entries so callers can conditionally include rules', () => {
      const includeMax = false;
      const rule = compose<string>(
        required(),
        includeMax && maxLength(3),
        undefined,
        null,
      );
      expect(rule('hello')).toBeNull();
      expect(rule('')).toBe('Required.');
    });
  });
});
