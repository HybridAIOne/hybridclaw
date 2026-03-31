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
let getCompactionCandidateMessages: typeof import('../src/memory/db.js').getCompactionCandidateMessages;
let deleteMessagesBeforeId: typeof import('../src/memory/db.js').deleteMessagesBeforeId;
let updateSessionSummary: typeof import('../src/memory/db.js').updateSessionSummary;
let forkSessionBranch: typeof import('../src/memory/db.js').forkSessionBranch;
let getSessionById: typeof import('../src/memory/db.js').getSessionById;
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
  getCompactionCandidateMessages = dbMod.getCompactionCandidateMessages;
  deleteMessagesBeforeId = dbMod.deleteMessagesBeforeId;
  updateSessionSummary = dbMod.updateSessionSummary;
  forkSessionBranch = dbMod.forkSessionBranch;
  getSessionById = dbMod.getSessionById;
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

  it('sequential writes produce unique message IDs', () => {
    const session = getOrCreateSession(
      'test-sequential-unique',
      'guild-1',
      'channel-1',
    );
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(
        storeMessage(session.id, 'user-1', 'Alice', 'user', `Message ${i}`),
      );
    }
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

  // --- Compaction tests ---

  it('getCompactionCandidateMessages returns null when fewer messages than keepRecent', () => {
    const session = getOrCreateSession(
      'test-compact-few',
      'guild-1',
      'channel-1',
    );
    for (let i = 0; i < 3; i++) {
      storeMessage(session.id, 'user-1', 'Alice', 'user', `msg ${i}`);
    }
    const result = getCompactionCandidateMessages(session.id, 10);
    expect(result).toBeNull();
  });

  it('getCompactionCandidateMessages identifies older messages for compaction', () => {
    const session = getOrCreateSession(
      'test-compact-candidates',
      'guild-1',
      'channel-1',
    );
    const messageIds: number[] = [];
    for (let i = 0; i < 25; i++) {
      messageIds.push(
        storeMessage(session.id, 'user-1', 'Alice', 'user', `Message ${i}`),
      );
    }

    const keepRecent = 5;
    const result = getCompactionCandidateMessages(session.id, keepRecent);
    expect(result).not.toBeNull();
    expect(result!.olderMessages.length).toBe(20);
    // All older messages should have IDs less than the cutoff.
    for (const msg of result!.olderMessages) {
      expect(msg.id).toBeLessThan(result!.cutoffId);
    }
  });

  it('compaction workflow: delete old messages and store summary', () => {
    const session = getOrCreateSession(
      'test-compact-workflow',
      'guild-1',
      'channel-1',
    );
    for (let i = 0; i < 25; i++) {
      storeMessage(session.id, 'user-1', 'Alice', 'user', `Chat line ${i}`);
    }

    const keepRecent = 5;
    const candidates = getCompactionCandidateMessages(session.id, keepRecent);
    expect(candidates).not.toBeNull();

    const deletedCount = deleteMessagesBeforeId(
      session.id,
      candidates!.cutoffId,
    );
    expect(deletedCount).toBe(20);

    // Store a summary for the compacted messages.
    updateSessionSummary(session.id, 'Summary of 20 older messages.');

    // Only the 5 most recent messages should remain.
    const remaining = getConversationHistory(session.id, 100);
    expect(remaining.length).toBe(5);
    for (const msg of remaining) {
      expect(msg.content).toMatch(/^Chat line (2[0-4])$/);
    }

    // Verify session summary and compaction_count were updated.
    const updatedSession = getSessionById(session.id);
    expect(updatedSession).toBeDefined();
    expect(updatedSession!.session_summary).toBe(
      'Summary of 20 older messages.',
    );
    expect(updatedSession!.compaction_count).toBeGreaterThanOrEqual(1);
  });

  // --- Session forking tests ---

  it('forkSessionBranch creates a new session with copied messages', () => {
    const session = getOrCreateSession(
      'test-fork-source',
      'guild-1',
      'channel-1',
    );
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(
        storeMessage(session.id, 'user-1', 'Alice', 'user', `Fork msg ${i}`),
      );
    }

    // Fork before message 6 — should copy messages 0..5 (IDs before ids[6]).
    const forkResult = forkSessionBranch({
      sessionId: session.id,
      beforeMessageId: ids[6],
    });
    expect(forkResult.session).toBeDefined();
    expect(forkResult.session.id).not.toBe(session.id);
    expect(forkResult.copiedMessageCount).toBe(6);

    // Verify fork has the copied messages.
    const forkHistory = getConversationHistory(forkResult.session.id, 100);
    expect(forkHistory.length).toBe(6);
    // History is DESC, so newest first.
    expect(forkHistory[0].content).toBe('Fork msg 5');
    expect(forkHistory[forkHistory.length - 1].content).toBe('Fork msg 0');
  });

  it('forked session is independent from the original', () => {
    const session = getOrCreateSession(
      'test-fork-independent',
      'guild-1',
      'channel-1',
    );
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        storeMessage(session.id, 'user-1', 'Alice', 'user', `Ind msg ${i}`),
      );
    }

    const forkResult = forkSessionBranch({
      sessionId: session.id,
      beforeMessageId: ids[3],
    });

    // Add a new message to the fork.
    storeMessage(
      forkResult.session.id,
      'user-1',
      'Alice',
      'user',
      'Fork-only message',
    );

    // Add a new message to the original.
    storeMessage(session.id, 'user-1', 'Alice', 'user', 'Original-only message');

    const originalHistory = getConversationHistory(session.id, 100);
    const forkHistory = getConversationHistory(forkResult.session.id, 100);

    const originalContents = originalHistory.map((m) => m.content);
    const forkContents = forkHistory.map((m) => m.content);

    expect(originalContents).toContain('Original-only message');
    expect(originalContents).not.toContain('Fork-only message');
    expect(forkContents).toContain('Fork-only message');
    expect(forkContents).not.toContain('Original-only message');
  });

  it('forkSessionBranch throws for invalid beforeMessageId', () => {
    const session = getOrCreateSession(
      'test-fork-invalid',
      'guild-1',
      'channel-1',
    );
    storeMessage(session.id, 'user-1', 'Alice', 'user', 'Only message');

    expect(() =>
      forkSessionBranch({ sessionId: session.id, beforeMessageId: 999999 }),
    ).toThrow();
  });
});
