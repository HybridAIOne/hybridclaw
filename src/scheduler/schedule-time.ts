/**
 * Schedule times share one clock calculation between execution and read-only views.
 * Unlike the scheduler, this module has no timers, persisted state, or runners;
 * importing it must not initialize execution infrastructure.
 */
import { CronExpressionParser } from 'cron-parser';
import type { ScheduledTask } from '../types/scheduler.js';
import { routineDue } from './routine-time.js';

const SQLITE_SECOND_PRECISION_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
export const DEFAULT_SCHEDULER_TIME_ZONE = 'UTC';

type CronWeekdayNumbering = 'crontab' | 'monday-zero-based';

export function parseSchedulerTimestampMs(
  raw: string | null | undefined,
): number | null {
  const value = (raw || '').trim();
  if (!value) return null;
  const normalized = SQLITE_SECOND_PRECISION_TS_RE.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function resolveSchedulerTimeZone(timeZone: string | undefined): string {
  const trimmed = timeZone?.trim();
  return trimmed || DEFAULT_SCHEDULER_TIME_ZONE;
}

function parseMondayZeroBasedWeekdayValue(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed >= 0 && parsed <= 6 ? parsed : null;
}

function expandMondayZeroBasedWeekdayBase(
  value: string,
  hasStep: boolean,
): number[] | null {
  if (value === '*') return [0, 1, 2, 3, 4, 5, 6];
  const single = parseMondayZeroBasedWeekdayValue(value);
  if (single != null) {
    if (!hasStep) return [single];
    return Array.from(
      { length: 7 - single },
      (_unused, index) => single + index,
    );
  }

  const match = value.match(/^(\d+)-(\d+)$/);
  if (!match) return null;
  const start = parseMondayZeroBasedWeekdayValue(match[1]);
  const end = parseMondayZeroBasedWeekdayValue(match[2]);
  if (start == null || end == null) return null;

  const days: number[] = [];
  let current = start;
  while (true) {
    days.push(current);
    if (current === end) return days;
    current = (current + 1) % 7;
    if (days.length > 7) return null;
  }
}

function normalizeMondayZeroBasedCronWeekdaySegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed || trimmed === '?') return trimmed;

  const parts = trimmed.split('/');
  if (parts.length > 2) return trimmed;
  const [rawBase, rawStep] = parts;
  const step =
    rawStep == null
      ? 1
      : /^\d+$/.test(rawStep)
        ? Number.parseInt(rawStep, 10)
        : null;
  if (step == null || step <= 0) return trimmed;
  if (rawBase === '*' && step === 1) return trimmed;

  const baseValues = expandMondayZeroBasedWeekdayBase(rawBase, rawStep != null);
  if (!baseValues) return trimmed;

  const normalizedValues = baseValues
    .filter((_value, index) => index % step === 0)
    .map((value) => String((value + 1) % 7));
  return normalizedValues.join(',');
}

function normalizeMondayZeroBasedCronWeekdayField(field: string): string {
  return field
    .split(',')
    .map((segment) => normalizeMondayZeroBasedCronWeekdaySegment(segment))
    .join(',');
}

export function normalizeMondayZeroBasedCronExpressionWeekdays(
  expr: string,
): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6 && fields.length !== 7) {
    return expr.trim();
  }
  const dayOfWeekIndex = fields.length === 5 ? 4 : 5;
  fields[dayOfWeekIndex] = normalizeMondayZeroBasedCronWeekdayField(
    fields[dayOfWeekIndex] || '',
  );
  return fields.join(' ');
}

export function parseCronExpression(
  expr: string,
  options: {
    currentDateMs?: number;
    tz?: string;
    weekdayNumbering?: CronWeekdayNumbering;
  } = {},
): ReturnType<typeof CronExpressionParser.parse> {
  const normalizedExpr =
    options.weekdayNumbering === 'monday-zero-based'
      ? normalizeMondayZeroBasedCronExpressionWeekdays(expr)
      : expr.trim();
  return CronExpressionParser.parse(normalizedExpr, {
    currentDate: new Date(options.currentDateMs ?? Date.now()),
    tz: resolveSchedulerTimeZone(options.tz),
  });
}

export function nextFireMsForDbTask(
  task: ScheduledTask,
  nowMs: number,
): number | null {
  if (task.managed_key) return routineDue(task, nowMs, 'next');
  if (task.run_at) {
    if (task.last_run) return null;
    return parseSchedulerTimestampMs(task.run_at);
  }

  if (task.every_ms) {
    const lastRunMs = parseSchedulerTimestampMs(task.last_run) ?? 0;
    return lastRunMs > 0 ? lastRunMs + task.every_ms : nowMs;
  }

  if (!task.cron_expr) return null;

  try {
    const ms = parseCronExpression(task.cron_expr, {
      currentDateMs: nowMs,
      tz: task.tz || undefined,
    })
      .next()
      .toDate()
      .getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

export function toIsoTimestamp(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function getScheduledTaskNextRunAt(
  task: ScheduledTask,
  nowMs = Date.now(),
): string | null {
  if (!task.enabled) return null;
  return toIsoTimestamp(nextFireMsForDbTask(task, nowMs));
}
