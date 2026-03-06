import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AuditEventPayload, WireRecord } from '../audit/audit-trail.js';
import { DB_PATH } from '../config/config.js';
import { logger } from '../logger.js';
import type {
  ApprovalAuditEntry,
  AuditEntry,
  CanonicalSession,
  CanonicalSessionContext,
  CanonicalSessionMessage,
  KnowledgeEntity,
  KnowledgeEntityTypeValue,
  KnowledgeGraphMatch,
  KnowledgeGraphPattern,
  KnowledgeRelationTypeValue,
  ScheduledTask,
  SemanticMemoryEntry,
  Session,
  StoredMessage,
  StructuredAuditEntry,
  UsageAgentAggregate,
  UsageDailyAggregate,
  UsageModelAggregate,
  UsageTotals,
  UsageWindow,
} from '../types.js';
import { KnowledgeEntityType, KnowledgeRelationType } from '../types.js';

let db: Database.Database;

const SCHEMA_VERSION = 5;

interface InitDatabaseOptions {
  quiet?: boolean;
  dbPath?: string;
}

interface TableInfoRow {
  name: string;
}

function getSchemaVersion(database: Database.Database): number {
  const raw = database.pragma('user_version', { simple: true });
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function setSchemaVersion(database: Database.Database, version: number): void {
  const bounded = Math.max(0, Math.trunc(version));
  database.pragma(`user_version = ${bounded}`);
}

function tableExists(database: Database.Database, table: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return Boolean(row?.name);
}

function columnExists(
  database: Database.Database,
  table: string,
  column: string,
): boolean {
  const cols = database.pragma(`table_info(${table})`) as TableInfoRow[];
  return cols.some((entry) => entry.name === column);
}

function addColumnIfMissing(params: {
  database: Database.Database;
  table: string;
  column: string;
  ddl: string;
  quiet: boolean;
}): void {
  if (!tableExists(params.database, params.table)) return;
  if (columnExists(params.database, params.table, params.column)) return;
  params.database.exec(`ALTER TABLE ${params.table} ADD COLUMN ${params.ddl}`);
  if (!params.quiet) {
    logger.info(
      { table: params.table, column: params.column },
      'Migrated table: added column',
    );
  }
}

function ensureMigrationTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      description TEXT
    );
  `);
}

function recordMigration(
  database: Database.Database,
  version: number,
  description: string,
): void {
  ensureMigrationTable(database);
  database
    .prepare(
      `INSERT OR IGNORE INTO migrations (version, applied_at, description)
       VALUES (?, datetime('now'), ?)`,
    )
    .run(version, description);
}

function migrateV1(database: Database.Database): void {
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

    CREATE TABLE IF NOT EXISTS semantic_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'conversation',
      scope TEXT NOT NULL DEFAULT 'episodic',
      metadata TEXT NOT NULL DEFAULT '{}',
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      embedding BLOB,
      source_message_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      accessed_at TEXT DEFAULT (datetime('now')),
      access_count INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS kv_store (
      agent_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value BLOB NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_kv_store_agent ON kv_store(agent_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      run_at TEXT,
      every_ms INTEGER,
      prompt TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      last_run TEXT,
      last_status TEXT,
      consecutive_errors INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      run_id TEXT NOT NULL,
      parent_run_id TEXT,
      payload TEXT NOT NULL,
      wire_hash TEXT NOT NULL,
      wire_prev_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_events_type_timestamp ON audit_events(event_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_events_session_seq ON audit_events(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_audit_events_run_seq ON audit_events(run_id, seq);

    CREATE TABLE IF NOT EXISTS observability_offsets (
      stream_key TEXT PRIMARY KEY,
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS observability_ingest_tokens (
      token_key TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      action TEXT NOT NULL,
      description TEXT,
      approved INTEGER NOT NULL,
      approved_by TEXT,
      method TEXT NOT NULL,
      policy_name TEXT,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_session_timestamp ON approvals(session_id, timestamp);

    CREATE TABLE IF NOT EXISTS proactive_message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      queued_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_proactive_queue_id ON proactive_message_queue(id);

    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      description TEXT
    );
  `);
  recordMigration(database, 1, 'Initial schema');
}

function migrateV2(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'model',
    ddl: 'model TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'session_summary',
    ddl: 'session_summary TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'summary_updated_at',
    ddl: 'summary_updated_at TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'compaction_count',
    ddl: 'compaction_count INTEGER DEFAULT 0',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'memory_flush_at',
    ddl: 'memory_flush_at TEXT',
    quiet,
  });

  addColumnIfMissing({
    database,
    table: 'tasks',
    column: 'run_at',
    ddl: 'run_at TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'tasks',
    column: 'every_ms',
    ddl: 'every_ms INTEGER',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'tasks',
    column: 'last_status',
    ddl: 'last_status TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'tasks',
    column: 'consecutive_errors',
    ddl: 'consecutive_errors INTEGER DEFAULT 0',
    quiet,
  });

  addColumnIfMissing({
    database,
    table: 'semantic_memories',
    column: 'embedding',
    ddl: 'embedding BLOB',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'semantic_memories',
    column: 'source',
    ddl: "source TEXT NOT NULL DEFAULT 'conversation'",
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'semantic_memories',
    column: 'scope',
    ddl: "scope TEXT NOT NULL DEFAULT 'episodic'",
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'semantic_memories',
    column: 'metadata',
    ddl: "metadata TEXT NOT NULL DEFAULT '{}'",
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'semantic_memories',
    column: 'deleted',
    ddl: 'deleted INTEGER NOT NULL DEFAULT 0',
    quiet,
  });

  // Semantic indexes are created after column migrations so older DBs can boot.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_semantic_memories_session ON semantic_memories(session_id);
    CREATE INDEX IF NOT EXISTS idx_semantic_memories_scope ON semantic_memories(scope);
    CREATE INDEX IF NOT EXISTS idx_semantic_memories_confidence ON semantic_memories(confidence);
    CREATE INDEX IF NOT EXISTS idx_semantic_memories_accessed ON semantic_memories(accessed_at);
    CREATE INDEX IF NOT EXISTS idx_semantic_memories_deleted ON semantic_memories(deleted);
  `);

  if (tableExists(database, 'memory_kv')) {
    database.exec(
      `INSERT OR IGNORE INTO kv_store (agent_id, key, value, version, updated_at)
       SELECT session_id,
              mem_key,
              CAST(value_json AS BLOB),
              1,
              COALESCE(updated_at, datetime('now'))
       FROM memory_kv`,
    );
    if (!quiet) logger.info('Migrated legacy memory_kv rows into kv_store');
  }

  recordMigration(
    database,
    2,
    'Backfill legacy columns/indexes and migrate memory_kv to kv_store',
  );
}

function migrateV3(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      name TEXT NOT NULL,
      properties TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      source_entity TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      target_entity TEXT NOT NULL,
      properties TEXT NOT NULL DEFAULT '{}',
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity);
    CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity);
    CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type);
  `);

  recordMigration(
    database,
    3,
    'Add knowledge graph entities/relations tables and indexes',
  );
}

