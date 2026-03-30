/**
 * Integration test: Real SQLite database — session and message lifecycle.
 *
 * Creates a real SQLite database in a temp directory and exercises the
 * actual SQL operations for sessions, messages, and canonical context.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let tmpDir: string;
let dbPath: string;
let Database: typeof import('better-sqlite3').default;

// Modules imported dynamically after env setup.
let initDatabase: typeof import('../src/memory/db.js').initDatabase;
let getOrCreateSession: typeof import('../src/memory/db.js').getOrCreateSession;
let storeMessage: typeof import('../src/memory/db.js').storeMessage;
let getConversationHistory: typeof import('../src/memory/db.js').getConversationHistory;
let getCanonicalContext: typeof import('../src/memory/db.js').getCanonicalContext;
let schemaVersion: number;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-db-integration-'));
  dbPath = path.join(tmpDir, 'data', 'test.db');

  // Point the runtime home at our temp dir so side-effecty config imports
  // resolve harmlessly.
  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';

  vi.resetModules();

  const sqliteMod = await import('better-sqlite3');
  Database = sqliteMod.default;

  const dbMod = await import('../src/memory/db.js');
  initDatabase = dbMod.initDatabase;
  getOrCreateSession = dbMod.getOrCreateSession;
  storeMessage = dbMod.storeMessage;
  getConversationHistory = dbMod.getConversationHistory;
  getCanonicalContext = dbMod.getCanonicalContext;
  schemaVersion = dbMod.DATABASE_SCHEMA_VERSION;

  initDatabase({ quiet: true, dbPath });
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Cleanup is best-effort.
  }
});

describe('database session integration', () => {
  it('initDatabase creates schema successfully', () => {
    const checkDb = new Database(dbPath, { readonly: true });
    try {
      const raw = checkDb.pragma('user_version', { simple: true });
      const version = typeof raw === 'number' ? raw : Number(raw);
      expect(version).toBe(schemaVersion);
    } finally {
      checkDb.close();
    }
  });

  it('getOrCreateSession creates a new session with correct fields', () => {
    const session = getOrCreateSession(
      'test-session-1',
      'guild-1',
      'channel-1',
    );
    expect(session).toBeDefined();
    expect(session.id).toBeTruthy();
    expect(session.guild_id).toBe('guild-1');
    expect(session.channel_id).toBe('channel-1');
  });

  it('storeMessage persists and retrieves messages in order', () => {
    const session = getOrCreateSession(
      'test-session-msg',
      'guild-1',
      'channel-1',
    );
    const id1 = storeMessage(session.id, 'user-1', 'Alice', 'user', 'Hello');
    const id2 = storeMessage(
      session.id,
      'user-1',
      'Alice',
      'user',
      'How are you?',
    );
    const id3 = storeMessage(
      session.id,
      'bot-1',
      'Bot',
      'assistant',
      'I am fine!',
    );

    expect(id1).toBeLessThan(id2);
    expect(id2).toBeLessThan(id3);

    const history = getConversationHistory(session.id, 50);
    // getConversationHistory returns DESC order, so newest first.
    expect(history.length).toBeGreaterThanOrEqual(3);
    expect(history[0].content).toBe('I am fine!');
  });

  it('multiple messages maintain correct ordering', () => {
    const session = getOrCreateSession(
      'test-session-order',
      'guild-1',
      'channel-1',
    );
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        storeMessage(session.id, 'user-1', 'Alice', 'user', `Message ${i}`),
      );
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  it('getOrCreateSession returns existing session on second call', () => {
    const first = getOrCreateSession(
      'test-session-reuse',
      'guild-1',
      'channel-1',
    );
    const second = getOrCreateSession(
      'test-session-reuse',
      'guild-1',
      'channel-1',
    );
    expect(first.id).toBe(second.id);
  });

  it('getCanonicalContext returns messages for correct session only', () => {
    const sessionA = getOrCreateSession(
      'test-ctx-a',
      'guild-1',
      'channel-ctx-a',
    );
    const sessionB = getOrCreateSession(
      'test-ctx-b',
      'guild-1',
      'channel-ctx-b',
    );

    storeMessage(sessionA.id, 'user-1', 'Alice', 'user', 'Session A msg');
    storeMessage(sessionB.id, 'user-1', 'Alice', 'user', 'Session B msg');

    const ctx = getCanonicalContext({
      agentId: sessionA.agent_id || 'default',
      userId: 'user-1',
      excludeSessionId: sessionB.id,
    });
    const contents = ctx.recent_messages.map((m) => m.content);
    expect(contents).not.toContain('Session B msg');
  });

  it('rapid sequential writes produce unique message IDs', async () => {
    const session = getOrCreateSession(
      'test-concurrent',
      'guild-1',
      'channel-1',
    );
    const promises = Array.from({ length: 20 }, (_, i) =>
      Promise.resolve(
        storeMessage(
          session.id,
          'user-1',
          'Alice',
          'user',
          `Concurrent ${i}`,
        ),
      ),
    );
    const ids = await Promise.all(promises);
    const unique = new Set(ids);
    expect(unique.size).toBe(20);
  });

  it('schema migrations run successfully on fresh DB', () => {
    const freshDbPath = path.join(tmpDir, 'data', 'fresh.db');
    initDatabase({ quiet: true, dbPath: freshDbPath });

    const freshDb = new Database(freshDbPath, { readonly: true });
    try {
      const raw = freshDb.pragma('user_version', { simple: true });
      const version = typeof raw === 'number' ? raw : Number(raw);
      expect(version).toBe(schemaVersion);
    } finally {
      freshDb.close();
    }
  });
});
