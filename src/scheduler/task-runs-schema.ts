/**
 * Schema for the run history of scheduled tasks, installed once by the
 * database migration. A task's runs go with it: the trigger clears them when
 * its job row is deleted, so a later task that reuses the id starts empty.
 */
import type Database from 'better-sqlite3';

export function createTaskRunsSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    due_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    outcome TEXT NOT NULL,
    error TEXT,
    cost TEXT,
    work_id TEXT,
    noticed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS task_runs_task ON task_runs(task_id, id);
  CREATE TRIGGER IF NOT EXISTS task_runs_forget AFTER DELETE ON jobs
    WHEN OLD.legacy_task_id IS NOT NULL
    BEGIN DELETE FROM task_runs WHERE task_id = OLD.legacy_task_id; END;`);
}
