import { expect, test } from 'vitest';
import {
  finiteNumberOrNull,
  nonNegativeIntegerOrNull,
  normalizeNonNegativeInteger,
  normalizeNonNegativeNumber,
  parseNonNegativeInteger,
  parsePositiveInteger,
  positiveIntegerOrNull,
  positiveNumberOrNull,
} from '../src/utils/number-normalization.js';

test('finiteNumberOrNull accepts only finite numeric values', () => {
  expect(finiteNumberOrNull(1.5)).toBe(1.5);
  expect(finiteNumberOrNull('1.5')).toBeNull();
  expect(finiteNumberOrNull(Number.NaN)).toBeNull();
  expect(finiteNumberOrNull(Number.POSITIVE_INFINITY)).toBeNull();
  expect(finiteNumberOrNull(null)).toBeNull();
});

test('positiveNumberOrNull preserves positive finite numbers', () => {
  expect(positiveNumberOrNull(1.5)).toBe(1.5);
  expect(positiveNumberOrNull(0)).toBeNull();
  expect(positiveNumberOrNull(-1)).toBeNull();
});

test('integer helpers floor finite numeric values after bounds checks', () => {
  expect(nonNegativeIntegerOrNull(1.9)).toBe(1);
  expect(nonNegativeIntegerOrNull(0)).toBe(0);
  expect(nonNegativeIntegerOrNull(-1)).toBeNull();
  expect(positiveIntegerOrNull(1.9)).toBe(1);
  expect(positiveIntegerOrNull(0)).toBeNull();
});

test('normalizers fall back to zero and clamp negative values', () => {
  expect(normalizeNonNegativeInteger(3.9)).toBe(3);
  expect(normalizeNonNegativeInteger(-3.9)).toBe(0);
  expect(normalizeNonNegativeInteger('3')).toBe(0);
  expect(normalizeNonNegativeNumber(3.9)).toBe(3.9);
  expect(normalizeNonNegativeNumber(-3.9)).toBe(0);
  expect(normalizeNonNegativeNumber('3')).toBe(0);
});

test('parse integer helpers accept strict decimal integer strings and integers', () => {
  expect(parsePositiveInteger('42')).toBe(42);
  expect(parsePositiveInteger(' 42 ')).toBe(42);
  expect(parsePositiveInteger(42)).toBe(42);
  expect(parsePositiveInteger('0')).toBeNull();
  expect(parsePositiveInteger('42px')).toBeNull();
  expect(parsePositiveInteger('4.2')).toBeNull();
  expect(parsePositiveInteger(4.2)).toBeNull();

  expect(parseNonNegativeInteger('0')).toBe(0);
  expect(parseNonNegativeInteger('42')).toBe(42);
  expect(parseNonNegativeInteger(0)).toBe(0);
  expect(parseNonNegativeInteger('-1')).toBeNull();
  expect(parseNonNegativeInteger('1x')).toBeNull();
});
