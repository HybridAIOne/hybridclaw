/**
 * Durable pull claims keep queued messages recoverable until acknowledgement.
 * This adds lease metadata to the existing queue, never a second message store.
 */
import type Database from 'better-sqlite3';
export function createProactiveClaimSchema(database: Database.Database): void {
  const columns = database
    .prepare('PRAGMA table_info(proactive_message_queue)')
    .all() as Array<{ name: string }>;
  for (const name of ['claim_token', 'claim_expires_at']) {
    if (!columns.some((column) => column.name === name))
      database.exec(
        `ALTER TABLE proactive_message_queue ADD COLUMN ${name} TEXT`,
      );
  }
}
