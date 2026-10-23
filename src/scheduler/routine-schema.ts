/**
 * Managed identities are unique across chats; editions survive task replacement.
 * Configuration stays in jobs, while editions keep execution/delivery identity.
 */
import type Database from 'better-sqlite3';
export function createRoutineSchema(db: Database.Database): void {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS jobs_managed_identity
    ON jobs(json_extract(action, '$.managedScope'), json_extract(action, '$.managedKey'))
    WHERE kind = 'scheduled_task' AND json_extract(action, '$.managedKey') IS NOT NULL;
    CREATE TABLE IF NOT EXISTS routine_editions (
      scope TEXT NOT NULL, routine_key TEXT NOT NULL, edition TEXT NOT NULL,
      task_id INTEGER NOT NULL, run_id INTEGER NOT NULL, result TEXT,
      delivered INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(scope, routine_key, edition)
    );`);
}
