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
});
