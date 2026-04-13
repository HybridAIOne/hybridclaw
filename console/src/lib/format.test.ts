import { describe, expect, it } from 'vitest';
import { pluralize } from './format';

describe('pluralize', () => {
  it('returns singular when n is 1', () => {
    expect(pluralize(1, 'call')).toBe('1 call');
  });

  it('returns plural when n is 0', () => {
    expect(pluralize(0, 'call')).toBe('0 calls');
  });

  it('returns plural when n is greater than 1', () => {
    expect(pluralize(2, 'call')).toBe('2 calls');
    expect(pluralize(100, 'call')).toBe('100 calls');
  });

  it('uses a custom plural form for irregular plurals', () => {
    expect(pluralize(1, 'person', 'people')).toBe('1 person');
    expect(pluralize(3, 'person', 'people')).toBe('3 people');
  });

  it('handles negative numbers as plural', () => {
    expect(pluralize(-1, 'call')).toBe('-1 calls');
  });
});
