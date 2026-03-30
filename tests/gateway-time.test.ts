import { expect, test } from 'vitest';

import { formatDisplayTimestamp } from '../src/gateway/gateway-time.ts';

test('formatDisplayTimestamp omits seconds and timezone suffix', () => {
  expect(formatDisplayTimestamp('2026-03-30T09:27:30.580Z')).toBe(
    'Mar 30, 2026, 09:27',
  );
});

test('formatDisplayTimestamp returns unknown for invalid values', () => {
  expect(formatDisplayTimestamp(null)).toBe('unknown');
  expect(formatDisplayTimestamp('')).toBe('unknown');
  expect(formatDisplayTimestamp('not-a-timestamp')).toBe('unknown');
});
