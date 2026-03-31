import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  getScheduledTaskNextRunAt,
  normalizeMondayZeroBasedCronExpressionWeekdays,
  wrapCronPrompt,
} from '../src/scheduler/scheduler.js';
import type { ScheduledTask } from '../src/types/scheduler.js';

function makeCronTask(cronExpr: string): ScheduledTask {
  return {
    id: 1,
    session_id: 'session-1',
    channel_id: 'channel-1',
    cron_expr: cronExpr,
    run_at: null,
    every_ms: null,
    prompt: 'Say hello',
    enabled: 1,
    last_run: null,
    last_status: null,
    consecutive_errors: 0,
    created_at: '2026-03-14T00:00:00.000Z',
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler cron normalization', () => {
  test('wrapCronPrompt formats current time in the requested timezone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T12:00:00.000Z'));

    const prompt = wrapCronPrompt(
      'weekday-report',
      'Send the report.',
      'America/Los_Angeles',
    );

    expect(prompt).toContain('(America/Los_Angeles)');
    expect(prompt).toMatch(/Current time: .*05:00.*\(America\/Los_Angeles\)/);
  });

  test('getScheduledTaskNextRunAt uses the supplied clock and UTC by default', () => {
    const nextRunAt = getScheduledTaskNextRunAt(
      makeCronTask('0 9 * * *'),
      new Date('2026-03-14T08:30:00.000Z').getTime(),
    );

    expect(nextRunAt).toBe('2026-03-14T09:00:00.000Z');
  });

  test('normalizes monday-zero-based weekday fields before cron parsing', () => {
    expect(
      normalizeMondayZeroBasedCronExpressionWeekdays('0 9 * * 0-6/2'),
    ).toBe('0 9 * * 1,3,5,0');
  });
});
