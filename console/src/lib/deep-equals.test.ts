import { describe, expect, it } from 'vitest';
import { deepEquals } from './deep-equals';

describe('deepEquals', () => {
  it('returns true for identical primitives', () => {
    expect(deepEquals(1, 1)).toBe(true);
    expect(deepEquals('a', 'a')).toBe(true);
    expect(deepEquals(true, true)).toBe(true);
    expect(deepEquals(null, null)).toBe(true);
    expect(deepEquals(undefined, undefined)).toBe(true);
  });

  it('treats NaN as equal to itself', () => {
    expect(deepEquals(Number.NaN, Number.NaN)).toBe(true);
  });

  it('returns false when one side is null', () => {
    expect(deepEquals(null, {})).toBe(false);
    expect(deepEquals({}, null)).toBe(false);
  });

  it('compares Date values by their timestamp', () => {
    const a = new Date('2024-01-01T00:00:00Z');
    const b = new Date('2024-01-01T00:00:00Z');
    const c = new Date('2024-01-02T00:00:00Z');
    expect(deepEquals(a, b)).toBe(true);
    expect(deepEquals(a, c)).toBe(false);
  });

  it('returns false when one side is a Date and the other is not', () => {
    expect(deepEquals(new Date(0), '1970-01-01T00:00:00.000Z')).toBe(false);
    expect(deepEquals(new Date(0), {})).toBe(false);
  });

  it('compares arrays element-wise', () => {
    expect(deepEquals([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEquals([1, 2, 3], [1, 2])).toBe(false);
    expect(deepEquals([1, 2, 3], [1, 3, 2])).toBe(false);
  });

  it('returns false when one side is an array and the other an object', () => {
    expect(deepEquals([1, 2], { 0: 1, 1: 2, length: 2 })).toBe(false);
  });

  it('ignores object key order', () => {
    expect(deepEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('distinguishes missing keys from undefined values', () => {
    expect(deepEquals({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });

  it('compares nested structures recursively', () => {
    const left = { ops: { healthPort: 8080, tags: ['x'] }, when: new Date(0) };
    const right = { ops: { healthPort: 8080, tags: ['x'] }, when: new Date(0) };
    expect(deepEquals(left, right)).toBe(true);
    expect(
      deepEquals(left, {
        ops: { healthPort: 8081, tags: ['x'] },
        when: new Date(0),
      }),
    ).toBe(false);
  });
});
