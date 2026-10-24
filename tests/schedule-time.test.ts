import { expect, test, vi } from 'vitest';
import { getScheduledTaskNextRunAt } from '../src/scheduler/schedule-time.js';
import type { ScheduledTask } from '../src/types/scheduler.js';

vi.mock('../src/scheduler/db-task-runner.js', () => {
  throw new Error('Schedule reads must not load execution infrastructure.');
});

const now = Date.parse('2026-03-14T08:30:00Z');
const task: ScheduledTask = {
  id: 1,
  session_id: 'session-1',
  channel_id: 'channel-1',
  cron_expr: '0 9 * * *',
  tz: 'UTC',
  run_at: null,
  every_ms: null,
  prompt: 'Check the plan.',
  enabled: 1,
  last_run: null,
  last_status: null,
  last_error: null,
  consecutive_errors: 0,
  created_at: '2026-03-14T00:00:00Z',
};

test.each<{ name: string; change: Partial<ScheduledTask>; expected: string | null }>([
  { name: 'cron', change: {}, expected: '2026-03-14T09:00:00.000Z' },
  { name: 'disabled', change: { enabled: 0 }, expected: null },
  { name: 'one-shot', change: { run_at: '2026-03-14 10:00:00' }, expected: '2026-03-14T10:00:00.000Z' },
  { name: 'completed one-shot', change: { run_at: '2026-03-14 08:00:00', last_run: '2026-03-14 08:00:00' }, expected: null },
  { name: 'first interval', change: { every_ms: 60_000 }, expected: '2026-03-14T08:30:00.000Z' },
  { name: 'later interval', change: { every_ms: 60_000, last_run: '2026-03-14 08:30:00' }, expected: '2026-03-14T08:31:00.000Z' },
  { name: 'invalid cron', change: { cron_expr: 'invalid' }, expected: null },
  { name: 'invalid zone', change: { tz: 'invalid' }, expected: null },
  { name: 'managed daily routine', change: { managed_key: 'daily-brief', tz: 'Europe/Berlin' }, expected: '2026-03-15T08:00:00.000Z' },
])('reads $name without loading task execution', ({ change, expected }) => {
  expect(getScheduledTaskNextRunAt({ ...task, ...change }, now)).toBe(expected);
});
