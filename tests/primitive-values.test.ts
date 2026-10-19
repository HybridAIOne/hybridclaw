import { describe, expect, it } from 'vitest';

import {
  asRecord,
  isRecord,
  parseNonNegativeInteger,
  parsePositiveInteger,
} from '#shared/primitive-values.js';

describe('integer parsers', () => {
  it.each([
    [0, null, 0],
    [0.5, null, null],
    [1, 1, 1],
    [1.5, null, null],
    ['12', 12, 12],
    [' 12 ', 12, 12],
    ['0', null, 0],
    ['12abc', null, null],
    ['1e3', null, null],
    ['4.0', null, null],
    ['', null, null],
    ['-1', null, null],
    [-1, null, null],
    [Number.NaN, null, null],
    [Number.POSITIVE_INFINITY, null, null],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    [Number.MAX_SAFE_INTEGER + 1, null, null],
    ['9007199254740993', null, null],
    [[12], null, null],
    [null, null, null],
    [undefined, null, null],
    [true, null, null],
  ])('%j → positive %j, non-negative %j', (input, positive, nonNegative) => {
    expect(parsePositiveInteger(input)).toBe(positive);
    expect(parseNonNegativeInteger(input)).toBe(nonNegative);
  });
});

describe('record guards', () => {
  const record = { a: 1 };

  it.each([
    [record, record],
    [Object.create(null), 'self'],
    [null, null],
    [undefined, null],
    [[], null],
    [[1], null],
    ['text', null],
    [0, null],
    [false, null],
  ])('%j', (input, expected) => {
    const result = expected === 'self' ? input : expected;
    expect(isRecord(input)).toBe(result !== null);
    expect(asRecord(input)).toBe(result);
  });
});
