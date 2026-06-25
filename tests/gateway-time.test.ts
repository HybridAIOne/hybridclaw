import { expect, test } from 'vitest';

import { formatDisplayTimestamp } from '../src/gateway/gateway-time.ts';

function withTimeZone<T>(timeZone: string, callback: () => T): T {
  const previous = process.env.TZ;
  try {
    process.env.TZ = timeZone;
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
}

test('formatDisplayTimestamp renders in the local timezone', () => {
  withTimeZone('Europe/Berlin', () => {
    expect(formatDisplayTimestamp('2026-03-30T09:27:30.580Z')).toBe(
      'Mar 30, 2026, 11:27',
    );
  });
});

test('formatDisplayTimestamp omits seconds and timezone suffix', () => {
  withTimeZone('UTC', () => {
    expect(formatDisplayTimestamp('2026-03-30T09:27:30.580Z')).toBe(
      'Mar 30, 2026, 09:27',
    );
  });
});

test('formatDisplayTimestamp returns unknown for invalid values', () => {
  expect(formatDisplayTimestamp(null)).toBe('unknown');
  expect(formatDisplayTimestamp('')).toBe('unknown');
  expect(formatDisplayTimestamp('not-a-timestamp')).toBe('unknown');
});
