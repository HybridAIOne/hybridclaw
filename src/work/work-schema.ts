/**
 * Schema for durable work records, installed once by the database migration.
 * No runtime access or delivery state is inferred here.
 */
import type Database from 'better-sqlite3';
export function createWorkSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_records (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, owner TEXT,
    session_id TEXT NOT NULL, message_id INTEGER, data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS work_records_owner ON work_records(agent_id, owner);
  CREATE UNIQUE INDEX IF NOT EXISTS work_records_message ON work_records(session_id, message_id);`);
}
