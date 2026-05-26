import { describe, expect, it } from 'vitest';
import { validateField } from './validate-field';
import { maxLength, pattern, required } from './validators';

describe('validateField', () => {
  it('returns the first failing rule', () => {
    const result = validateField('', [
      required<string>(),
      pattern(/^\d+$/, 'Numbers only.'),
    ]);
    expect(result).toBe('Required.');
  });

  it('returns null when every rule passes', () => {
    const result = validateField('ok', [required<string>(), maxLength(10)]);
    expect(result).toBeNull();
  });

  it('skips falsy entries so callers can conditionally compose rules', () => {
    const enforceMax = false;
    const result = validateField('hello, world', [
      required<string>(),
      enforceMax && maxLength(3),
      undefined,
      null,
    ]);
    expect(result).toBeNull();
  });
});
