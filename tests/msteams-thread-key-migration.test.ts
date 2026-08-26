import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

let tempDir: string | null = null;
const ORIGINAL_HOME = process.env.HOME;

afterEach(() => {
  vi.resetModules();
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const OLD_KEY =
  'agent:main:channel:msteams:chat:channel:peer:19%3Achannel%40thread.tacv2%3Bmessageid%3D175:topic:19%3Ateam%40thread.tacv2';
const NEW_KEY =
  'agent:main:channel:msteams:chat:thread:peer:19%3Achannel%40thread.tacv2:thread:175:topic:19%3Ateam%40thread.tacv2';
const PLAIN_CHANNEL_KEY =
  'agent:main:channel:msteams:chat:channel:peer:19%3Aother%40thread.tacv2:topic:19%3Ateam%40thread.tacv2';

test('migrateV56 re-keys Teams channel-thread sessions', async () => {
  tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-msteams-thread-key-migration-'),
  );
  process.env.HOME = tempDir;
  const dbPath = path.join(tempDir, 'hybridclaw.db');

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true, dbPath });

  const seeded = new Database(dbPath);
  const insertSession = seeded.prepare(
    `INSERT INTO sessions (id, session_key, main_session_key, is_current, guild_id, channel_id, agent_id)
     VALUES (?, ?, ?, ?, ?, ?, 'main')`,
  );
  insertSession.run(
    'sess_old_thread',
    OLD_KEY,
    OLD_KEY,
    1,
    '19:team@thread.tacv2',
    '19:channel@thread.tacv2;messageid=175',
  );
  insertSession.run(
    'sess_plain_channel',
    PLAIN_CHANNEL_KEY,
    PLAIN_CHANNEL_KEY,
    1,
    '19:team@thread.tacv2',
    '19:other@thread.tacv2',
  );
  seeded
    .prepare(
      `INSERT INTO kv_store (agent_id, key, value, version, updated_at)
       VALUES (?, 'msteams:conversation-reference', '{}', 1, datetime('now'))`,
    )
    .run(OLD_KEY);
  seeded.pragma('user_version = 55');
  seeded.close();

  initDatabase({ quiet: true, dbPath });

  const migrated = new Database(dbPath, { readonly: true });
  try {
    const threadRow = migrated
      .prepare('SELECT session_key, main_session_key FROM sessions WHERE id = ?')
      .get('sess_old_thread') as {
      session_key: string;
      main_session_key: string;
    };
    expect(threadRow.session_key).toBe(NEW_KEY);
    expect(threadRow.main_session_key).toBe(NEW_KEY);

    const plainRow = migrated
      .prepare('SELECT session_key FROM sessions WHERE id = ?')
      .get('sess_plain_channel') as { session_key: string };
    expect(plainRow.session_key).toBe(PLAIN_CHANNEL_KEY);

    const kvRow = migrated
      .prepare(
        "SELECT agent_id FROM kv_store WHERE key = 'msteams:conversation-reference'",
      )
      .get() as { agent_id: string };
    expect(kvRow.agent_id).toBe(NEW_KEY);
  } finally {
    migrated.close();
  }
});
