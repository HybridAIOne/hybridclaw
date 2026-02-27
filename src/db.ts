import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DB_PATH } from './config.js';
import { logger } from './logger.js';
import type { AuditEntry, ScheduledTask, Session, StoredMessage } from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      guild_id TEXT,
      channel_id TEXT NOT NULL,
      chatbot_id TEXT,
      model TEXT,
      enable_rag INTEGER DEFAULT 1,
      message_count INTEGER DEFAULT 0,
      session_summary TEXT,
      summary_updated_at TEXT,
      compaction_count INTEGER DEFAULT 0,
      memory_flush_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_active TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      prompt TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      last_run TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      event TEXT NOT NULL,
      detail TEXT,
      duration_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  `);
}

function migrateSchema(database: Database.Database): void {
  const addColumnIfMissing = (table: string, column: string, ddl: string): void => {
    const cols = database.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      logger.info({ table, column }, 'Migrated table: added column');
    }
  };

  // Add session columns if they don't exist
  const sessionCols = database.pragma('table_info(sessions)') as Array<{ name: string }>;
  if (!sessionCols.some((c) => c.name === 'model')) {
    database.exec('ALTER TABLE sessions ADD COLUMN model TEXT');
    logger.info('Migrated sessions table: added model column');
  }
  addColumnIfMissing('sessions', 'session_summary', 'session_summary TEXT');
  addColumnIfMissing('sessions', 'summary_updated_at', 'summary_updated_at TEXT');
  addColumnIfMissing('sessions', 'compaction_count', 'compaction_count INTEGER DEFAULT 0');
  addColumnIfMissing('sessions', 'memory_flush_at', 'memory_flush_at TEXT');

  // Add run_at and every_ms columns to tasks if they don't exist
  const taskCols = database.pragma('table_info(tasks)') as Array<{ name: string }>;
  if (!taskCols.some((c) => c.name === 'run_at')) {
    database.exec('ALTER TABLE tasks ADD COLUMN run_at TEXT');
    logger.info('Migrated tasks table: added run_at column');
  }
  if (!taskCols.some((c) => c.name === 'every_ms')) {
    database.exec('ALTER TABLE tasks ADD COLUMN every_ms INTEGER');
    logger.info('Migrated tasks table: added every_ms column');
  }
}

export function initDatabase(): void {
  const dbPath = path.resolve(DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  createSchema(db);
  migrateSchema(db);
  logger.info({ path: dbPath }, 'Database initialized');
}

// --- Sessions ---

export function getOrCreateSession(
  sessionId: string,
  guildId: string | null,
  channelId: string,
): Session {
  const existing = getSessionById(sessionId);

  if (existing) {
    db.prepare('UPDATE sessions SET last_active = datetime(\'now\') WHERE id = ?').run(sessionId);
    return existing;
  }

  db.prepare(
    'INSERT INTO sessions (id, guild_id, channel_id) VALUES (?, ?, ?)',
  ).run(sessionId, guildId, channelId);

  return getSessionById(sessionId) as Session;
}

export function getSessionById(sessionId: string): Session | undefined {
  return db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(sessionId) as Session | undefined;
}

export function updateSessionChatbot(sessionId: string, chatbotId: string | null): void {
  db.prepare('UPDATE sessions SET chatbot_id = ? WHERE id = ?').run(chatbotId, sessionId);
}

export function updateSessionModel(sessionId: string, model: string | null): void {
  db.prepare('UPDATE sessions SET model = ? WHERE id = ?').run(model, sessionId);
}

export function updateSessionRag(sessionId: string, enableRag: boolean): void {
  db.prepare('UPDATE sessions SET enable_rag = ? WHERE id = ?').run(enableRag ? 1 : 0, sessionId);
}

export function getAllSessions(): Session[] {
  return db.prepare('SELECT * FROM sessions ORDER BY last_active DESC').all() as Session[];
}

export function getSessionCount(): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
  return row.count;
}

export function clearSessionHistory(sessionId: string): number {
  const result = db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  db.prepare(
    'UPDATE sessions SET message_count = 0, session_summary = NULL, summary_updated_at = NULL, compaction_count = 0, memory_flush_at = NULL WHERE id = ?',
  ).run(sessionId);
  return result.changes;
}

// --- Messages ---

export function storeMessage(
  sessionId: string,
  userId: string,
  username: string | null,
  role: string,
  content: string,
): void {
  db.prepare(
    'INSERT INTO messages (session_id, user_id, username, role, content) VALUES (?, ?, ?, ?, ?)',
  ).run(sessionId, userId, username, role, content);

  db.prepare(
    'UPDATE sessions SET message_count = message_count + 1, last_active = datetime(\'now\') WHERE id = ?',
  ).run(sessionId);
}

export function getConversationHistory(sessionId: string, limit = 50): StoredMessage[] {
  return db
    .prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    )
    .all(sessionId, limit) as StoredMessage[];
}

export interface CompactionCandidate {
  cutoffId: number;
  olderMessages: StoredMessage[];
}

export function getCompactionCandidateMessages(
  sessionId: string,
  keepRecent: number,
): CompactionCandidate | null {
  const keep = Math.max(1, Math.floor(keepRecent));
  const cutoffRow = db
    .prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?')
    .get(sessionId, keep - 1) as { id: number } | undefined;
  if (!cutoffRow) return null;

  const older = db
    .prepare('SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id ASC')
    .all(sessionId, cutoffRow.id) as StoredMessage[];
  if (older.length === 0) return null;

  return {
    cutoffId: cutoffRow.id,
    olderMessages: older,
  };
}

export function deleteMessagesBeforeId(sessionId: string, cutoffId: number): number {
  const result = db
    .prepare('DELETE FROM messages WHERE session_id = ? AND id < ?')
    .run(sessionId, cutoffId);
  db.prepare(
    'UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?), last_active = datetime(\'now\') WHERE id = ?',
  ).run(sessionId, sessionId);
  return result.changes;
}

export function updateSessionSummary(sessionId: string, summary: string): void {
  const normalized = summary.trim();
  db.prepare(
    'UPDATE sessions SET session_summary = ?, summary_updated_at = datetime(\'now\'), compaction_count = compaction_count + 1 WHERE id = ?',
  ).run(normalized || null, sessionId);
}

export function markSessionMemoryFlush(sessionId: string): void {
  db.prepare('UPDATE sessions SET memory_flush_at = datetime(\'now\') WHERE id = ?').run(sessionId);
}

// --- Tasks ---

export function createTask(
  sessionId: string,
  channelId: string,
  cronExpr: string,
  prompt: string,
  runAt?: string,
  everyMs?: number,
): number {
  const result = db.prepare(
    'INSERT INTO tasks (session_id, channel_id, cron_expr, prompt, run_at, every_ms) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(sessionId, channelId, cronExpr, prompt, runAt || null, everyMs || null);
  return result.lastInsertRowid as number;
}

export function getTasksForSession(sessionId: string): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC')
    .all(sessionId) as ScheduledTask[];
}

export function getAllEnabledTasks(): ScheduledTask[] {
  return db.prepare('SELECT * FROM tasks WHERE enabled = 1').all() as ScheduledTask[];
}

export function updateTaskLastRun(taskId: number): void {
  db.prepare('UPDATE tasks SET last_run = datetime(\'now\') WHERE id = ?').run(taskId);
}

export function toggleTask(taskId: number, enabled: boolean): void {
  db.prepare('UPDATE tasks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, taskId);
}

export function deleteTask(taskId: number): void {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
}

// --- Audit ---

export function logAudit(
  event: string,
  sessionId?: string,
  detail?: Record<string, unknown>,
  durationMs?: number,
): void {
  db.prepare(
    'INSERT INTO audit_log (session_id, event, detail, duration_ms) VALUES (?, ?, ?, ?)',
  ).run(sessionId || null, event, detail ? JSON.stringify(detail) : null, durationMs || null);
}

export function getRecentAudit(limit = 20): AuditEntry[] {
  return db
    .prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?')
    .all(limit) as AuditEntry[];
}
