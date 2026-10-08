/**
 * Schema for the channel user registry, installed once by migration v73.
 * Keyed like `usage_events` (channel kind, tenant, external user id), so usage
 * joins need no identity map. Reads and writes live in `channel-users.ts`.
 */
import type Database from 'better-sqlite3';

export function createChannelUsersSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS channel_users (
    channel_kind TEXT NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL,
    display_name TEXT,
    email TEXT,
    agent_id TEXT,
    profile_json TEXT NOT NULL DEFAULT '{}',
    message_count INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (channel_kind, tenant_id, user_id)
  )`);
}
