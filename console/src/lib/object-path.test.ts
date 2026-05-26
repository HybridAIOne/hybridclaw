import { describe, expect, it } from 'vitest';
import { getPath, setPath } from './object-path';

describe('getPath', () => {
  it('reads a top-level value', () => {
    expect(getPath({ a: 1 }, 'a')).toBe(1);
  });

  it('reads a nested value', () => {
    expect(getPath({ a: { b: { c: 'leaf' } } }, 'a.b.c')).toBe('leaf');
  });

  it('returns undefined for missing intermediates', () => {
    expect(getPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(getPath({}, 'missing.path')).toBeUndefined();
  });

  it('returns undefined when source is null', () => {
    expect(getPath(null, 'a')).toBeUndefined();
  });
});

describe('setPath', () => {
  it('replaces a top-level value', () => {
    const source = { a: 1, b: 2 };
    const result = setPath(source, 'a', 99);
    expect(result).toEqual({ a: 99, b: 2 });
  });

  it('replaces a nested value, structurally sharing siblings', () => {
    const sibling = { name: 'keep' };
    const source = { a: { b: { c: 'old' }, sibling }, top: 'unchanged' };
    const result = setPath(source, 'a.b.c', 'new');
    expect(result).toEqual({
      a: { b: { c: 'new' }, sibling: { name: 'keep' } },
      top: 'unchanged',
    });
    // Siblings outside the touched path keep their reference.
    expect(result.a.sibling).toBe(sibling);
    expect(result.top).toBe('unchanged');
    // Touched intermediates are fresh objects.
    expect(result.a).not.toBe(source.a);
    expect(result.a.b).not.toBe(source.a.b);
  });

  it('creates missing intermediates', () => {
    const source = { a: 1 } as Record<string, unknown>;
    const result = setPath(source, 'nested.deep.leaf', 'created');
    expect(result).toEqual({
      a: 1,
      nested: { deep: { leaf: 'created' } },
    });
  });

  it('throws when the path is empty', () => {
    expect(() => setPath({}, '', 1)).toThrow();
  });

  it('returns source unchanged when the leaf value already matches', () => {
    const source = { a: { b: 'leaf' } };
    expect(setPath(source, 'a.b', 'leaf')).toBe(source);
  });

  it('returns source unchanged for a no-op deep replace', () => {
    const source = { a: { b: { c: 1 } } };
    expect(setPath(source, 'a.b.c', 1)).toBe(source);
  });

  it('preserves arrays when an array lies on the path', () => {
    const source = { items: [{ name: 'a' }, { name: 'b' }] };
    const result = setPath(source, 'items.1.name', 'B');
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items).toEqual([{ name: 'a' }, { name: 'B' }]);
    // The untouched element keeps its reference.
    expect(result.items[0]).toBe(source.items[0]);
  });

  it('throws on prototype-polluting path segments', () => {
    expect(() => setPath({}, '__proto__.polluted', true)).toThrow();
    expect(() => setPath({}, 'a.constructor.prototype.x', true)).toThrow();
    // The global prototype is never touched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('getPath prototype safety', () => {
  it('does not read through prototype-chain segments', () => {
    expect(getPath({}, '__proto__')).toBeUndefined();
    expect(getPath({ a: {} }, 'a.constructor')).toBeUndefined();
  });
});
