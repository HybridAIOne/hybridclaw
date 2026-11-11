import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';
useCleanMocks({ restoreAllMocks: true });
import {
  earliestExecutionDeadline,
  normalizePositiveTimeoutMs,
  readExecutionDeadline,
  remainingExecutionMs,
  resolveExecutionDeadline,
} from '../packages/shared/src/execution-deadline.js';

test.each([undefined, 0, 1234, Number.MAX_SAFE_INTEGER])(
  'accepts an absolute bound %s',
  (value) => {
    expect(readExecutionDeadline(value)).toBe(value);
  },
);
test.each([null, '1234', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid absolute bounds %s',
  (value) => {
    expect(() => readExecutionDeadline(value)).toThrow(
      'Invalid execution deadline',
    );
  },
);
test('relative limits become absolute once and can only shorten inherited bounds', () => {
  const original = resolveExecutionDeadline(1000, undefined, 100);
  expect(original).toBe(1100);
  expect(resolveExecutionDeadline(1000, original, 800)).toBe(original);
  expect(resolveExecutionDeadline(50, original, 800)).toBe(850);
  expect(earliestExecutionDeadline(undefined, 1200, original, 1500)).toBe(
    original,
  );
  expect(earliestExecutionDeadline()).toBeUndefined();
  expect(() =>
    resolveExecutionDeadline(1, undefined, Number.MAX_SAFE_INTEGER),
  ).toThrow();
});
test('unset limits stay unset; elapsed bounds never become negative leases', () => {
  expect(resolveExecutionDeadline(null, undefined, 100)).toBeUndefined();
  expect(remainingExecutionMs(undefined, 100)).toBeUndefined();
  expect(remainingExecutionMs(150, 100)).toBe(50);
  expect(remainingExecutionMs(100, 150)).toBe(0);
  expect(normalizePositiveTimeoutMs(12.5)).toBe(12);
  expect(normalizePositiveTimeoutMs(0)).toBeNull();
});

test('unset budgets leave the clock untouched; explicit budgets read it once', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10);
  expect(remainingExecutionMs(undefined)).toBeUndefined();
  expect(remainingExecutionMs(100, 90)).toBe(10);
  expect(clock).not.toHaveBeenCalled();
  expect(remainingExecutionMs(100)).toBe(90);
  expect(clock).toHaveBeenCalledOnce();
});
