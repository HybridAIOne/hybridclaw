import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import {
  DATABASE_SCHEMA_VERSION,
  runMigrations,
} from '../src/memory/schema/migrations.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-channel-users-');

function withDatabase(check: (db: Database.Database) => void): void {
  const db = new Database(path.join(makeTempDir(), 'hybridclaw.db'));
  try {
    check(db);
  } finally {
    db.close();
  }
}

const hasLegacyTable = (db: Database.Database) =>
  db.prepare("SELECT name FROM sqlite_master WHERE name = 'msteams_users'").get();

test('fresh databases use only the channel user registry', () => {
  withDatabase((db) => {
    runMigrations(db, { quiet: true });
    expect(hasLegacyTable(db)).toBeUndefined();
    expect(db.prepare('SELECT * FROM channel_users').all()).toEqual([]);
    expect(db.pragma('user_version', { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
  });
});

test.each([73, 77, 78])('removes the frozen Teams table from schema %i without changing current mappings', (version) => {
  withDatabase((db) => {
    runMigrations(db, { quiet: true });
    db.exec(`CREATE TABLE msteams_users (user_id TEXT, agent_id TEXT);
      INSERT INTO msteams_users VALUES ('user_a', 'old-agent');
      INSERT INTO channel_users (channel_kind, tenant_id, user_id, agent_id, email)
        VALUES ('msteams', 'tenant_a', 'user_a', 'main', 'pat@example.com');`);
    const before = db.prepare('SELECT * FROM channel_users').all();
    db.prepare('DELETE FROM migrations WHERE version > ?').run(version);
    db.pragma(`user_version = ${version}`);
    runMigrations(db, { quiet: true });
    expect(hasLegacyTable(db)).toBeUndefined();
    expect(db.prepare('SELECT * FROM channel_users').all()).toEqual(before);
    expect(db.pragma('user_version', { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
    runMigrations(db, { quiet: true });
    expect(db.prepare('SELECT * FROM channel_users').all()).toEqual(before);
  });
});

test.each([62, 65, 72])('refuses an unmigrated Teams database at schema %i without changing it', (version) => {
  withDatabase((db) => {
    db.exec(`CREATE TABLE msteams_users (user_id TEXT, agent_id TEXT);
      INSERT INTO msteams_users VALUES ('user_a', 'main');`);
    db.pragma(`user_version = ${version}`);
    expect(() => runMigrations(db, { quiet: true })).toThrow('v0.40.8');
    expect(db.pragma('user_version', { simple: true })).toBe(version);
    expect(db.prepare('SELECT * FROM msteams_users').all()).toEqual([
      { user_id: 'user_a', agent_id: 'main' },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
      { name: 'msteams_users' },
    ]);
  });
});
