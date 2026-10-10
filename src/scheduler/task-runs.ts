/**
 * Run history of scheduled tasks and triggers: one row per due time, saying
 * when it was due, when it ran, how it ended, what it cost and which work
 * record holds the message it posted. A trigger's queued runs count as its
 * own. `missed` rows are due times the scheduler never ran because it was
 * down or held back: catch-up still runs only the latest one, this module
 * records the others. Intervals re-anchor at each run, so they miss nothing.
 *
 * NOT the scheduler (`scheduler.ts` decides what fires) and NOT work records
 * (`work-store.ts`, the provenance of one execution).
 */
import { CronExpressionParser } from 'cron-parser';
import { queueRoutineNotice } from '../gateway/routine-notices.js';
import { withMemoryDatabase } from '../memory/database.js';
import { describeJobError, getJob } from '../memory/jobs.js';
import { queryAll, queryOne } from '../memory/sqlite.js';
import type { ScheduledTask } from '../types/scheduler.js';
import type { TaskCost } from '../usage/task-cost.js';
import { readWork } from '../work/work-store.js';
import { parseSchedulerTimestampMs } from './scheduler.js';

export type TaskRunOutcome =
  | 'running'
  | 'done'
  | 'failed'
  | 'missed'
  | 'skipped';

export interface TaskRunJson {
  id: number;
  due_at: string;
  started_at: string | null;
  ended_at: string | null;
  outcome: TaskRunOutcome;
  error: string | null;
  duration_ms: number | null;
  cost: TaskCost | null;
  /** The message the run posted, in the chat it delivered to. */
  message_id: number | null;
}

export interface TaskRunsSummary {
  last: TaskRunOutcome | null;
  last_due_at: string | null;
  failed_24h: number;
  missed_24h: number;
}

interface TaskRunRow {
  id: number;
  due_at: string;
  started_at: string | null;
  ended_at: string | null;
  outcome: TaskRunOutcome;
  error: string | null;
  cost: string | null;
  work_id: string | null;
}

// 50 runs or 30 days a task (engineering choice, 2026-10-11): a day of a
// half-hourly check, a month of a daily routine.
export const MAX_TASK_RUNS = 50;
const KEEP_MS = 30 * 86_400_000;
// One notice a routine a day (product owner, 2026-10-11): say it once, do not flood.
const NOTICE_EVERY_MS = 86_400_000;
const DAY_MS = 86_400_000;
const ERROR_MAX_LENGTH = 300;

const iso = (ms: number) => new Date(ms).toISOString();

/** The task a run is history of: a trigger's queued run is its trigger's. */
export function taskRunOwner(task: ScheduledTask): number {
  return task.event_parent_id ?? task.id;
}

/**
 * Due times of a cron task between its last run (or its last change, such as
 * a resume) and `dueMs`, newest last: the scheduler never ran them.
 */
export function missedDueTimes(task: ScheduledTask, dueMs: number): number[] {
  if (!task.cron_expr || task.run_at || task.every_ms) return [];
  const since = Math.max(
    parseSchedulerTimestampMs(task.last_run) ?? 0,
    parseSchedulerTimestampMs(task.updated_at) ?? 0,
  );
  if (!since) return [];
  const missed: number[] = [];
  try {
    const cron = CronExpressionParser.parse(task.cron_expr.trim(), {
      currentDate: new Date(dueMs),
      tz: task.tz?.trim() || 'UTC',
    });
    while (missed.length < MAX_TASK_RUNS) {
      const at = cron.prev().getTime();
      if (at <= since) break;
      missed.push(at);
    }
  } catch {
    return [];
  }
  return missed.reverse();
}

function prune(taskId: number): void {
  withMemoryDatabase((db) => {
    db.prepare(
      `DELETE FROM task_runs WHERE task_id = ? AND outcome != 'running' AND (
        due_at < ? OR id NOT IN (
          SELECT id FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?
        ))`,
    ).run(taskId, iso(Date.now() - KEEP_MS), taskId, MAX_TASK_RUNS);
  });
}

/**
 * Records a run that starts now for the time it was due, after the due times
 * it skipped. Returns the run's id for `noteTaskRun` and `finishTaskRun`.
 */
export function startTaskRun(task: ScheduledTask, dueMs: number): number {
  const taskId = taskRunOwner(task);
  const missed = missedDueTimes(task, dueMs);
  const { id, missedIds } = withMemoryDatabase((db) =>
    db.transaction(() => {
      const insert = db.prepare(
        'INSERT INTO task_runs (task_id, due_at, started_at, outcome) VALUES (?, ?, ?, ?)',
      );
      const missedIds = missed.map((at) =>
        Number(insert.run(taskId, iso(at), null, 'missed').lastInsertRowid),
      );
      const id = Number(
        insert.run(taskId, iso(dueMs), iso(Date.now()), 'running')
          .lastInsertRowid,
      );
      return { id, missedIds };
    })(),
  );
  prune(taskId);
  if (missedIds.length)
    notice(task, missedIds, { kind: 'missed', dueTimes: missed });
  return id;
}

/**
 * What the run itself knows: its work record, what it cost, and that it had
 * nothing to post (a silent reply, or a reminder whose todo is done).
 */
export function noteTaskRun(
  id: number | undefined,
  note: { workId?: string; cost?: TaskCost; skipped?: boolean },
): void {
  if (!id) return;
  withMemoryDatabase((db) => {
    db.prepare(
      `UPDATE task_runs SET work_id = COALESCE(?, work_id), cost = COALESCE(?, cost),
        outcome = CASE WHEN ? = 1 AND outcome = 'running' THEN 'skipped' ELSE outcome END
       WHERE id = ?`,
    ).run(
      note.workId ?? null,
      note.cost ? JSON.stringify(note.cost) : null,
      note.skipped ? 1 : 0,
      id,
    );
  });
}