function migrateV4(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS canonical_sessions (
      canonical_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      messages TEXT NOT NULL DEFAULT '[]',
      compaction_cursor INTEGER NOT NULL DEFAULT 0,
      compacted_summary TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_canonical_sessions_agent_user ON canonical_sessions(agent_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_canonical_sessions_updated ON canonical_sessions(updated_at);

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0.0,
      tool_calls INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_agent_time ON usage_events(agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_events_time ON usage_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_events_model_time ON usage_events(model, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_events_session_time ON usage_events(session_id, timestamp);
  `);

  recordMigration(
    database,
    4,
    'Add canonical_sessions and usage_events tables',
  );
}

function migrateV5(database: Database.Database): void {
  database.prepare(
    `CREATE TABLE IF NOT EXISTS sandbox_instances (
      agent_id TEXT PRIMARY KEY,
      sandbox_id TEXT NOT NULL,
      volume_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    )`,
  ).run();

  recordMigration(database, 5, 'Add sandbox_instances table');
}

function runMigrations(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const currentVersion = getSchemaVersion(database);
  const quiet = opts?.quiet === true;
  if (currentVersion > SCHEMA_VERSION) {
    if (!quiet) {
      logger.warn(
        { currentVersion, supportedVersion: SCHEMA_VERSION },
        'Database schema version is newer than this binary supports; skipping migrations',
      );
    }
    return;
  }

  if (currentVersion < 1) migrateV1(database);
  if (currentVersion < 2) migrateV2(database, opts);
  if (currentVersion < 3) migrateV3(database);
  if (currentVersion < 4) migrateV4(database);
  if (currentVersion < 5) migrateV5(database);

  setSchemaVersion(database, SCHEMA_VERSION);
  if (!quiet && currentVersion < SCHEMA_VERSION) {
    logger.info(
      { fromVersion: currentVersion, toVersion: SCHEMA_VERSION },
      'Database schema migrated',
    );
  }
}

export function initDatabase(opts?: InitDatabaseOptions): void {
  const quiet = opts?.quiet === true;
  const dbPath = path.resolve(opts?.dbPath || DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  runMigrations(db, opts);
  if (!quiet) logger.info({ path: dbPath }, 'Database initialized');
}

// --- Structured Memory (KV) ---

interface MemoryKvRow {
  agent_id: string;
  key: string;
  value: Buffer | Uint8Array | string;
  version: number;
  updated_at: string;
}

function normalizeMemoryKvKey(key: string): string {
  return key.trim();
}

function serializeMemoryKvValue(value: unknown): Buffer {
  if (typeof value === 'undefined') return Buffer.from('null', 'utf8');
  try {
    const serialized = JSON.stringify(value);
    return Buffer.from(
      typeof serialized === 'string' ? serialized : 'null',
      'utf8',
    );
  } catch {
    return Buffer.from('null', 'utf8');
  }
}

function parseMemoryKvValue(raw: unknown): unknown {
  const text = Buffer.isBuffer(raw)
    ? raw.toString('utf8')
    : raw instanceof Uint8Array
      ? Buffer.from(raw).toString('utf8')
      : typeof raw === 'string'
        ? raw
        : null;
  if (text == null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function getMemoryValue(sessionId: string, key: string): unknown | null {
  const normalizedKey = normalizeMemoryKvKey(key);
  if (!normalizedKey) return null;
  const row = db
    .prepare(
      `SELECT value
       FROM kv_store
       WHERE agent_id = ?
         AND key = ?`,
    )
    .get(sessionId, normalizedKey) as
    | { value: Buffer | Uint8Array | string }
    | undefined;
  if (!row) return null;
  return parseMemoryKvValue(row.value);
}

export function setMemoryValue(
  sessionId: string,
  key: string,
  value: unknown,
): void {
  const normalizedKey = normalizeMemoryKvKey(key);
  if (!normalizedKey) return;
  const valueBlob = serializeMemoryKvValue(value);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO kv_store (agent_id, key, value, version, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(agent_id, key)
     DO UPDATE SET value = excluded.value, version = version + 1, updated_at = excluded.updated_at`,
  ).run(sessionId, normalizedKey, valueBlob, now);
}

export function deleteMemoryValue(sessionId: string, key: string): boolean {
  const normalizedKey = normalizeMemoryKvKey(key);
  if (!normalizedKey) return false;
  const result = db
    .prepare(
      `DELETE FROM kv_store
       WHERE agent_id = ?
         AND key = ?`,
    )
    .run(sessionId, normalizedKey);
  return result.changes > 0;
}

export function listMemoryValues(
  sessionId: string,
  prefix?: string,
): Array<{
  agent_id: string;
  key: string;
  value: unknown;
  version: number;
  updated_at: string;
}> {
  const normalizedPrefix = (prefix || '').trim();
  const rows = normalizedPrefix
    ? (db
        .prepare(
          `SELECT agent_id, key, value, version, updated_at
           FROM kv_store
           WHERE agent_id = ?
             AND key LIKE ?
           ORDER BY key ASC`,
        )
        .all(sessionId, `${normalizedPrefix}%`) as MemoryKvRow[])
    : (db
        .prepare(
          `SELECT agent_id, key, value, version, updated_at
           FROM kv_store
           WHERE agent_id = ?
           ORDER BY key ASC`,
        )
        .all(sessionId) as MemoryKvRow[]);

  return rows.map((row) => ({
    agent_id: row.agent_id,
    key: row.key,
    value: parseMemoryKvValue(row.value),
    version: row.version,
    updated_at: row.updated_at,
  }));
}

// --- Canonical Sessions (Cross-Channel Memory) ---

const DEFAULT_CANONICAL_WINDOW = 50;
const DEFAULT_CANONICAL_COMPACTION_THRESHOLD = 100;
const CANONICAL_SUMMARY_MAX_CHARS = 4_000;
const CANONICAL_MESSAGE_MAX_CHARS = 220;

function canonicalSessionId(agentId: string, userId: string): string {
  return `${agentId}:${userId}`;
}

function normalizeCanonicalRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (
    normalized === 'user' ||
    normalized === 'assistant' ||
    normalized === 'system' ||
    normalized === 'tool'
  ) {
    return normalized;
  }
  return 'user';
}

function truncateCanonicalContent(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= CANONICAL_MESSAGE_MAX_CHARS) return compact;
  return `${compact.slice(0, CANONICAL_MESSAGE_MAX_CHARS)}...`;
}

function parseCanonicalMessages(raw: unknown): CanonicalSessionMessage[] {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    const messages: CanonicalSessionMessage[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Partial<CanonicalSessionMessage>;
      const content = typeof row.content === 'string' ? row.content.trim() : '';
      if (!content) continue;
      const sessionId =
        typeof row.session_id === 'string' ? row.session_id.trim() : '';
      if (!sessionId) continue;
      const createdAt =
        typeof row.created_at === 'string' && row.created_at.trim()
          ? row.created_at.trim()
          : new Date().toISOString();
      messages.push({
        role: normalizeCanonicalRole(
          typeof row.role === 'string' ? row.role : 'user',
        ),
        content,
        session_id: sessionId,
        channel_id:
          typeof row.channel_id === 'string' && row.channel_id.trim()
            ? row.channel_id.trim()
            : null,
        created_at: createdAt,
      });
    }
    return messages;
  } catch {
    return [];
  }
}

function serializeCanonicalMessages(
  messages: CanonicalSessionMessage[],
): string {
  try {
    return JSON.stringify(messages);
  } catch {
    return '[]';
  }
}

function buildCanonicalSummary(params: {
  previousSummary: string | null;
  compactingMessages: CanonicalSessionMessage[];
}): string | null {
  const lines: string[] = [];
  const previous = (params.previousSummary || '').trim();
  if (previous) lines.push(previous);
  for (const message of params.compactingMessages) {
    const role =
      message.role === 'assistant'
        ? 'Assistant'
        : message.role === 'system'
          ? 'System'
          : message.role === 'tool'
            ? 'Tool'
            : 'User';
    const compact = truncateCanonicalContent(message.content);
    if (!compact) continue;
    lines.push(`${role}: ${compact}`);
  }
  if (lines.length === 0) return previous || null;
  const merged = lines.join('\n');
  if (merged.length <= CANONICAL_SUMMARY_MAX_CHARS) return merged;
  return merged.slice(Math.max(0, merged.length - CANONICAL_SUMMARY_MAX_CHARS));
}

