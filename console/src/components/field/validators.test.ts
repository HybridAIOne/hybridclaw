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
  });

  describe('pattern', () => {
    it('returns the message when the value does not match', () => {
      const rule = pattern(/^\d+$/, 'Numbers only.');
      expect(rule('abc')).toBe('Numbers only.');
      expect(rule('123')).toBeNull();
    });
  });

  describe('minLength / maxLength', () => {
    it('enforces inclusive bounds', () => {
      expect(minLength(3)('ab')).toBe('Must be at least 3 characters.');
      expect(minLength(3)('abc')).toBeNull();
      expect(maxLength(3)('abcd')).toBe('Must be at most 3 characters.');
      expect(maxLength(3)('abc')).toBeNull();
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
  });

  describe('loopbackUrl', () => {
    it('accepts loopback hosts and rejects remote hosts', () => {
      expect(loopbackUrl()('http://127.0.0.1:8787')).toBeNull();
      expect(loopbackUrl()('http://localhost')).toBeNull();
      expect(loopbackUrl()('https://example.com')).toBe(
        'Must be a loopback URL.',
      );
    });

    it('passes empty input', () => {
      expect(loopbackUrl()('')).toBeNull();
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