/** Ends a run: done (or skipped, as noted), or failed with why. */
export function finishTaskRun(
  task: ScheduledTask,
  id: number,
  failure?: { error: unknown; pausedAfter?: number },
): void {
  const now = iso(Date.now());
  withMemoryDatabase((db) => {
    if (failure)
      db.prepare(
        "UPDATE task_runs SET outcome = 'failed', error = ?, ended_at = ? WHERE id = ?",
      ).run(shortError(failure.error), now, id);
    else
      db.prepare(
        "UPDATE task_runs SET outcome = CASE outcome WHEN 'running' THEN 'done' ELSE outcome END, ended_at = ? WHERE id = ?",
      ).run(now, id);
  });
  if (failure)
    notice(task, [id], {
      kind: 'failed',
      dueAt: dueAtOf(id),
      error: shortError(failure.error),
      pausedAfter: failure.pausedAfter,
    });
}

/**
 * Runs that were still going when the runtime stopped: they never finished,
 * and the scheduler does not run that due time again.
 */
export function interruptTaskRuns(): void {
  const rows = withMemoryDatabase((db) =>
    queryAll<{ id: number; task_id: number }>(
      db,
      "SELECT id, task_id FROM task_runs WHERE outcome = 'running'",
    ),
  );
  const error = 'The runtime stopped during the run.';
  for (const row of rows) {
    withMemoryDatabase((db) => {
      db.prepare(
        "UPDATE task_runs SET outcome = 'failed', error = ?, ended_at = ? WHERE id = ?",
      ).run(error, iso(Date.now()), row.id);
    });
    const task = getJob(row.task_id, { kind: 'scheduled_task' });
    if (task)
      notice(task, [row.id], { kind: 'failed', dueAt: dueAtOf(row.id), error });
  }
}

function shortError(error: unknown): string {
  const text = describeJobError(error);
  return text.length > ERROR_MAX_LENGTH
    ? `${text.slice(0, ERROR_MAX_LENGTH - 1)}…`
    : text;
}

function dueAtOf(id: number): number {
  const row = withMemoryDatabase((db) =>
    queryOne<{ due_at: string }>(
      db,
      'SELECT due_at FROM task_runs WHERE id = ?',
      id,
    ),
  );
  return parseSchedulerTimestampMs(row?.due_at) ?? Date.now();
}

/**
 * Tells the chat once a day per routine; a routine the scheduler paused is
 * said at once, since it will not run again until resumed.
 */
function notice(
  task: ScheduledTask,
  runIds: number[],
  problem: RoutineProblem,
): void {
  const taskId = taskRunOwner(task);
  const owner =
    taskId === task.id ? task : getJob(taskId, { kind: 'scheduled_task' });
  if (!owner) return;
  const now = Date.now();
  const told = withMemoryDatabase((db) =>
    queryOne<{ id: number }>(
      db,
      'SELECT id FROM task_runs WHERE task_id = ? AND noticed_at >= ? LIMIT 1',
      taskId,
      iso(now - NOTICE_EVERY_MS),
    ),
  );
  if (told && !(problem.kind === 'failed' && problem.pausedAfter)) return;
  withMemoryDatabase((db) => {
    const mark = db.prepare('UPDATE task_runs SET noticed_at = ? WHERE id = ?');
    for (const id of runIds) mark.run(iso(now), id);
  });
  queueRoutineNotice(owner, problem);
}

export type RoutineProblem =
  | { kind: 'missed'; dueTimes: number[] }
  | { kind: 'failed'; dueAt: number; error: string; pausedAfter?: number };

/** The task's runs, newest first. */
export function listTaskRuns(taskId: number, limit: number): TaskRunJson[] {
  const rows = withMemoryDatabase((db) =>
    queryAll<TaskRunRow>(
      db,
      `SELECT id, due_at, started_at, ended_at, outcome, error, cost, work_id
       FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?`,
      taskId,
      limit,
    ),
  );
  return rows.map((row) => {
    const started = parseSchedulerTimestampMs(row.started_at);
    const ended = parseSchedulerTimestampMs(row.ended_at);
    return {
      id: row.id,
      due_at: row.due_at,
      started_at: row.started_at,
      ended_at: row.ended_at,
      outcome: row.outcome,
      error: row.error,
      duration_ms:
        started != null && ended != null ? Math.max(0, ended - started) : null,
      cost: row.cost ? (JSON.parse(row.cost) as TaskCost) : null,
      message_id: row.work_id
        ? (readWork(row.work_id)?.messageId ?? null)
        : null,
    };
  });
}

/** Enough for a list to flag a routine without reading its runs. */
export function taskRunsSummary(taskId: number): TaskRunsSummary {
  return withMemoryDatabase((db) => {
    const last = queryOne<{ outcome: TaskRunOutcome; due_at: string }>(
      db,
      'SELECT outcome, due_at FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT 1',
      taskId,
    );
    const counts = queryOne<{ failed: number | null; missed: number | null }>(
      db,
      `SELECT SUM(outcome = 'failed') AS failed, SUM(outcome = 'missed') AS missed
       FROM task_runs WHERE task_id = ? AND due_at >= ?`,
      taskId,
      iso(Date.now() - DAY_MS),
    );
    return {
      last: last?.outcome ?? null,
      last_due_at: last?.due_at ?? null,
      failed_24h: counts?.failed ?? 0,
      missed_24h: counts?.missed ?? 0,
    };
  });
}