interface CanonicalSessionRow {
  canonical_id: string;
  agent_id: string;
  user_id: string;
  messages: string;
  compaction_cursor: number;
  compacted_summary: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

function saveCanonicalSession(session: CanonicalSession): void {
  db.prepare(
    `INSERT INTO canonical_sessions
      (canonical_id, agent_id, user_id, messages, compaction_cursor, compacted_summary, message_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(canonical_id) DO UPDATE SET
       messages = excluded.messages,
       compaction_cursor = excluded.compaction_cursor,
       compacted_summary = excluded.compacted_summary,
       message_count = excluded.message_count,
       updated_at = excluded.updated_at`,
  ).run(
    session.canonical_id,
    session.agent_id,
    session.user_id,
    serializeCanonicalMessages(session.messages),
    Math.max(0, Math.floor(session.compaction_cursor)),
    session.compacted_summary,
    Math.max(0, Math.floor(session.message_count)),
    session.created_at,
    session.updated_at,
  );
}

export function loadCanonicalSession(
  agentId: string,
  userId: string,
): CanonicalSession {
  const normalizedAgentId = agentId.trim();
  const normalizedUserId = userId.trim();
  if (!normalizedAgentId) {
    throw new Error('Canonical session agentId is required');
  }
  if (!normalizedUserId) {
    throw new Error('Canonical session userId is required');
  }
  const row = db
    .prepare(
      `SELECT canonical_id, agent_id, user_id, messages, compaction_cursor, compacted_summary, message_count, created_at, updated_at
       FROM canonical_sessions
       WHERE agent_id = ?
         AND user_id = ?
       LIMIT 1`,
    )
    .get(normalizedAgentId, normalizedUserId) as
    | CanonicalSessionRow
    | undefined;

  const now = new Date().toISOString();
  if (!row) {
    return {
      canonical_id: canonicalSessionId(normalizedAgentId, normalizedUserId),
      agent_id: normalizedAgentId,
      user_id: normalizedUserId,
      messages: [],
      compaction_cursor: 0,
      compacted_summary: null,
      message_count: 0,
      created_at: now,
      updated_at: now,
    };
  }

  return {
    canonical_id: row.canonical_id,
    agent_id: row.agent_id,
    user_id: row.user_id,
    messages: parseCanonicalMessages(row.messages),
    compaction_cursor: Math.max(0, Math.floor(row.compaction_cursor || 0)),
    compacted_summary: row.compacted_summary,
    message_count: Math.max(0, Math.floor(row.message_count || 0)),
    created_at: row.created_at || now,
    updated_at: row.updated_at || now,
  };
}

export function appendCanonicalMessages(params: {
  agentId: string;
  userId: string;
  newMessages: Array<{
    role: string;
    content: string;
    sessionId: string;
    channelId?: string | null;
    createdAt?: string | null;
  }>;
  windowSize?: number;
  compactionThreshold?: number;
}): CanonicalSession {
  const canonical = loadCanonicalSession(params.agentId, params.userId);
  const normalizedMessages = params.newMessages
    .map((entry) => {
      const content = entry.content.trim();
      const sessionId = entry.sessionId.trim();
      if (!content || !sessionId) return null;
      return {
        role: normalizeCanonicalRole(entry.role),
        content,
        session_id: sessionId,
        channel_id:
          typeof entry.channelId === 'string' && entry.channelId.trim()
            ? entry.channelId.trim()
            : null,
        created_at:
          typeof entry.createdAt === 'string' && entry.createdAt.trim()
            ? entry.createdAt.trim()
            : new Date().toISOString(),
      } satisfies CanonicalSessionMessage;
    })
    .filter((entry): entry is CanonicalSessionMessage => Boolean(entry));

  if (normalizedMessages.length === 0) return canonical;

  canonical.messages.push(...normalizedMessages);
  canonical.message_count += normalizedMessages.length;

  const windowSize = Math.max(
    1,
    Math.floor(params.windowSize || DEFAULT_CANONICAL_WINDOW),
  );
  const compactionThreshold = Math.max(
    windowSize + 1,
    Math.floor(
      params.compactionThreshold || DEFAULT_CANONICAL_COMPACTION_THRESHOLD,
    ),
  );

  if (canonical.messages.length > compactionThreshold) {
    const toCompact = canonical.messages.length - windowSize;
    if (toCompact > canonical.compaction_cursor) {
      const compacting = canonical.messages.slice(
        canonical.compaction_cursor,
        toCompact,
      );
      canonical.compacted_summary = buildCanonicalSummary({
        previousSummary: canonical.compacted_summary,
        compactingMessages: compacting,
      });
      canonical.compaction_cursor = toCompact;
      canonical.messages = canonical.messages.slice(toCompact);
      canonical.compaction_cursor = 0;
    }
  }

  canonical.updated_at = new Date().toISOString();
  saveCanonicalSession(canonical);
  return canonical;
}

export function getCanonicalContext(params: {
  agentId: string;
  userId: string;
  windowSize?: number;
  excludeSessionId?: string | null;
}): CanonicalSessionContext {
  const canonical = loadCanonicalSession(params.agentId, params.userId);
  const windowSize = Math.max(
    1,
    Math.floor(params.windowSize || DEFAULT_CANONICAL_WINDOW),
  );
  const start = Math.max(0, canonical.messages.length - windowSize);
  const recent = canonical.messages.slice(start);
  const excludeSessionId =
    typeof params.excludeSessionId === 'string'
      ? params.excludeSessionId.trim()
      : '';
  const filtered = excludeSessionId
    ? recent.filter((message) => message.session_id !== excludeSessionId)
    : recent;
  return {
    summary: canonical.compacted_summary,
    recent_messages: filtered,
  };
}

// --- Usage Tracking / Aggregation ---

function normalizeUsageWindow(window: UsageWindow | undefined): UsageWindow {
  if (window === 'daily' || window === 'monthly' || window === 'all') {
    return window;
  }
  return 'all';
}

function usageWindowWhereClause(window: UsageWindow): string | null {
  if (window === 'daily') {
    return "timestamp >= datetime('now', 'start of day')";
  }
  if (window === 'monthly') {
    return "timestamp >= datetime('now', 'start of month')";
  }
  return null;
}

function normalizeUsageNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  return 0;
}

function normalizeUsageCost(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, value);
  }
  return 0;
}

function applyUsageFilters(params: {
  whereClauses: string[];
  args: unknown[];
  agentId?: string;
  window?: UsageWindow;
}): void {
  const agentId = params.agentId?.trim();
  if (agentId) {
    params.whereClauses.push('agent_id = ?');
    params.args.push(agentId);
  }
  const window = normalizeUsageWindow(params.window);
  const windowClause = usageWindowWhereClause(window);
  if (windowClause) params.whereClauses.push(windowClause);
}

export function recordUsageEvent(params: {
  sessionId: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  toolCalls?: number;
  costUsd?: number;
  timestamp?: string;
}): void {
  const sessionId = params.sessionId.trim();
  const agentId = params.agentId.trim();
  const model = params.model.trim() || 'unknown';
  if (!sessionId || !agentId) return;
  const inputTokens = normalizeUsageNumber(params.inputTokens);
  const outputTokens = normalizeUsageNumber(params.outputTokens);
  const totalTokens = normalizeUsageNumber(
    params.totalTokens ?? inputTokens + outputTokens,
  );
  const toolCalls = normalizeUsageNumber(params.toolCalls);
  const costUsd = normalizeUsageCost(params.costUsd);
  const timestamp =
    typeof params.timestamp === 'string' && params.timestamp.trim()
      ? params.timestamp.trim()
      : new Date().toISOString();

  db.prepare(
    `INSERT INTO usage_events
      (id, session_id, agent_id, timestamp, model, input_tokens, output_tokens, total_tokens, cost_usd, tool_calls)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    sessionId,
    agentId,
    timestamp,
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    toolCalls,
  );
}

export function getUsageTotals(params?: {
  agentId?: string;
  window?: UsageWindow;
}): UsageTotals {
  const whereClauses: string[] = [];
  const args: unknown[] = [];
  applyUsageFilters({
    whereClauses,
    args,
    agentId: params?.agentId,
    window: params?.window,
  });
  const where =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
         COUNT(*) AS call_count,
         COALESCE(SUM(tool_calls), 0) AS total_tool_calls
       FROM usage_events
       ${where}`,
    )
    .get(...args) as UsageTotals;

  return {
    total_input_tokens: normalizeUsageNumber(row.total_input_tokens),
    total_output_tokens: normalizeUsageNumber(row.total_output_tokens),
    total_tokens: normalizeUsageNumber(row.total_tokens),
    total_cost_usd: normalizeUsageCost(row.total_cost_usd),
    call_count: normalizeUsageNumber(row.call_count),
    total_tool_calls: normalizeUsageNumber(row.total_tool_calls),
  };
}

export function listUsageByModel(params?: {
  agentId?: string;
  window?: UsageWindow;
}): UsageModelAggregate[] {
  const whereClauses: string[] = [];
  const args: unknown[] = [];
  applyUsageFilters({
    whereClauses,
    args,
    agentId: params?.agentId,
    window: params?.window,
  });
  const where =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT
         model,
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
         COUNT(*) AS call_count,
         COALESCE(SUM(tool_calls), 0) AS total_tool_calls
       FROM usage_events
       ${where}
       GROUP BY model
       ORDER BY total_cost_usd DESC, total_tokens DESC, call_count DESC`,
    )
    .all(...args) as UsageModelAggregate[];

  return rows.map((row) => ({
    model: row.model,
    total_input_tokens: normalizeUsageNumber(row.total_input_tokens),
    total_output_tokens: normalizeUsageNumber(row.total_output_tokens),
    total_tokens: normalizeUsageNumber(row.total_tokens),
    total_cost_usd: normalizeUsageCost(row.total_cost_usd),
    call_count: normalizeUsageNumber(row.call_count),
    total_tool_calls: normalizeUsageNumber(row.total_tool_calls),
  }));
}

export function listUsageByAgent(params?: {
  window?: UsageWindow;
}): UsageAgentAggregate[] {
  const whereClauses: string[] = [];
  const args: unknown[] = [];
  applyUsageFilters({
    whereClauses,
    args,
    window: params?.window,
  });
  const where =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT
         agent_id,
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
         COUNT(*) AS call_count,
         COALESCE(SUM(tool_calls), 0) AS total_tool_calls
       FROM usage_events
       ${where}
       GROUP BY agent_id
       ORDER BY total_cost_usd DESC, total_tokens DESC, call_count DESC`,
    )
    .all(...args) as UsageAgentAggregate[];

  return rows.map((row) => ({
    agent_id: row.agent_id,
    total_input_tokens: normalizeUsageNumber(row.total_input_tokens),
    total_output_tokens: normalizeUsageNumber(row.total_output_tokens),
    total_tokens: normalizeUsageNumber(row.total_tokens),
    total_cost_usd: normalizeUsageCost(row.total_cost_usd),
    call_count: normalizeUsageNumber(row.call_count),
    total_tool_calls: normalizeUsageNumber(row.total_tool_calls),
  }));
}

