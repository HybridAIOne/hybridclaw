import { describe, expect, it } from 'vitest';
import { compose, required } from './validators';

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

  describe('compose', () => {
    it('returns the first failing rule', () => {
      const rule = compose<string>(required(), (value) =>
        /^\d+$/.test(value) ? null : 'Numbers only.',
      );
      expect(rule('')).toBe('Required.');
      expect(rule('abc')).toBe('Numbers only.');
      expect(rule('42')).toBeNull();
    });

    it('skips falsy entries so callers can conditionally include rules', () => {
      const includeExtra = false;
      const rule = compose<string>(
        required(),
        includeExtra && (() => 'Extra rule.'),
        undefined,
        null,
      );
      expect(rule('hello')).toBeNull();
      expect(rule('')).toBe('Required.');
    });
  });
});
