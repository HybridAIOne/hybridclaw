/**
 * One scheduled edition per managed routine and local date, including after edits.
 * Saved output is a delivery outbox, never permission to regenerate or act again.
 * Manual tests are ordinary one-shot jobs and do not consume a daily edition.
 */
import type { ProactiveMessagePayload } from '../gateway/fullauto-runtime.js';
import { withMemoryDatabase } from '../memory/database.js';
import { queryOne } from '../memory/sqlite.js';
import type { ScheduledTask } from '../types/scheduler.js';
import { startTaskRun } from './task-runs.js';

// Five minutes (product implementation, 2026-10-23): tolerate timer drift,
// but do not deliver an old morning report after an outage. No backlog replay.
const LATE_MS = 5 * 60_000;
export function editionDate(task: ScheduledTask, dueMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: task.tz || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dueMs);
}
export function claimRoutineEdition(
  task: ScheduledTask,
  dueMs: number,
): number | null {
  return withMemoryDatabase((db) =>
    db
      .transaction(() => {
        const edition = editionDate(task, dueMs);
        const existing = queryOne<{ run_id: number }>(
          db,
          'SELECT run_id FROM routine_editions WHERE scope = ? AND routine_key = ? AND edition = ?',
          task.managed_scope,
          task.managed_key,
          edition,
        );
        if (existing) return null;
        const run = startTaskRun(task, dueMs);
        const late = Date.now() - dueMs > LATE_MS;
        db.prepare(
          'INSERT INTO routine_editions(scope, routine_key, edition, task_id, run_id, delivered) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
          task.managed_scope,
          task.managed_key,
          edition,
          task.id,
          run,
          late ? 1 : 0,
        );
        if (late)
          db.prepare(
            "UPDATE task_runs SET outcome = 'missed', started_at = NULL, ended_at = ? WHERE id = ?",
          ).run(new Date().toISOString(), run);
        // Keep only the current and preceding month's dedupe keys; task history
        // already has the same retention. Dates do not depend on schedule edits.
        db.prepare(
          'DELETE FROM routine_editions WHERE delivered = 1 AND edition < ?',
        ).run(
          new Date(Date.now() - 62 * 86_400_000).toISOString().slice(0, 10),
        );
        return late ? null : run;
      })
      .immediate(),
  );
}
export function savedEdition(
  run: number | undefined,
): ProactiveMessagePayload | null {
  if (!run) return null;
  return withMemoryDatabase((db) => {
    const row = queryOne<{ result: string | null }>(
      db,
      'SELECT result FROM routine_editions WHERE run_id = ?',
      run,
    );
    return row?.result
      ? (JSON.parse(row.result) as ProactiveMessagePayload)
      : null;
  });
}
export function saveEdition(
  run: number | undefined,
  result: ProactiveMessagePayload,
): void {
  if (!run) return;
  withMemoryDatabase((db) =>
    db
      .prepare(
        'UPDATE routine_editions SET result = COALESCE(result, ?) WHERE run_id = ?',
      )
      .run(JSON.stringify(result), run),
  );
}
export function deliveredEdition(run: number | undefined): void {
  if (!run) return;
  withMemoryDatabase((db) =>
    db
      .prepare('UPDATE routine_editions SET delivered = 1 WHERE run_id = ?')
      .run(run),
  );
}
export function pendingEdition(task: ScheduledTask): number | null {
  if (!task.managed_key) return null;
  return withMemoryDatabase((db) => {
    const today = editionDate(task, Date.now());
    db.prepare(
      'UPDATE routine_editions SET delivered = 1 WHERE scope = ? AND routine_key = ? AND edition < ?',
    ).run(task.managed_scope, task.managed_key, today);
    return (
      queryOne<{ run_id: number }>(
        db,
        `SELECT run_id FROM routine_editions WHERE task_id = ? AND scope = ? AND routine_key = ?
        AND delivered = 0 AND result IS NOT NULL AND edition = ?
        AND EXISTS (SELECT 1 FROM task_runs WHERE id = run_id) ORDER BY run_id DESC LIMIT 1`,
        task.id,
        task.managed_scope,
        task.managed_key,
        today,
      )?.run_id ?? null
    );
  });
}

export function resumeEdition(run: number): void {
  withMemoryDatabase((db) =>
    db
      .prepare(
        "UPDATE task_runs SET outcome = 'running', error = NULL, ended_at = NULL WHERE id = ?",
      )
      .run(run),
  );
}