export function listUsageDailyBreakdown(params?: {
  agentId?: string;
  days?: number;
}): UsageDailyAggregate[] {
  const days = Math.max(1, Math.min(365, Math.floor(params?.days || 30)));
  const whereClauses: string[] = [
    `timestamp >= datetime('now', '-${days} days')`,
  ];
  const args: unknown[] = [];
  const agentId = params?.agentId?.trim();
  if (agentId) {
    whereClauses.push('agent_id = ?');
    args.push(agentId);
  }
  const rows = db
    .prepare(
      `SELECT
         date(timestamp) AS day,
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
         COUNT(*) AS call_count,
         COALESCE(SUM(tool_calls), 0) AS total_tool_calls
       FROM usage_events
       WHERE ${whereClauses.join(' AND ')}
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(...args) as UsageDailyAggregate[];

  return rows.map((row) => ({
    day: row.day,
    total_input_tokens: normalizeUsageNumber(row.total_input_tokens),
    total_output_tokens: normalizeUsageNumber(row.total_output_tokens),
    total_tokens: normalizeUsageNumber(row.total_tokens),
    total_cost_usd: normalizeUsageCost(row.total_cost_usd),
    call_count: normalizeUsageNumber(row.call_count),
    total_tool_calls: normalizeUsageNumber(row.total_tool_calls),
  }));
}

// --- Knowledge Graph ---

interface RawKnowledgeGraphRow {
  s_id: string;
  s_type: string;
  s_name: string;
  s_properties: string;
  s_created_at: string;
  s_updated_at: string;
  r_id: string;
  r_source: string;
  r_type: string;
  r_target: string;
  r_properties: string;
  r_confidence: number;
  r_created_at: string;
  t_id: string;
  t_type: string;
  t_name: string;
  t_properties: string;
  t_created_at: string;
  t_updated_at: string;
}

function normalizeKnowledgeCustomValue(raw: string): string {
  const value = raw.trim().toLowerCase();
  return value || 'unknown';
}

function normalizeEntityType(
  entityType: KnowledgeEntityTypeValue | string,
): KnowledgeEntityTypeValue {
  if (typeof entityType === 'object' && entityType) {
    if (typeof entityType.custom === 'string') {
      return { custom: normalizeKnowledgeCustomValue(entityType.custom) };
    }
    return { custom: 'unknown' };
  }

  const normalized = normalizeKnowledgeCustomValue(entityType);
  switch (normalized) {
    case 'person':
      return KnowledgeEntityType.Person;
    case 'organization':
    case 'org':
      return KnowledgeEntityType.Organization;
    case 'project':
      return KnowledgeEntityType.Project;
    case 'concept':
      return KnowledgeEntityType.Concept;
    case 'event':
      return KnowledgeEntityType.Event;
    case 'location':
      return KnowledgeEntityType.Location;
    case 'document':
    case 'doc':
      return KnowledgeEntityType.Document;
    case 'tool':
      return KnowledgeEntityType.Tool;
    default:
      return { custom: normalized };
  }
}

function normalizeRelationType(
  relation: KnowledgeRelationTypeValue | string,
): KnowledgeRelationTypeValue {
  if (typeof relation === 'object' && relation) {
    if (typeof relation.custom === 'string') {
      return { custom: normalizeKnowledgeCustomValue(relation.custom) };
    }
    return { custom: 'unknown' };
  }

  const normalized = normalizeKnowledgeCustomValue(relation)
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_');
  switch (normalized) {
    case 'works_at':
    case 'worksat':
      return KnowledgeRelationType.WorksAt;
    case 'knows_about':
    case 'knowsabout':
    case 'knows':
      return KnowledgeRelationType.KnowsAbout;
    case 'related_to':
    case 'relatedto':
    case 'related':
      return KnowledgeRelationType.RelatedTo;
    case 'depends_on':
    case 'dependson':
    case 'depends':
      return KnowledgeRelationType.DependsOn;
    case 'owned_by':
    case 'ownedby':
      return KnowledgeRelationType.OwnedBy;
    case 'created_by':
    case 'createdby':
      return KnowledgeRelationType.CreatedBy;
    case 'located_in':
    case 'locatedin':
      return KnowledgeRelationType.LocatedIn;
    case 'part_of':
    case 'partof':
      return KnowledgeRelationType.PartOf;
    case 'uses':
      return KnowledgeRelationType.Uses;
    case 'produces':
      return KnowledgeRelationType.Produces;
    default:
      return { custom: normalized };
  }
}

function serializeEntityType(
  entityType: KnowledgeEntityTypeValue | string,
): string {
  const normalized = normalizeEntityType(entityType);
  return typeof normalized === 'string'
    ? JSON.stringify(normalized)
    : JSON.stringify({ custom: normalized.custom });
}

function serializeRelationType(
  relation: KnowledgeRelationTypeValue | string,
): string {
  const normalized = normalizeRelationType(relation);
  return typeof normalized === 'string'
    ? JSON.stringify(normalized)
    : JSON.stringify({ custom: normalized.custom });
}

function parseEntityType(
  raw: string | null | undefined,
): KnowledgeEntityTypeValue {
  const value = (raw || '').trim();
  if (!value) return { custom: 'unknown' };

  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === 'string') return normalizeEntityType(parsed);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { custom?: unknown }).custom === 'string'
    ) {
      return normalizeEntityType({
        custom: (parsed as { custom: string }).custom,
      });
    }
  } catch {
    return normalizeEntityType(value);
  }

  return { custom: 'unknown' };
}

function parseRelationType(
  raw: string | null | undefined,
): KnowledgeRelationTypeValue {
  const value = (raw || '').trim();
  if (!value) return { custom: 'unknown' };

  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === 'string') return normalizeRelationType(parsed);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { custom?: unknown }).custom === 'string'
    ) {
      return normalizeRelationType({
        custom: (parsed as { custom: string }).custom,
      });
    }
  } catch {
    return normalizeRelationType(value);
  }

  return { custom: 'unknown' };
}

function serializeKnowledgeProperties(
  properties: Record<string, unknown> | null | undefined,
): string {
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  ) {
    return '{}';
  }
  try {
    return JSON.stringify(properties);
  } catch {
    return '{}';
  }
}

function parseKnowledgeProperties(raw: unknown): Record<string, unknown> {
  const text = Buffer.isBuffer(raw)
    ? raw.toString('utf8')
    : raw instanceof Uint8Array
      ? Buffer.from(raw).toString('utf8')
      : typeof raw === 'string'
        ? raw
        : '{}';
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mapKnowledgeEntity(params: {
  id: string;
  entityTypeRaw: string;
  name: string;
  propertiesRaw: unknown;
  createdAt: string;
  updatedAt: string;
}): KnowledgeEntity {
  return {
    id: params.id,
    entity_type: parseEntityType(params.entityTypeRaw),
    name: params.name,
    properties: parseKnowledgeProperties(params.propertiesRaw),
    created_at: params.createdAt,
    updated_at: params.updatedAt,
  };
}

function mapKnowledgeMatchRow(row: RawKnowledgeGraphRow): KnowledgeGraphMatch {
  return {
    source: mapKnowledgeEntity({
      id: row.s_id,
      entityTypeRaw: row.s_type,
      name: row.s_name,
      propertiesRaw: row.s_properties,
      createdAt: row.s_created_at,
      updatedAt: row.s_updated_at,
    }),
    relation: {
      source: row.r_source,
      relation: parseRelationType(row.r_type),
      target: row.r_target,
      properties: parseKnowledgeProperties(row.r_properties),
      confidence: Math.max(0, Math.min(1, Number(row.r_confidence) || 0)),
      created_at: row.r_created_at,
    },
    target: mapKnowledgeEntity({
      id: row.t_id,
      entityTypeRaw: row.t_type,
      name: row.t_name,
      propertiesRaw: row.t_properties,
      createdAt: row.t_created_at,
      updatedAt: row.t_updated_at,
    }),
  };
}

export function addKnowledgeEntity(params: {
  id?: string | null;
  name: string;
  entityType: KnowledgeEntityTypeValue | string;
  properties?: Record<string, unknown> | null;
}): string {
  const name = params.name.trim();
  if (!name) throw new Error('Knowledge graph entity name is required');

  const entityId = params.id?.trim() || randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO entities (id, entity_type, name, properties, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       properties = excluded.properties,
       updated_at = excluded.updated_at`,
  ).run(
    entityId,
    serializeEntityType(params.entityType),
    name,
    serializeKnowledgeProperties(params.properties),
    now,
    now,
  );

  return entityId;
}

