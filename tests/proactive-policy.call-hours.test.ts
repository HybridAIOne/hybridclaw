import { afterEach, expect, test, vi } from 'vitest';

async function callHours(activeHours: {
  enabled: boolean;
  start?: number;
  end?: number;
  timezone?: string;
}) {
  vi.doMock('../src/config/config.js', () => ({
    PROACTIVE_ACTIVE_HOURS_ENABLED: activeHours.enabled,
    PROACTIVE_ACTIVE_HOURS_START: activeHours.start ?? 8,
    PROACTIVE_ACTIVE_HOURS_END: activeHours.end ?? 22,
    PROACTIVE_ACTIVE_HOURS_TIMEZONE: activeHours.timezone ?? '',
  }));
  return (await import('../src/agent/proactive-policy.js')).isWithinCallHours;
}

afterEach(() => {
  vi.doUnmock('../src/config/config.js');
  vi.resetModules();
});

// 21:30 and 23:30 in Berlin (UTC+2 in October).
const EVENING = new Date('2026-10-10T19:30:00Z');
const NIGHT = new Date('2026-10-10T21:30:00Z');

test('with proactive active hours off, unasked calls keep to 08:00–22:00 in the user’s zone', async () => {
  const isWithinCallHours = await callHours({ enabled: false });
  expect(isWithinCallHours(EVENING, 'Europe/Berlin')).toBe(true);
  expect(isWithinCallHours(NIGHT, 'Europe/Berlin')).toBe(false);
  expect(isWithinCallHours(new Date('2026-10-10T05:30:00Z'), 'Europe/Berlin')).toBe(false);
  expect(isWithinCallHours(new Date('2026-10-10T06:30:00Z'), 'Europe/Berlin')).toBe(true);
  // 23:30 in Berlin is 14:30 in Los Angeles.
  expect(isWithinCallHours(NIGHT, 'America/Los_Angeles')).toBe(true);
});

test('with proactive active hours on, their window applies in the user’s zone', async () => {
  const isWithinCallHours = await callHours({ enabled: true, start: 9, end: 21, timezone: 'UTC' });
  // 21:30 Berlin is past 21:00, though 19:30 UTC would not be.
  expect(isWithinCallHours(EVENING, 'Europe/Berlin')).toBe(false);
  expect(isWithinCallHours(EVENING, null)).toBe(true);
  expect(isWithinCallHours(new Date('2026-10-10T08:30:00Z'), 'Europe/Berlin')).toBe(true);
});
