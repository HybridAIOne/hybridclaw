import { describe, expect, test } from 'vitest';
import { parseSchedulerTimestampMs } from '../src/scheduler.js';

describe('parseSchedulerTimestampMs', () => {
  test('interprets legacy SQLite second-precision timestamps as UTC', () => {
    const raw = '2026-03-05 13:24:52';
    const parsedMs = parseSchedulerTimestampMs(raw);
    const expectedMs = new Date('2026-03-05T13:24:52Z').getTime();
    expect(parsedMs).toBe(expectedMs);
  });

  test('keeps ISO timestamps unchanged', () => {
    const raw = '2026-03-05T13:24:52.000Z';
    const parsedMs = parseSchedulerTimestampMs(raw);
    const expectedMs = new Date(raw).getTime();
    expect(parsedMs).toBe(expectedMs);
  });

  test('incident regression: interval task is not immediately due', () => {
    const everyMs = 300_000;
    const lastRunRaw = '2026-03-05 13:24:52';
    const nowMs = new Date('2026-03-05T13:24:53Z').getTime();
    const lastRunMs = parseSchedulerTimestampMs(lastRunRaw);
    expect(lastRunMs).not.toBeNull();
    const dueAt = (lastRunMs as number) + everyMs;
    expect(dueAt <= nowMs).toBe(false);
  });
});