export function addKnowledgeRelation(params: {
  source: string;
  relation: KnowledgeRelationTypeValue | string;
  target: string;
  properties?: Record<string, unknown> | null;
  confidence?: number;
}): string {
  const source = params.source.trim();
  const target = params.target.trim();
  if (!source) throw new Error('Knowledge graph relation source is required');
  if (!target) throw new Error('Knowledge graph relation target is required');

  const id = randomUUID();
  const rawConfidence =
    typeof params.confidence === 'number' && Number.isFinite(params.confidence)
      ? params.confidence
      : 1;
  const confidence = Math.max(0, Math.min(1, rawConfidence));
  db.prepare(
    `INSERT INTO relations
      (id, source_entity, relation_type, target_entity, properties, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    source,
    serializeRelationType(params.relation),
    target,
    serializeKnowledgeProperties(params.properties),
    confidence,
    new Date().toISOString(),
  );

  return id;
}

export function queryKnowledgeGraph(
  pattern: KnowledgeGraphPattern = {},
): KnowledgeGraphMatch[] {
  const sql = [
    `SELECT
       s.id AS s_id,
       s.entity_type AS s_type,
       s.name AS s_name,
       s.properties AS s_properties,
       s.created_at AS s_created_at,
       s.updated_at AS s_updated_at,
       r.id AS r_id,
       r.source_entity AS r_source,
       r.relation_type AS r_type,
       r.target_entity AS r_target,
       r.properties AS r_properties,
       r.confidence AS r_confidence,
       r.created_at AS r_created_at,
       t.id AS t_id,
       t.entity_type AS t_type,
       t.name AS t_name,
       t.properties AS t_properties,
       t.created_at AS t_created_at,
       t.updated_at AS t_updated_at
     FROM relations r
     JOIN entities s ON r.source_entity = s.id
     JOIN entities t ON r.target_entity = t.id
     WHERE 1 = 1`,
  ];
  const args: unknown[] = [];

  const source = pattern.source?.trim();
  if (source) {
    sql.push('AND (s.id = ? OR s.name = ?)');
    args.push(source, source);
  }

  if (pattern.relation) {
    sql.push('AND r.relation_type = ?');
    args.push(serializeRelationType(pattern.relation));
  }

  const target = pattern.target?.trim();
  if (target) {
    sql.push('AND (t.id = ? OR t.name = ?)');
    args.push(target, target);
  }

  // OpenFang-compatible v1 query semantics: single-hop relation scan, max 100.
  sql.push('LIMIT 100');

  const rows = db
    .prepare(sql.join('\n'))
    .all(...args) as RawKnowledgeGraphRow[];
  return rows.map(mapKnowledgeMatchRow);
}

// --- Sessions ---

export function getOrCreateSession(
  sessionId: string,
  guildId: string | null,
  channelId: string,
): Session {
  const existing = getSessionById(sessionId);

  if (existing) {
    db.prepare(
      "UPDATE sessions SET last_active = datetime('now') WHERE id = ?",
    ).run(sessionId);
    return existing;
  }

  db.prepare(
    'INSERT INTO sessions (id, guild_id, channel_id) VALUES (?, ?, ?)',
  ).run(sessionId, guildId, channelId);

  return getSessionById(sessionId) as Session;
}

export function getSessionById(sessionId: string): Session | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    | Session
    | undefined;
}

export function updateSessionChatbot(
  sessionId: string,
  chatbotId: string | null,
): void {
  db.prepare('UPDATE sessions SET chatbot_id = ? WHERE id = ?').run(
    chatbotId,
    sessionId,
  );
}

export function updateSessionModel(
  sessionId: string,
  model: string | null,
): void {
  db.prepare('UPDATE sessions SET model = ? WHERE id = ?').run(
    model,
    sessionId,
  );
}

export function updateSessionRag(sessionId: string, enableRag: boolean): void {
  db.prepare('UPDATE sessions SET enable_rag = ? WHERE id = ?').run(
    enableRag ? 1 : 0,
    sessionId,
  );
}

export function getAllSessions(): Session[] {
  return db
    .prepare('SELECT * FROM sessions ORDER BY last_active DESC')
    .all() as Session[];
}

export function getSessionCount(): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as {
    count: number;
  };
  return row.count;
}

export function getMostRecentSessionChannelId(): string | null {
  const row = db
    .prepare(
      'SELECT channel_id FROM sessions ORDER BY last_active DESC LIMIT 1',
    )
    .get() as { channel_id?: string } | undefined;
  if (!row || typeof row.channel_id !== 'string') return null;
  const channelId = row.channel_id.trim();
  return channelId || null;
}

export function clearSessionHistory(sessionId: string): number {
  const result = db
    .prepare('DELETE FROM messages WHERE session_id = ?')
    .run(sessionId);
  db.prepare('DELETE FROM semantic_memories WHERE session_id = ?').run(
    sessionId,
  );
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
): number {
  const result = db
    .prepare(
      'INSERT INTO messages (session_id, user_id, username, role, content) VALUES (?, ?, ?, ?, ?)',
    )
    .run(sessionId, userId, username, role, content);

  db.prepare(
    "UPDATE sessions SET message_count = message_count + 1, last_active = datetime('now') WHERE id = ?",
  ).run(sessionId);

  return result.lastInsertRowid as number;
}

export function getConversationHistory(
  sessionId: string,
  limit = 50,
): StoredMessage[] {
  return db
    .prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    )
    .all(sessionId, limit) as StoredMessage[];
}

export function getRecentMessages(
  sessionId: string,
  limit?: number,
): StoredMessage[] {
  const boundedLimit =
    typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : null;

  if (boundedLimit == null) {
    return db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId) as StoredMessage[];
  }

  const rows = db
    .prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    )
    .all(sessionId, boundedLimit) as StoredMessage[];
  return rows.reverse();
}

function parseTimestamp(raw: string): number {
  const value = raw.trim();
  if (!value) return 0;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    const parsed = Date.parse(`${value.replace(' ', 'T')}Z`);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseQueryTerms(query: string): string[] {
  const lower = query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/g)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  if (lower.length === 0) return [];
  const unique = new Set<string>();
  for (const term of lower) {
    unique.add(term);
    if (unique.size >= 8) break;
  }
  return [...unique];
}

const MAX_EMBEDDING_DIMENSIONS = 2048;

function normalizeEmbeddingInput(
  embedding: number[] | null | undefined,
): Float32Array | null {
  if (!Array.isArray(embedding) || embedding.length === 0) return null;
  if (embedding.length > MAX_EMBEDDING_DIMENSIONS) return null;
  const values: number[] = [];
  for (const value of embedding) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    values.push(value);
  }
  if (values.length === 0) return null;
  return new Float32Array(values);
}

function embeddingToBlob(embedding: Float32Array): Buffer {
  const buffer = Buffer.allocUnsafe(embedding.length * 4);
  for (let i = 0; i < embedding.length; i += 1) {
    buffer.writeFloatLE(embedding[i], i * 4);
  }
  return buffer;
}

function embeddingFromBlob(raw: unknown): number[] | null {
  if (!raw) return null;
  const bytes = Buffer.isBuffer(raw)
    ? raw
    : raw instanceof Uint8Array
      ? Buffer.from(raw)
      : null;
  if (!bytes || bytes.length === 0 || bytes.length % 4 !== 0) return null;
  const values: number[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    values.push(bytes.readFloatLE(i));
  }
  return values.length > 0 ? values : null;
}

function cosineSimilarity(a: Float32Array, b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const bv = b[i];
    if (!Number.isFinite(bv)) return -1;
    dot += a[i] * bv;
    normA += a[i] * a[i];
    normB += bv * bv;
  }
  if (normA <= Number.EPSILON || normB <= Number.EPSILON) return -1;
  return dot / Math.sqrt(normA * normB);
}

function scoreSemanticLikeCandidate(
  row: SemanticMemoryEntry,
  normalizedQuery: string,
  queryTerms: string[],
): number {
  const content = row.content.toLowerCase();
  let score = 0;
  if (content.includes(normalizedQuery)) score += 8;
  if (content.startsWith(normalizedQuery)) score += 3;

  let termHits = 0;
  for (const term of queryTerms) {
    if (content.includes(term)) termHits += 1;
  }
  score += termHits * 2;
  score += Math.max(0, Math.min(1, row.confidence)) * 4;

  const hoursSinceAccess = Math.max(
    0,
    (Date.now() - parseTimestamp(row.accessed_at)) / 3_600_000,
  );
  if (hoursSinceAccess < 24) score += 1;
  return score;
}

interface RawSemanticMemoryRow {
  id: number;
  session_id: string;
  role: string;
  source: string;
  scope: string;
  metadata: string | null;
  content: string;
  confidence: number;
  embedding: Buffer | Uint8Array | null;
  source_message_id: number | null;
  created_at: string;
  accessed_at: string;
  access_count: number;
}

function parseSemanticMetadata(
  raw: string | null | undefined,
): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function serializeSemanticMetadata(metadata: Record<string, unknown>): string {
  try {
    return JSON.stringify(metadata);
  } catch {
    return '{}';
  }
}

function mapSemanticMemoryRow(row: RawSemanticMemoryRow): SemanticMemoryEntry {
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    source: (row.source || '').trim() || 'conversation',
    scope: (row.scope || '').trim() || 'episodic',
    metadata: parseSemanticMetadata(row.metadata),
    content: row.content,
    confidence: row.confidence,
    embedding: embeddingFromBlob(row.embedding),
    source_message_id: row.source_message_id,
    created_at: row.created_at,
    accessed_at: row.accessed_at,
    access_count: row.access_count,
  };
}

function touchSemanticMemoryRows(entries: SemanticMemoryEntry[]): void {
  if (entries.length === 0) return;
  const touch = db.prepare(
    `UPDATE semantic_memories
     SET access_count = access_count + 1,
         accessed_at = datetime('now')
     WHERE id = ?
       AND deleted = 0`,
  );
  const transaction = db.transaction((rows: SemanticMemoryEntry[]) => {
    for (const row of rows) {
      touch.run(row.id);
    }
  });
  transaction(entries);
}

export function touchSemanticMemories(ids: number[]): void {
  const uniqueIds = [
    ...new Set(ids.map((id) => Math.floor(id)).filter((id) => id > 0)),
  ];
  if (uniqueIds.length === 0) return;
  const touch = db.prepare(
    `UPDATE semantic_memories
     SET access_count = access_count + 1,
         accessed_at = datetime('now')
     WHERE id = ?
       AND deleted = 0`,
  );
  const transaction = db.transaction((rowIds: number[]) => {
    for (const id of rowIds) {
      touch.run(id);
    }
  });
  transaction(uniqueIds);
}

export interface SemanticRecallFilter {
  role?: string;
  source?: string;
  scope?: string;
  after?: string;
  before?: string;
}

function applySemanticRecallFilterClauses(params: {
  whereClauses: string[];
  args: unknown[];
  filter?: SemanticRecallFilter;
}): void {
  if (!params.filter) return;
  const role = params.filter.role?.trim();
  if (role) {
    params.whereClauses.push('role = ?');
    params.args.push(role);
  }
  const source = params.filter.source?.trim();
  if (source) {
    params.whereClauses.push('source = ?');
    params.args.push(source);
  }
  const scope = params.filter.scope?.trim();
  if (scope) {
    params.whereClauses.push('scope = ?');
    params.args.push(scope);
  }
  const after = params.filter.after?.trim();
  if (after) {
    params.whereClauses.push('created_at >= ?');
    params.args.push(after);
  }
  const before = params.filter.before?.trim();
  if (before) {
    params.whereClauses.push('created_at <= ?');
    params.args.push(before);
  }
}

function recallSemanticMemoriesByLike(params: {
  sessionId: string;
  normalizedQuery: string;
  queryTerms: string[];
  limit: number;
  minConfidence: number;
  filter?: SemanticRecallFilter;
}): SemanticMemoryEntry[] {
  if (params.queryTerms.length === 0) return [];
  const candidateLimit = Math.max(params.limit * 8, 50);
  const likePatterns = params.queryTerms.map((term) => `%${term}%`);
  const placeholders = likePatterns
    .map(() => 'LOWER(content) LIKE ?')
    .join(' OR ');
  const whereClauses: string[] = [
    'session_id = ?',
    'deleted = 0',
    'confidence >= ?',
    `(${placeholders})`,
  ];
  const args: unknown[] = [
    params.sessionId,
    params.minConfidence,
    ...likePatterns,
  ];
  applySemanticRecallFilterClauses({
    whereClauses,
    args,
    filter: params.filter,
  });
  args.push(candidateLimit);

  const rawRows = db
    .prepare(
      `SELECT *
       FROM semantic_memories
       WHERE ${whereClauses.join('\n         AND ')}
       ORDER BY confidence DESC, accessed_at DESC
       LIMIT ?`,
    )
    .all(...args) as RawSemanticMemoryRow[];
  if (rawRows.length === 0) return [];

  const ranked = rawRows
    .map(mapSemanticMemoryRow)
    .map((row) => ({
      row,
      score: scoreSemanticLikeCandidate(
        row,
        params.normalizedQuery,
        params.queryTerms,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.row.confidence !== a.row.confidence) {
        return b.row.confidence - a.row.confidence;
      }
      return (
        parseTimestamp(b.row.accessed_at) - parseTimestamp(a.row.accessed_at)
      );
    })
    .slice(0, params.limit)
    .map((entry) => entry.row);

  touchSemanticMemoryRows(ranked);
  return ranked;
}

function recallSemanticMemoriesByVector(params: {
  sessionId: string;
  queryEmbedding: Float32Array;
  limit: number;
  minConfidence: number;
  filter?: SemanticRecallFilter;
}): SemanticMemoryEntry[] {
  const candidateLimit = Math.max(params.limit * 10, 100);
  const whereClauses: string[] = [
    'session_id = ?',
    'deleted = 0',
    'confidence >= ?',
  ];
  const args: unknown[] = [params.sessionId, params.minConfidence];
  applySemanticRecallFilterClauses({
    whereClauses,
    args,
    filter: params.filter,
  });
  args.push(candidateLimit);
  const rawRows = db
    .prepare(
      `SELECT *
       FROM semantic_memories
       WHERE ${whereClauses.join('\n         AND ')}
       ORDER BY accessed_at DESC, confidence DESC
       LIMIT ?`,
    )
    .all(...args) as RawSemanticMemoryRow[];
  if (rawRows.length === 0) return [];

  const rows = rawRows.map(mapSemanticMemoryRow);
  const ranked = rows
    .map((row) => {
      const similarity = row.embedding
        ? cosineSimilarity(params.queryEmbedding, row.embedding)
        : -1;
      return {
        row,
        similarity,
      };
    })
    .sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      if (b.row.confidence !== a.row.confidence) {
        return b.row.confidence - a.row.confidence;
      }
      return (
        parseTimestamp(b.row.accessed_at) - parseTimestamp(a.row.accessed_at)
      );
    })
    .slice(0, params.limit)
    .map((entry) => entry.row);

  touchSemanticMemoryRows(ranked);
  return ranked;
}

function recallSemanticMemoriesByRecent(params: {
  sessionId: string;
  limit: number;
  minConfidence: number;
  filter?: SemanticRecallFilter;
}): SemanticMemoryEntry[] {
  const whereClauses: string[] = [
    'session_id = ?',
    'deleted = 0',
    'confidence >= ?',
  ];
  const args: unknown[] = [params.sessionId, params.minConfidence];
  applySemanticRecallFilterClauses({
    whereClauses,
    args,
    filter: params.filter,
  });
  args.push(params.limit);
  const rows = db
    .prepare(
      `SELECT *
       FROM semantic_memories
       WHERE ${whereClauses.join('\n         AND ')}
       ORDER BY accessed_at DESC, confidence DESC
       LIMIT ?`,
    )
    .all(...args) as RawSemanticMemoryRow[];
  const mapped = rows.map(mapSemanticMemoryRow);
  touchSemanticMemoryRows(mapped);
  return mapped;
}

export function storeSemanticMemory(params: {
  sessionId: string;
  role: string;
  source?: string | null;
  scope?: string | null;
  metadata?: Record<string, unknown> | string | null;
  content: string;
  confidence?: number;
  embedding?: number[] | null;
  sourceMessageId?: number | null;
  createdAt?: string | null;
  accessedAt?: string | null;
  deleted?: boolean | number | null;
}): number {
  const normalizedContent = params.content.trim();
  const source = (params.source || '').trim() || 'conversation';
  const scope = (params.scope || '').trim() || 'episodic';
  const metadata =
    typeof params.metadata === 'string'
      ? parseSemanticMetadata(params.metadata)
      : params.metadata && typeof params.metadata === 'object'
        ? params.metadata
        : {};
  const metadataJson = serializeSemanticMetadata(metadata);
  const deleted = params.deleted === true || params.deleted === 1 ? 1 : 0;
  const rawConfidence =
    typeof params.confidence === 'number' && Number.isFinite(params.confidence)
      ? params.confidence
      : 1;
  const boundedConfidence = Math.max(0, Math.min(1, rawConfidence));
  const normalizedEmbedding = normalizeEmbeddingInput(params.embedding);
  const embeddingBlob = normalizedEmbedding
    ? embeddingToBlob(normalizedEmbedding)
    : null;
  const createdAt = params.createdAt?.trim() || null;
  const accessedAt = params.accessedAt?.trim() || createdAt || null;
  const result = db
    .prepare(
      `INSERT INTO semantic_memories
       (session_id, role, source, scope, metadata, content, confidence, embedding, source_message_id, created_at, accessed_at, access_count, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')), 0, ?)`,
    )
    .run(
      params.sessionId,
      params.role,
      source,
      scope,
      metadataJson,
      normalizedContent,
      boundedConfidence,
      embeddingBlob,
      params.sourceMessageId ?? null,
      createdAt,
      accessedAt,
      deleted,
    );
  return result.lastInsertRowid as number;
}

export function recallSemanticMemories(params: {
  sessionId: string;
  query: string;
  limit?: number;
  minConfidence?: number;
  queryEmbedding?: number[] | null;
  filter?: SemanticRecallFilter;
}): SemanticMemoryEntry[] {
  const normalizedQuery = params.query.trim().toLowerCase();
  const queryTerms = parseQueryTerms(normalizedQuery);
  const queryEmbedding = normalizeEmbeddingInput(params.queryEmbedding);

  const limit = Math.max(1, Math.min(Math.floor(params.limit || 5), 50));
  const rawMinConfidence =
    typeof params.minConfidence === 'number' &&
    Number.isFinite(params.minConfidence)
      ? params.minConfidence
      : 0.2;
  const minConfidence = Math.max(0, Math.min(1, rawMinConfidence));

  if (!queryEmbedding && queryTerms.length === 0) {
    return recallSemanticMemoriesByRecent({
      sessionId: params.sessionId,
      limit,
      minConfidence,
      filter: params.filter,
    });
  }

  if (queryEmbedding) {
    return recallSemanticMemoriesByVector({
      sessionId: params.sessionId,
      queryEmbedding,
      limit,
      minConfidence,
      filter: params.filter,
    });
  }

  return recallSemanticMemoriesByLike({
    sessionId: params.sessionId,
    normalizedQuery,
    queryTerms,
    limit,
    minConfidence,
    filter: params.filter,
  });
}

export function forgetSemanticMemory(id: number): boolean {
  const normalizedId = Math.floor(id);
  if (!Number.isFinite(normalizedId) || normalizedId <= 0) return false;
  const result = db
    .prepare(
      `UPDATE semantic_memories
       SET deleted = 1
       WHERE id = ?
         AND deleted = 0`,
    )
    .run(normalizedId);
  return result.changes > 0;
}

export function decaySemanticMemories(params?: {
  decayRate?: number;
  staleAfterDays?: number;
  minConfidence?: number;
}): number {
  const rawDecayRate =
    typeof params?.decayRate === 'number' && Number.isFinite(params.decayRate)
      ? params.decayRate
      : 0.1;
  const decayRate = Math.max(0, Math.min(0.95, rawDecayRate));
  const decayFactor = 1 - decayRate;
  const rawStaleAfterDays =
    typeof params?.staleAfterDays === 'number' &&
    Number.isFinite(params.staleAfterDays)
      ? params.staleAfterDays
      : 7;
  const staleAfterDays = Math.max(
    1,
    Math.min(365, Math.floor(rawStaleAfterDays)),
  );
  const rawMinConfidence =
    typeof params?.minConfidence === 'number' &&
    Number.isFinite(params.minConfidence)
      ? params.minConfidence
      : 0.1;
  const minConfidence = Math.max(0, Math.min(0.95, rawMinConfidence));
  const cutoff = `-${staleAfterDays} days`;
  const result = db
    .prepare(
      `UPDATE semantic_memories
       SET confidence = MAX(?, confidence * ?)
       WHERE deleted = 0
         AND confidence > ?
         AND accessed_at < datetime('now', ?)`,
    )
    .run(minConfidence, decayFactor, minConfidence, cutoff);
  return result.changes;
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
    .prepare(
      'SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?',
    )
    .get(sessionId, keep - 1) as { id: number } | undefined;
  if (!cutoffRow) return null;

  const older = db
    .prepare(
      'SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id ASC',
    )
    .all(sessionId, cutoffRow.id) as StoredMessage[];
  if (older.length === 0) return null;

  return {
    cutoffId: cutoffRow.id,
    olderMessages: older,
  };
}

export function deleteMessagesBeforeId(
  sessionId: string,
  cutoffId: number,
): number {
  const result = db
    .prepare('DELETE FROM messages WHERE session_id = ? AND id < ?')
    .run(sessionId, cutoffId);
  db.prepare(
    "UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?), last_active = datetime('now') WHERE id = ?",
  ).run(sessionId, sessionId);
  return result.changes;
}

export function updateSessionSummary(sessionId: string, summary: string): void {
  const normalized = summary.trim();
  db.prepare(
    "UPDATE sessions SET session_summary = ?, summary_updated_at = datetime('now'), compaction_count = compaction_count + 1 WHERE id = ?",
  ).run(normalized || null, sessionId);
}

export function markSessionMemoryFlush(sessionId: string): void {
  db.prepare(
    "UPDATE sessions SET memory_flush_at = datetime('now') WHERE id = ?",
  ).run(sessionId);
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
  const result = db
    .prepare(
      'INSERT INTO tasks (session_id, channel_id, cron_expr, prompt, run_at, every_ms) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      sessionId,
      channelId,
      cronExpr,
      prompt,
      runAt || null,
      everyMs || null,
    );
  return result.lastInsertRowid as number;
}

export function getTasksForSession(sessionId: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC',
    )
    .all(sessionId) as ScheduledTask[];
}

export function getAllEnabledTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM tasks WHERE enabled = 1')
    .all() as ScheduledTask[];
}

export function updateTaskLastRun(taskId: number): void {
  db.prepare(
    "UPDATE tasks SET last_run = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(taskId);
}

export function markTaskSuccess(taskId: number): void {
  db.prepare(
    'UPDATE tasks SET last_status = ?, consecutive_errors = 0 WHERE id = ?',
  ).run('success', taskId);
}

export function markTaskFailure(
  taskId: number,
  maxConsecutiveErrors = 5,
): { disabled: boolean; consecutiveErrors: number } {
  const row = db
    .prepare('SELECT consecutive_errors FROM tasks WHERE id = ?')
    .get(taskId) as { consecutive_errors?: number } | undefined;
  if (!row) {
    return { disabled: false, consecutiveErrors: 0 };
  }

  const nextCount = Math.max(0, Math.floor(row.consecutive_errors || 0)) + 1;
  const shouldDisable =
    nextCount >= Math.max(1, Math.floor(maxConsecutiveErrors));
  db.prepare(
    'UPDATE tasks SET last_status = ?, consecutive_errors = ?, enabled = ? WHERE id = ?',
  ).run('error', nextCount, shouldDisable ? 0 : 1, taskId);
  return {
    disabled: shouldDisable,
    consecutiveErrors: nextCount,
  };
}

export function toggleTask(taskId: number, enabled: boolean): void {
  db.prepare('UPDATE tasks SET enabled = ? WHERE id = ?').run(
    enabled ? 1 : 0,
    taskId,
  );
}

export function pauseTask(taskId: number): void {
  toggleTask(taskId, false);
}

export function resumeTask(taskId: number): void {
  toggleTask(taskId, true);
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
  ).run(
    sessionId || null,
    event,
    detail ? JSON.stringify(detail) : null,
    durationMs || null,
  );
}

export function getRecentAudit(limit = 20): AuditEntry[] {
  return db
    .prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?')
    .all(limit) as AuditEntry[];
}

function toPayloadObject(payload: AuditEventPayload): Record<string, unknown> {
  return payload as unknown as Record<string, unknown>;
}

function readPayloadStringValue(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function readPayloadBooleanValue(
  payload: Record<string, unknown>,
  key: string,
): boolean | null {
  const value = payload[key];
  return typeof value === 'boolean' ? value : null;
}

export function logStructuredAuditEvent(record: WireRecord): void {
  const eventType = record.event.type || 'unknown';
  const payloadText = JSON.stringify(record.event);

  db.prepare(
    `INSERT OR IGNORE INTO audit_events (
      session_id, seq, event_type, timestamp, run_id, parent_run_id, payload, wire_hash, wire_prev_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.sessionId,
    record.seq,
    eventType,
    record.timestamp,
    record.runId,
    record.parentRunId || null,
    payloadText,
    record._hash,
    record._prevHash,
  );

  if (eventType !== 'approval.response') return;

  const payload = toPayloadObject(record.event);
  const toolCallId =
    readPayloadStringValue(payload, 'toolCallId') || `seq:${record.seq}`;
  const action = readPayloadStringValue(payload, 'action') || 'unknown';
  const description = readPayloadStringValue(payload, 'description');
  const approved = readPayloadBooleanValue(payload, 'approved') ? 1 : 0;
  const approvedBy = readPayloadStringValue(payload, 'approvedBy');
  const method = readPayloadStringValue(payload, 'method') || 'policy';
  const policyName = readPayloadStringValue(payload, 'policyName');

  db.prepare(
    `INSERT INTO approvals (
      session_id, tool_call_id, action, description, approved, approved_by, method, policy_name, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.sessionId,
    toolCallId,
    action,
    description,
    approved,
    approvedBy,
    method,
    policyName,
    record.timestamp,
  );
}

export function getRecentStructuredAudit(limit = 20): StructuredAuditEntry[] {
  const bounded = Math.max(1, Math.min(limit, 200));
  return db
    .prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?')
    .all(bounded) as StructuredAuditEntry[];
}

export function getRecentStructuredAuditForSession(
  sessionId: string,
  limit = 20,
): StructuredAuditEntry[] {
  const bounded = Math.max(1, Math.min(limit, 200));
  return db
    .prepare(
      'SELECT * FROM audit_events WHERE session_id = ? ORDER BY seq DESC LIMIT ?',
    )
    .all(sessionId, bounded) as StructuredAuditEntry[];
}

export function getStructuredAuditAfterId(
  afterId: number,
  limit = 200,
): StructuredAuditEntry[] {
  const boundedAfterId = Math.max(0, Math.floor(afterId));
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 5_000));
  return db
    .prepare('SELECT * FROM audit_events WHERE id > ? ORDER BY id ASC LIMIT ?')
    .all(boundedAfterId, boundedLimit) as StructuredAuditEntry[];
}

export function searchStructuredAudit(
  query: string,
  limit = 20,
): StructuredAuditEntry[] {
  const normalized = query.trim();
  if (!normalized) return [];
  const bounded = Math.max(1, Math.min(limit, 200));
  const like = `%${normalized}%`;
  return db
    .prepare(`
      SELECT *
      FROM audit_events
      WHERE event_type LIKE ?
        OR payload LIKE ?
        OR session_id LIKE ?
        OR run_id LIKE ?
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(like, like, like, like, bounded) as StructuredAuditEntry[];
}

export function getRecentApprovals(
  limit = 20,
  deniedOnly = false,
): ApprovalAuditEntry[] {
  const bounded = Math.max(1, Math.min(limit, 200));
  if (deniedOnly) {
    return db
      .prepare(
        'SELECT * FROM approvals WHERE approved = 0 ORDER BY id DESC LIMIT ?',
      )
      .all(bounded) as ApprovalAuditEntry[];
  }
  return db
    .prepare('SELECT * FROM approvals ORDER BY id DESC LIMIT ?')
    .all(bounded) as ApprovalAuditEntry[];
}

export function getObservabilityOffset(streamKey: string): number {
  const normalized = streamKey.trim();
  if (!normalized) return 0;
  const row = db
    .prepare(
      'SELECT last_event_id FROM observability_offsets WHERE stream_key = ?',
    )
    .get(normalized) as { last_event_id: number } | undefined;
  return row ? Math.max(0, Math.floor(row.last_event_id)) : 0;
}

export function setObservabilityOffset(
  streamKey: string,
  lastEventId: number,
): void {
  const normalized = streamKey.trim();
  if (!normalized) return;
  const boundedLastEventId = Math.max(0, Math.floor(lastEventId));
  db.prepare(`
    INSERT INTO observability_offsets (stream_key, last_event_id, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(stream_key) DO UPDATE SET
      last_event_id = excluded.last_event_id,
      updated_at = excluded.updated_at
  `).run(normalized, boundedLastEventId);
}

export function getObservabilityIngestToken(tokenKey: string): string | null {
  const normalized = tokenKey.trim();
  if (!normalized) return null;
  const row = db
    .prepare(
      'SELECT token FROM observability_ingest_tokens WHERE token_key = ?',
    )
    .get(normalized) as { token: string } | undefined;
  if (!row || typeof row.token !== 'string') return null;
  const token = row.token.trim();
  return token || null;
}

export function setObservabilityIngestToken(
  tokenKey: string,
  token: string,
): void {
  const normalizedKey = tokenKey.trim();
  const normalizedToken = token.trim();
  if (!normalizedKey || !normalizedToken) return;
  db.prepare(`
    INSERT INTO observability_ingest_tokens (token_key, token, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(token_key) DO UPDATE SET
      token = excluded.token,
      updated_at = excluded.updated_at
  `).run(normalizedKey, normalizedToken);
}

export function deleteObservabilityIngestToken(tokenKey: string): void {
  const normalized = tokenKey.trim();
  if (!normalized) return;
  db.prepare('DELETE FROM observability_ingest_tokens WHERE token_key = ?').run(
    normalized,
  );
}

// --- Proactive Message Queue ---

export interface QueuedProactiveMessage {
  id: number;
  channel_id: string;
  text: string;
  source: string;
  queued_at: string;
}

export function enqueueProactiveMessage(
  channelId: string,
  text: string,
  source: string,
  maxQueueSize: number,
): { queued: number; dropped: number } {
  const boundedMax = Math.max(1, Math.floor(maxQueueSize));
  db.prepare(
    "INSERT INTO proactive_message_queue (channel_id, text, source, queued_at) VALUES (?, ?, ?, datetime('now'))",
  ).run(channelId, text, source);

  const countRow = db
    .prepare('SELECT COUNT(*) as count FROM proactive_message_queue')
    .get() as { count: number };
  const overLimit = Math.max(0, countRow.count - boundedMax);
  if (overLimit > 0) {
    db.prepare(`
      DELETE FROM proactive_message_queue
      WHERE id IN (
        SELECT id
        FROM proactive_message_queue
        ORDER BY id ASC
        LIMIT ?
      )
    `).run(overLimit);
  }

  return {
    queued: countRow.count - overLimit,
    dropped: overLimit,
  };
}

export function listQueuedProactiveMessages(
  limit = 100,
): QueuedProactiveMessage[] {
  const boundedLimit = Math.max(1, Math.floor(limit));
  return db
    .prepare('SELECT * FROM proactive_message_queue ORDER BY id ASC LIMIT ?')
    .all(boundedLimit) as QueuedProactiveMessage[];
}

export function claimQueuedProactiveMessages(
  channelId: string,
  limit = 20,
): QueuedProactiveMessage[] {
  const normalizedChannelId = channelId.trim();
  if (!normalizedChannelId) return [];
  const boundedLimit = Math.max(1, Math.floor(limit));

  const runClaim = db.transaction(
    (targetChannelId: string, maxRows: number): QueuedProactiveMessage[] => {
      const rows = db
        .prepare(
          'SELECT * FROM proactive_message_queue WHERE channel_id = ? ORDER BY id ASC LIMIT ?',
        )
        .all(targetChannelId, maxRows) as QueuedProactiveMessage[];
      if (rows.length === 0) return rows;

      const deleteRow = db.prepare(
        'DELETE FROM proactive_message_queue WHERE id = ?',
      );
      for (const row of rows) {
        deleteRow.run(row.id);
      }
      return rows;
    },
  );

  return runClaim(normalizedChannelId, boundedLimit);
}

export function deleteQueuedProactiveMessage(id: number): void {
  db.prepare('DELETE FROM proactive_message_queue WHERE id = ?').run(id);
}

export function getQueuedProactiveMessageCount(): number {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM proactive_message_queue')
    .get() as { count: number };
  return row.count;
}

// --- Sandbox Instances ---

export interface SandboxInstance {
  agentId: string;
  sandboxId: string;
  volumeId: string;
}

export function saveSandboxInstance(
  agentId: string,
  sandboxId: string,
  volumeId: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sandbox_instances (agent_id, sandbox_id, volume_id, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       sandbox_id = excluded.sandbox_id,
       volume_id = excluded.volume_id,
       last_used_at = excluded.last_used_at`,
  ).run(agentId, sandboxId, volumeId, now, now);
}

export function getSandboxInstance(agentId: string): SandboxInstance | null {
  const row = db
    .prepare('SELECT agent_id, sandbox_id, volume_id FROM sandbox_instances WHERE agent_id = ?')
    .get(agentId) as { agent_id: string; sandbox_id: string; volume_id: string } | undefined;
  if (!row) return null;
  return { agentId: row.agent_id, sandboxId: row.sandbox_id, volumeId: row.volume_id };
}

export function deleteSandboxInstance(agentId: string): void {
  db.prepare('DELETE FROM sandbox_instances WHERE agent_id = ?').run(agentId);
}

export function getAllSandboxInstances(): SandboxInstance[] {
  const rows = db
    .prepare('SELECT agent_id, sandbox_id, volume_id FROM sandbox_instances')
    .all() as { agent_id: string; sandbox_id: string; volume_id: string }[];
  return rows.map((row) => ({ agentId: row.agent_id, sandboxId: row.sandbox_id, volumeId: row.volume_id }));
}

export function touchSandboxInstance(agentId: string): void {
  db.prepare(
    `UPDATE sandbox_instances SET last_used_at = ? WHERE agent_id = ?`,
  ).run(new Date().toISOString(), agentId);
}
