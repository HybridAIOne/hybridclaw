import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  AgentConfig,
  AgentCv,
  AgentModelConfig,
} from '../agents/agent-types.js';
import { DEFAULT_AGENT_ID, normalizeAgentCv } from '../agents/agent-types.js';
import type { WireRecord } from '../audit/audit-trail.js';
import { DB_PATH } from '../config/config.js';
import {
  getRuntimeConfig,
  resolveDefaultAgentId,
} from '../config/runtime-config.js';
import { logger } from '../logger.js';
import {
  buildRecentChatSearchMatchQuery,
  MAX_RECENT_CHAT_SESSION_LIMIT,
  normalizeRecentChatSearchQuery,
  normalizeRecentChatSessionLimit,
} from '../session/recent-chat-search.js';
import {
  buildSessionKey,
  classifySessionKeyShape,
  inspectSessionKeyMigration,
  isLegacySessionKey,
  migrateLegacySessionKey,
  parseSessionKey,
} from '../session/session-key.js';
import {
  buildSessionBoundaryPreview,
  buildSessionSearchSnippet,
  RECENT_CHAT_SESSION_TITLE_MAX_LENGTH,
  shouldIncludeSessionSearchSnippet,
} from '../session/session-preview.js';
import {
  evaluateSessionExpiry,
  resolveSessionResetChannelKind,
  type SessionExpiryEvaluation,
  type SessionResetPolicy,
} from '../session/session-reset.js';
import { resolveSessionRoutingScope } from '../session/session-routing.js';
import type {
  CoworkerSkillScore,
  SkillAmendment,
  SkillAmendmentStatus,
  SkillErrorCategory,
  SkillExecutionOutcome,
  SkillFeedbackSentiment,
  SkillHealthMetrics,
  SkillObservation,
  SkillObservationSummary,
} from '../skills/adaptive-skills-types.js';
import type { SkillGuardVerdict } from '../skills/skills-guard.js';
import type {
  ApprovalAuditEntry,
  AuditEntry,
  StructuredAuditEntry,
} from '../types/audit.js';
import {
  type KnowledgeEntity,
  KnowledgeEntityType,
  type KnowledgeEntityTypeValue,
  type KnowledgeGraphMatch,
  type KnowledgeGraphPattern,
  KnowledgeRelationType,
  type KnowledgeRelationTypeValue,
} from '../types/knowledge.js';
import type {
  SemanticMemoryEntry,
  StructuredMemoryEntry,
} from '../types/memory.js';
import type { ScheduledTask } from '../types/scheduler.js';
import type {
  CanonicalSession,
  CanonicalSessionContext,
  CanonicalSessionMessage,
  ConversationBranchFamily,
  ConversationHistoryPage,
  ForkSessionBranchParams,
  ForkSessionBranchResult,
  Session,
  SessionShowMode,
  StoredMessage,
} from '../types/session.js';
import type {
  UsageAgentAggregate,
  UsageDailyAggregate,
  UsageModelAggregate,
  UsageSessionAggregate,
  UsageTotals,
  UsageWindow,
} from '../types/usage.js';
import { isApprovalHistoryMessage } from '../utils/approval-text.js';
import { normalizeTrimmedUniqueStringArray } from '../utils/normalized-strings.js';
import {
  buildMemoryFtsDocument,
  buildMemoryFtsMatchQuery,
  getMemoryFtsTokenizerSpec,
  type MemoryRecallBackend,
  type MemoryRecallRerank,
  type MemoryRecallTokenizer,
  normalizeMemoryRecallBackend,
  normalizeMemoryRecallRerank,
  normalizeMemoryRecallTokenizer,
  tokenizeMemoryRecallQuery,
} from './semantic-recall.js';

let db: Database.Database;
let databaseInitialized = false;

export const DATABASE_SCHEMA_VERSION = 22;
const STRUCTURED_AUDIT_SESSION_LIMIT = 10_000;
const RECENT_CHAT_MESSAGE_SEARCH_TABLE = 'recent_chat_message_search';
const RECENT_CHAT_MESSAGE_SEARCH_INSERT_TRIGGER =
  'messages_recent_chat_search_ai';
const RECENT_CHAT_MESSAGE_SEARCH_DELETE_TRIGGER =
  'messages_recent_chat_search_ad';
const RECENT_CHAT_MESSAGE_SEARCH_UPDATE_TRIGGER =
  'messages_recent_chat_search_au';
const STRUCTURED_AUDIT_SELECT_COLUMNS = [
  'id',
  'session_id',
  'seq',
  'event_type',
  'timestamp',
  'run_id',
  'parent_run_id',
  'payload',
  'wire_hash',
  'wire_prev_hash',
  'created_at',
].join(', ');

interface InitDatabaseOptions {
  quiet?: boolean;
  dbPath?: string;
}

interface TableInfoRow {
  name: string;
}

type AgentRow = {
  id: AgentConfig['id'];
  name: string | null;
  display_name: string | null;
  image_asset: string | null;
  model: string | null;
  skills: string | null;
  chatbot_id: string | null;
  enable_rag: number | null;
  workspace: string | null;
  owner: string | null;
  role: string | null;
  cv: string | null;
  created_at: string;
  updated_at: string;
};

interface ConversationHistoryPageRow {
  session_key: string | null;
  main_session_key: string | null;
  id: number | null;
  session_id: string | null;
  user_id: string | null;
  username: string | null;
  role: string | null;
  agent_id: string | null;
  content: string | null;
  created_at: string | null;
}

interface SessionBranchRow {
  session_id: string;
  parent_session_id: string;
  parent_message_id: number;
  copied_message_count: number;
}

type SkillObservationRow = Omit<
  SkillObservation,
  'outcome' | 'error_category' | 'feedback_sentiment'
> & {
  outcome: string;
  error_category: string | null;
  feedback_sentiment: string | null;
};

type SkillObservationSummaryRow = Omit<
  SkillObservationSummary,
  'error_clusters'
>;

type SkillObservationErrorClusterRow = {
  skill_name: SkillObservationSummary['skill_name'];
  error_category: SkillErrorCategory | null;
  count: number;
  sample_detail: string | null;
};

type SkillAmendmentRow = Omit<
  SkillAmendment,
  'guard_verdict' | 'metrics_at_proposal' | 'metrics_post_apply'
> & {
  guard_verdict: string;
  metrics_at_proposal: string | null;
  metrics_post_apply: string | null;
};

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

function queryOne<Row, Bind extends unknown[] = []>(
  database: Database.Database,
  sql: string,
  ...params: Bind
): Row | undefined;
function queryOne<Row>(
  database: Database.Database,
  sql: string,
  ...params: unknown[]
): Row | undefined;

function queryOne<Row>(
  database: Database.Database,
  sql: string,
  ...params: unknown[]
): Row | undefined {
  return database.prepare<unknown[], Row>(sql).get(...params);
}

function queryAll<Row, Bind extends unknown[] = []>(
  database: Database.Database,
  sql: string,
  ...params: Bind
): Row[];
function queryAll<Row>(
  database: Database.Database,
  sql: string,
  ...params: unknown[]
): Row[];

function queryAll<Row>(
  database: Database.Database,
  sql: string,
  ...params: unknown[]
): Row[] {
  return database.prepare<unknown[], Row>(sql).all(...params);
}

function tableExists(database: Database.Database, table: string): boolean {
  const row = queryOne<{ name: string }, [string]>(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    table,
  );
  return Boolean(row?.name);
}

function ensureSessionBranchesTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_branches (
      session_id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      parent_message_id INTEGER NOT NULL,
      copied_message_count INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_session_branches_parent
      ON session_branches(parent_session_id, parent_message_id);
  `);
}

function ensureRecentChatMessageSearchIndex(database: Database.Database): void {
  if (!tableExists(database, 'messages')) {
    return;
  }

  const needsBackfill = !tableExists(
    database,
    RECENT_CHAT_MESSAGE_SEARCH_TABLE,
  );

  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${RECENT_CHAT_MESSAGE_SEARCH_TABLE}
      USING fts5(
        session_id UNINDEXED,
        content,
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS ${RECENT_CHAT_MESSAGE_SEARCH_INSERT_TRIGGER}
      AFTER INSERT ON messages
      BEGIN
        INSERT INTO ${RECENT_CHAT_MESSAGE_SEARCH_TABLE} (
          rowid,
          session_id,
          content
        )
        VALUES (new.id, new.session_id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS ${RECENT_CHAT_MESSAGE_SEARCH_DELETE_TRIGGER}
      AFTER DELETE ON messages
      BEGIN
        DELETE FROM ${RECENT_CHAT_MESSAGE_SEARCH_TABLE}
        WHERE rowid = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS ${RECENT_CHAT_MESSAGE_SEARCH_UPDATE_TRIGGER}
      AFTER UPDATE ON messages
      BEGIN
        DELETE FROM ${RECENT_CHAT_MESSAGE_SEARCH_TABLE}
        WHERE rowid = old.id;
        INSERT INTO ${RECENT_CHAT_MESSAGE_SEARCH_TABLE} (
          rowid,
          session_id,
          content
        )
        VALUES (new.id, new.session_id, new.content);
      END;
    `);
  } catch (error) {
    throw new Error(
      `Recent chat content search requires SQLite FTS5 support: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!needsBackfill) {
    return;
  }

  database.exec(`
    INSERT INTO ${RECENT_CHAT_MESSAGE_SEARCH_TABLE} (rowid, session_id, content)
    SELECT id, session_id, content
    FROM messages;
  `);
}

function getTableSql(database: Database.Database, table: string): string {
  const row = queryOne<{ sql: string | null }, [string]>(
    database,
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    table,
  );
  return row?.sql || '';
}

function columnExists(
  database: Database.Database,
  table: string,
  column: string,
): boolean {
  const cols = queryAll<TableInfoRow>(database, `PRAGMA table_info(${table})`);
  return cols.some((entry) => entry.name === column);
}

function hasSessionLegacySessionIdColumn(database: Database.Database): boolean {
  return (
    tableExists(database, 'sessions') &&
    columnExists(database, 'sessions', 'legacy_session_id')
  );
}

function hasSessionKeyColumn(database: Database.Database): boolean {
  return (
    tableExists(database, 'sessions') &&
    columnExists(database, 'sessions', 'session_key')
  );
}

function hasSessionCurrentColumn(database: Database.Database): boolean {
  return (
    tableExists(database, 'sessions') &&
    columnExists(database, 'sessions', 'is_current')
  );
}

function hasSessionMainKeyColumn(database: Database.Database): boolean {
  return (
    tableExists(database, 'sessions') &&
    columnExists(database, 'sessions', 'main_session_key')
  );
}

function skillObservationsNeedConstraintMigration(
  database: Database.Database,
): boolean {
  if (!tableExists(database, 'skill_observations')) return false;
  const definition = getTableSql(database, 'skill_observations').toLowerCase();
  return (
    !definition.includes("outcome in ('success', 'failure', 'partial')") ||
    !definition.includes(
      "feedback_sentiment in ('positive', 'negative', 'neutral')",
    )
  );
}

function skillObservationsNeedCoworkerMigration(
  database: Database.Database,
): boolean {
  return (
    tableExists(database, 'skill_observations') &&
    !columnExists(database, 'skill_observations', 'coworker_id')
  );
}

function coworkerSkillScoresNeedMigration(
  database: Database.Database,
): boolean {
  return !tableExists(database, 'coworker_skill_scores');
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
      session_key TEXT,
      main_session_key TEXT,
      is_current INTEGER NOT NULL DEFAULT 1,
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
      full_auto_enabled INTEGER NOT NULL DEFAULT 0,
      full_auto_prompt TEXT,
      full_auto_started_at TEXT,
      show_mode TEXT NOT NULL DEFAULT 'all',
      created_at TEXT DEFAULT (datetime('now')),
      last_active TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      role TEXT NOT NULL,
      agent_id TEXT,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS session_branches (
      session_id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      parent_message_id INTEGER NOT NULL,
      copied_message_count INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_session_branches_parent
      ON session_branches(parent_session_id, parent_message_id);

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

function migrateV5(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'full_auto_enabled',
    ddl: 'full_auto_enabled INTEGER NOT NULL DEFAULT 0',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'full_auto_prompt',
    ddl: 'full_auto_prompt TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'full_auto_started_at',
    ddl: 'full_auto_started_at TEXT',
    quiet,
  });

  recordMigration(database, 5, 'Add per-session full-auto state columns');
}

const LEGACY_PROVIDER_AGENT_IDS = [
  'ollama',
  'vllm',
  'lmstudio',
  'llamacpp',
  'default',
  'anthropic',
  'openai-codex',
] as const;

function compareMigrationTimestamps(left: string, right: string): number {
  if (left === right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  return left.localeCompare(right);
}

function migrateLegacyKvStoreAgentIds(
  database: Database.Database,
  targetAgentId: string,
): void {
  if (
    !tableExists(database, 'kv_store') ||
    !columnExists(database, 'kv_store', 'agent_id')
  ) {
    return;
  }

  const sourceAgentIds = [targetAgentId, ...LEGACY_PROVIDER_AGENT_IDS];
  const placeholders = sourceAgentIds.map(() => '?').join(', ');
  const rows = queryAll<MemoryKvRow, string[]>(
    database,
    `SELECT agent_id, key, value, version, updated_at
     FROM kv_store
     WHERE agent_id IN (${placeholders})
     ORDER BY key ASC, updated_at DESC, version DESC, agent_id ASC`,
    ...sourceAgentIds,
  );

  if (rows.length === 0) return;

  const deleteStatement = database.prepare(
    `DELETE FROM kv_store
     WHERE agent_id = ?
       AND key = ?`,
  );
  const insertStatement = database.prepare(
    `INSERT INTO kv_store (agent_id, key, value, version, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  let index = 0;
  while (index < rows.length) {
    const key = rows[index]?.key || '';
    const group: MemoryKvRow[] = [];
    while (index < rows.length && rows[index]?.key === key) {
      const row = rows[index];
      if (row) group.push(row);
      index += 1;
    }
    if (!key || group.length === 0) continue;

    const [winner] = [...group].sort((left, right) => {
      const updatedAtCompare = compareMigrationTimestamps(
        right.updated_at,
        left.updated_at,
      );
      if (updatedAtCompare !== 0) return updatedAtCompare;
      if (right.version !== left.version) return right.version - left.version;
      if (left.agent_id === targetAgentId && right.agent_id !== targetAgentId) {
        return -1;
      }
      if (right.agent_id === targetAgentId && left.agent_id !== targetAgentId) {
        return 1;
      }
      return left.agent_id.localeCompare(right.agent_id);
    });
    if (!winner) continue;

    for (const row of group) {
      deleteStatement.run(row.agent_id, row.key);
    }
    insertStatement.run(
      targetAgentId,
      key,
      winner.value,
      Math.max(1, Math.floor(winner.version || 1)),
      winner.updated_at || new Date().toISOString(),
    );
  }
}

function mergeCanonicalSummaries(rows: CanonicalSessionRow[]): string | null {
  const chunks = rows
    .map((row) => row.compacted_summary?.trim() || '')
    .filter(Boolean);
  if (chunks.length === 0) return null;
  const merged = Array.from(new Set(chunks)).join('\n');
  if (merged.length <= CANONICAL_SUMMARY_MAX_CHARS) return merged;
  return merged.slice(Math.max(0, merged.length - CANONICAL_SUMMARY_MAX_CHARS));
}

function mergeCanonicalMessages(
  rows: CanonicalSessionRow[],
): CanonicalSessionMessage[] {
  return rows
    .flatMap((row) => parseCanonicalMessages(row.messages))
    .sort((left, right) => {
      const createdAtCompare = compareMigrationTimestamps(
        left.created_at || '',
        right.created_at || '',
      );
      if (createdAtCompare !== 0) return createdAtCompare;
      if (left.session_id !== right.session_id) {
        return left.session_id.localeCompare(right.session_id);
      }
      if (left.role !== right.role) return left.role.localeCompare(right.role);
      return left.content.localeCompare(right.content);
    });
}

function migrateLegacyCanonicalSessions(
  database: Database.Database,
  targetAgentId: string,
): void {
  if (
    !tableExists(database, 'canonical_sessions') ||
    !columnExists(database, 'canonical_sessions', 'agent_id')
  ) {
    return;
  }

  const sourceAgentIds = [targetAgentId, ...LEGACY_PROVIDER_AGENT_IDS];
  const placeholders = sourceAgentIds.map(() => '?').join(', ');
  const rows = queryAll<CanonicalSessionRow, string[]>(
    database,
    `SELECT canonical_id, agent_id, user_id, messages, compaction_cursor, compacted_summary, message_count, created_at, updated_at
     FROM canonical_sessions
     WHERE agent_id IN (${placeholders})
     ORDER BY user_id ASC, created_at ASC, updated_at ASC, canonical_id ASC`,
    ...sourceAgentIds,
  );

  if (rows.length === 0) return;

  const deleteStatement = database.prepare(
    `DELETE FROM canonical_sessions
     WHERE canonical_id = ?`,
  );
  const insertStatement = database.prepare(
    `INSERT INTO canonical_sessions (
       canonical_id,
       agent_id,
       user_id,
       messages,
       compaction_cursor,
       compacted_summary,
       message_count,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let index = 0;
  while (index < rows.length) {
    const userId = rows[index]?.user_id || '';
    const group: CanonicalSessionRow[] = [];
    while (index < rows.length && rows[index]?.user_id === userId) {
      const row = rows[index];
      if (row) group.push(row);
      index += 1;
    }
    if (!userId || group.length === 0) continue;

    const orderedGroup = [...group].sort((left, right) => {
      const createdAtCompare = compareMigrationTimestamps(
        left.created_at,
        right.created_at,
      );
      if (createdAtCompare !== 0) return createdAtCompare;
      const updatedAtCompare = compareMigrationTimestamps(
        left.updated_at,
        right.updated_at,
      );
      if (updatedAtCompare !== 0) return updatedAtCompare;
      return left.canonical_id.localeCompare(right.canonical_id);
    });
    const mergedMessages = mergeCanonicalMessages(orderedGroup);
    const earliestCreatedAt =
      orderedGroup[0]?.created_at || new Date().toISOString();
    const latestUpdatedAt =
      [...orderedGroup].sort((left, right) =>
        compareMigrationTimestamps(right.updated_at, left.updated_at),
      )[0]?.updated_at || earliestCreatedAt;

    for (const row of group) {
      deleteStatement.run(row.canonical_id);
    }

    insertStatement.run(
      canonicalSessionId(targetAgentId, userId),
      targetAgentId,
      userId,
      serializeCanonicalMessages(mergedMessages),
      0,
      mergeCanonicalSummaries(orderedGroup),
      Math.max(
        mergedMessages.length,
        orderedGroup.reduce(
          (sum, row) => sum + Math.max(0, Math.floor(row.message_count || 0)),
          0,
        ),
      ),
      earliestCreatedAt,
      latestUpdatedAt,
    );
  }
}

function migrateV6(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT,
        display_name TEXT,
        image_asset TEXT,
        model TEXT,
        skills TEXT,
        chatbot_id TEXT,
        enable_rag INTEGER DEFAULT 1,
        workspace TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    database
      .prepare(`INSERT OR IGNORE INTO agents (id, name) VALUES (?, ?)`)
      .run(DEFAULT_AGENT_ID, 'Main Agent');

    addColumnIfMissing({
      database,
      table: 'sessions',
      column: 'agent_id',
      ddl: `agent_id TEXT DEFAULT '${DEFAULT_AGENT_ID}'`,
      quiet,
    });
    database.exec(
      'CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id)',
    );
    if (columnExists(database, 'sessions', 'agent_id')) {
      database
        .prepare(
          `UPDATE sessions
           SET agent_id = ?
           WHERE agent_id IS NULL OR TRIM(agent_id) = ''`,
        )
        .run(DEFAULT_AGENT_ID);
    }

    migrateLegacyKvStoreAgentIds(database, DEFAULT_AGENT_ID);
    migrateLegacyCanonicalSessions(database, DEFAULT_AGENT_ID);

    if (
      tableExists(database, 'usage_events') &&
      columnExists(database, 'usage_events', 'agent_id')
    ) {
      const placeholders = LEGACY_PROVIDER_AGENT_IDS.map(() => '?').join(', ');
      database
        .prepare(
          `UPDATE usage_events
           SET agent_id = ?
           WHERE agent_id IN (${placeholders})`,
        )
        .run(DEFAULT_AGENT_ID, ...LEGACY_PROVIDER_AGENT_IDS);
    }

    recordMigration(
      database,
      6,
      'Add agents registry table and bind sessions to logical agent ids',
    );
  })();
}

function migrateV7(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'show_mode',
    ddl: "show_mode TEXT NOT NULL DEFAULT 'all'",
    quiet,
  });
  if (columnExists(database, 'sessions', 'show_mode')) {
    database
      .prepare(
        `UPDATE sessions
         SET show_mode = 'all'
         WHERE show_mode IS NULL
            OR TRIM(show_mode) = ''
            OR LOWER(TRIM(show_mode)) NOT IN ('all', 'thinking', 'tools', 'none')`,
      )
      .run();
  }
  recordMigration(database, 7, 'Add per-session show mode column');
}

function migrateV8(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'reset_count',
    ddl: 'reset_count INTEGER NOT NULL DEFAULT 0',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'reset_at',
    ddl: 'reset_at TEXT',
    quiet,
  });
  recordMigration(
    database,
    8,
    'Track automatic session resets and reset timestamps',
  );
}

function migrateV9(
  database: Database.Database,
  _opts?: InitDatabaseOptions,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS skill_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      error_category TEXT,
      error_detail TEXT,
      tool_calls_attempted INTEGER NOT NULL DEFAULT 0,
      tool_calls_failed INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      user_feedback TEXT,
      feedback_sentiment TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_skill_observations_skill_created
      ON skill_observations(skill_name, created_at);
    CREATE INDEX IF NOT EXISTS idx_skill_observations_session
      ON skill_observations(session_id);

    CREATE TABLE IF NOT EXISTS skill_amendments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL,
      skill_file_path TEXT NOT NULL,
      version INTEGER NOT NULL,
      previous_version INTEGER,
      status TEXT NOT NULL,
      original_content TEXT NOT NULL,
      proposed_content TEXT NOT NULL,
      original_content_hash TEXT NOT NULL,
      proposed_content_hash TEXT NOT NULL,
      rationale TEXT NOT NULL,
      diff_summary TEXT NOT NULL,
      proposed_by TEXT NOT NULL,
      reviewed_by TEXT,
      guard_verdict TEXT NOT NULL,
      guard_findings_count INTEGER NOT NULL DEFAULT 0,
      metrics_at_proposal TEXT,
      metrics_post_apply TEXT,
      runs_since_apply INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      applied_at TEXT,
      rolled_back_at TEXT,
      rejected_at TEXT,
      UNIQUE(skill_name, version)
    );
    CREATE INDEX IF NOT EXISTS idx_skill_amendments_skill_version
      ON skill_amendments(skill_name, version);
    CREATE INDEX IF NOT EXISTS idx_skill_amendments_status
      ON skill_amendments(status);
  `);

  recordMigration(
    database,
    9,
    'Add skill observation and amendment tracking tables',
  );
}

function migrateV10(
  database: Database.Database,
  _opts?: InitDatabaseOptions,
): void {
  const backupTable = 'skill_observations_v10_backup';
  if (!tableExists(database, backupTable)) {
    if (!tableExists(database, 'skill_observations')) {
      recordMigration(
        database,
        10,
        'Add skill observation constraints for outcome and feedback sentiment',
      );
      return;
    }
    database.exec(`
      DROP INDEX IF EXISTS idx_skill_observations_skill_created;
      DROP INDEX IF EXISTS idx_skill_observations_session;
      ALTER TABLE skill_observations RENAME TO ${backupTable};
    `);
  }

  database.exec(`
    DROP TABLE IF EXISTS skill_observations;

    CREATE TABLE skill_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'partial')),
      error_category TEXT,
      error_detail TEXT,
      tool_calls_attempted INTEGER NOT NULL DEFAULT 0,
      tool_calls_failed INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      user_feedback TEXT,
      feedback_sentiment TEXT CHECK (
        feedback_sentiment IS NULL OR
        feedback_sentiment IN ('positive', 'negative', 'neutral')
      ),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    INSERT INTO skill_observations (
      id,
      skill_name,
      session_id,
      run_id,
      outcome,
      error_category,
      error_detail,
      tool_calls_attempted,
      tool_calls_failed,
      duration_ms,
      user_feedback,
      feedback_sentiment,
      created_at
    )
    SELECT
      id,
      skill_name,
      session_id,
      run_id,
      CASE
        WHEN outcome IN ('success', 'failure', 'partial') THEN outcome
        ELSE 'failure'
      END AS outcome,
      error_category,
      error_detail,
      tool_calls_attempted,
      tool_calls_failed,
      duration_ms,
      user_feedback,
      CASE
        WHEN feedback_sentiment IN ('positive', 'negative', 'neutral')
          THEN feedback_sentiment
        ELSE NULL
      END AS feedback_sentiment,
      created_at
    FROM ${backupTable};

    DROP TABLE ${backupTable};

    CREATE INDEX idx_skill_observations_skill_created
      ON skill_observations(skill_name, created_at);
    CREATE INDEX idx_skill_observations_session
      ON skill_observations(session_id);
  `);

  recordMigration(
    database,
    10,
    'Add skill observation constraints for outcome and feedback sentiment',
  );
}

function migrateV11(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'legacy_session_id',
    ddl: 'legacy_session_id TEXT',
    quiet,
  });
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_legacy_session_id
      ON sessions(legacy_session_id)
      WHERE legacy_session_id IS NOT NULL;
  `);

  type LegacySessionRow = Pick<
    Session,
    'agent_id' | 'channel_id' | 'guild_id' | 'id'
  >;
  const relatedTables = [
    'messages',
    'semantic_memories',
    'tasks',
    'audit_log',
    'audit_events',
    'approvals',
    'usage_events',
    'skill_observations',
  ] as const;
  const rows = database
    .prepare<[], LegacySessionRow>(
      'SELECT id, guild_id, channel_id, agent_id FROM sessions',
    )
    .all();

  const migrateSessionIds = database.transaction(
    (sessions: LegacySessionRow[]) => {
      const conflicts: Array<{
        legacySessionId: string;
        nextId: string;
      }> = [];

      for (const session of sessions) {
        if (!isLegacySessionKey(session.id)) continue;
        const migration = inspectSessionKeyMigration(session.id, session);
        if (!migration.migrated) {
          throw new Error(
            `Legacy session id migration could not rewrite recognized legacy key: ${session.id}`,
          );
        }
        const nextId = migration.key;
        const conflictingRow = queryOne<{ id: string }, [string]>(
          database,
          'SELECT id FROM sessions WHERE id = ?',
          nextId,
        );
        if (conflictingRow && conflictingRow.id !== session.id) {
          conflicts.push({
            legacySessionId: session.id,
            nextId,
          });
          continue;
        }
        for (const table of relatedTables) {
          if (!tableExists(database, table)) continue;
          database
            .prepare(`UPDATE ${table} SET session_id = ? WHERE session_id = ?`)
            .run(nextId, session.id);
        }
        database
          .prepare(
            `UPDATE sessions
           SET id = ?,
               legacy_session_id = COALESCE(legacy_session_id, ?)
           WHERE id = ?`,
          )
          .run(nextId, session.id, session.id);
      }

      if (conflicts.length > 0) {
        const details = conflicts
          .map((entry) => `${entry.legacySessionId} -> ${entry.nextId}`)
          .join(', ');
        // Abort instead of recording a partial success while legacy ids remain.
        throw new Error(
          `Unable to migrate legacy session ids due to conflicting target rows: ${details}`,
        );
      }
    },
  );
  migrateSessionIds(rows);

  recordMigration(
    database,
    11,
    'Migrate legacy session ids to hierarchical agent-bound keys',
  );
}

function migrateV12(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'session_key',
    ddl: 'session_key TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'is_current',
    ddl: 'is_current INTEGER NOT NULL DEFAULT 1',
    quiet,
  });

  if (hasSessionKeyColumn(database)) {
    database.exec(`
      UPDATE sessions
      SET session_key = id
      WHERE session_key IS NULL
         OR TRIM(session_key) = '';
    `);
  }
  if (hasSessionCurrentColumn(database)) {
    database.exec(`
      UPDATE sessions
      SET is_current = 1
      WHERE is_current IS NULL;
    `);
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_key ON sessions(session_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_current_key
      ON sessions(session_key)
      WHERE is_current = 1;
  `);

  recordMigration(
    database,
    12,
    'Split stable session keys from rotating session instance ids',
  );
}

function migrateV13(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'main_session_key',
    ddl: 'main_session_key TEXT',
    quiet,
  });

  if (hasSessionMainKeyColumn(database)) {
    database.exec(`
      UPDATE sessions
      SET main_session_key = COALESCE(
        NULLIF(TRIM(main_session_key), ''),
        NULLIF(TRIM(session_key), ''),
        id
      )
      WHERE main_session_key IS NULL
         OR TRIM(main_session_key) = '';
    `);
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_main_key
        ON sessions(main_session_key);
    `);
  }

  recordMigration(
    database,
    13,
    'Add continuity-scoped main session keys for DM routing and linked identities',
  );
}

function migrateV14(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      model TEXT,
      chatbot_id TEXT,
      messages_json TEXT,
      status TEXT,
      response TEXT,
      error TEXT,
      tool_executions_json TEXT,
      tools_used TEXT,
      duration_ms INTEGER,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_request_log_session_created
      ON request_log(session_id, created_at DESC);
  `);

  recordMigration(database, 14, 'Add opt-in gateway request logging table');
}

function requestLogCreatedAtNeedsDefaultRemoval(
  database: Database.Database,
): boolean {
  if (!tableExists(database, 'request_log')) return false;
  const definition = getTableSql(database, 'request_log').toLowerCase();
  return definition.includes("created_at text default (datetime('now'))");
}

function migrateV15(database: Database.Database): void {
  const backupTable = 'request_log_v15_backup';
  if (!tableExists(database, backupTable)) {
    if (!requestLogCreatedAtNeedsDefaultRemoval(database)) {
      recordMigration(
        database,
        15,
        'Remove request_log created_at default in favor of application timestamps',
      );
      return;
    }
    database.exec(`
      DROP INDEX IF EXISTS idx_request_log_session_created;
      ALTER TABLE request_log RENAME TO ${backupTable};
    `);
  }

  database.exec(`
    DROP TABLE IF EXISTS request_log;

    CREATE TABLE request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      model TEXT,
      chatbot_id TEXT,
      messages_json TEXT,
      status TEXT,
      response TEXT,
      error TEXT,
      tool_executions_json TEXT,
      tools_used TEXT,
      duration_ms INTEGER,
      created_at TEXT
    );

    INSERT INTO request_log (
      id,
      session_id,
      model,
      chatbot_id,
      messages_json,
      status,
      response,
      error,
      tool_executions_json,
      tools_used,
      duration_ms,
      created_at
    )
    SELECT
      id,
      session_id,
      model,
      chatbot_id,
      messages_json,
      status,
      response,
      error,
      tool_executions_json,
      tools_used,
      duration_ms,
      created_at
    FROM ${backupTable};

    DROP TABLE ${backupTable};

    CREATE INDEX idx_request_log_session_created
      ON request_log(session_id, created_at DESC);
  `);

  recordMigration(
    database,
    15,
    'Remove request_log created_at default in favor of application timestamps',
  );
}

function migrateV16(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_branches (
      session_id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      parent_message_id INTEGER NOT NULL,
      copied_message_count INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_session_branches_parent
      ON session_branches(parent_session_id, parent_message_id);
  `);

  recordMigration(
    database,
    16,
    'Persist web chat branch ancestry for reload-safe branch navigation',
  );
}

function migrateV17(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'display_name',
    ddl: 'display_name TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'image_asset',
    ddl: 'image_asset TEXT',
    quiet,
  });

  recordMigration(
    database,
    17,
    'Persist installed agent display metadata for chat presentation',
  );
}

function migrateV18(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'skills',
    ddl: 'skills TEXT',
    quiet,
  });

  recordMigration(database, 18, 'Persist per-agent skill allowlists');
}

function migrateV19(database: Database.Database): void {
  ensureRecentChatMessageSearchIndex(database);
  recordMigration(
    database,
    19,
    'Index recent chat content search with SQLite FTS5',
  );
}

function migrateV20(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  addColumnIfMissing({
    database,
    table: 'messages',
    column: 'agent_id',
    ddl: 'agent_id TEXT',
    quiet: opts?.quiet === true,
  });
  recordMigration(database, 20, 'Persist assistant message agent identity');
}

function migrateV21(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'owner',
    ddl: 'owner TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'role',
    ddl: 'role TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'cv',
    ddl: 'cv TEXT',
    quiet,
  });
  recordMigration(
    database,
    21,
    'Persist agent owner, role, and CV profile for stable coworker identity',
  );
}

function migrateV22(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'skill_observations',
    column: 'coworker_id',
    ddl: 'coworker_id TEXT',
    quiet,
  });
  database.exec(`
    CREATE TABLE IF NOT EXISTS coworker_skill_scores (
      coworker_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      partial_count INTEGER NOT NULL DEFAULT 0,
      avg_duration_ms REAL NOT NULL DEFAULT 0,
      last_run_at TEXT,
      quality_score REAL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (coworker_id, skill_id)
    );
    CREATE INDEX IF NOT EXISTS idx_coworker_skill_scores_skill_quality
      ON coworker_skill_scores(skill_id, quality_score DESC, last_run_at DESC);
  `);

  if (!tableExists(database, 'skill_observations')) {
    recordMigration(
      database,
      22,
      'Persist coworker identity and per-skill score aggregates',
    );
    return;
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_skill_observations_coworker_skill_created
      ON skill_observations(coworker_id, skill_name, created_at);
  `);
  database.exec(`
    INSERT INTO coworker_skill_scores (
      coworker_id,
      skill_id,
      success_count,
      failure_count,
      partial_count,
      avg_duration_ms,
      last_run_at,
      quality_score,
      updated_at
    )
    SELECT
      coworker_id,
      skill_name,
      SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END),
      SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END),
      SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END),
      COALESCE(AVG(duration_ms), 0),
      MAX(created_at),
      NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM skill_observations
    WHERE coworker_id IS NOT NULL AND TRIM(coworker_id) != ''
    GROUP BY coworker_id, skill_name
    ON CONFLICT(coworker_id, skill_id) DO UPDATE SET
      success_count = excluded.success_count,
      failure_count = excluded.failure_count,
      partial_count = excluded.partial_count,
      avg_duration_ms = excluded.avg_duration_ms,
      last_run_at = excluded.last_run_at,
      updated_at = excluded.updated_at;
  `);
  recordMigration(
    database,
    22,
    'Persist coworker identity and per-skill score aggregates',
  );
}

function runMigrations(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const currentVersion = getSchemaVersion(database);
  const quiet = opts?.quiet === true;
  if (currentVersion > DATABASE_SCHEMA_VERSION) {
    if (!quiet) {
      logger.warn(
        { currentVersion, supportedVersion: DATABASE_SCHEMA_VERSION },
        'Database schema version is newer than this binary supports; skipping migrations',
      );
    }
    return;
  }

  if (currentVersion < 1) migrateV1(database);
  if (currentVersion < 2) migrateV2(database, opts);
  if (currentVersion < 3) migrateV3(database);
  if (currentVersion < 4) migrateV4(database);
  if (currentVersion < 5) migrateV5(database, opts);
  if (currentVersion < 6) migrateV6(database, opts);
  if (currentVersion < 7) migrateV7(database, opts);
  if (currentVersion < 8) migrateV8(database, opts);
  if (currentVersion < 9) migrateV9(database, opts);
  if (
    currentVersion < 10 ||
    skillObservationsNeedConstraintMigration(database)
  ) {
    migrateV10(database, opts);
  }
  if (currentVersion < 11) migrateV11(database, opts);
  if (currentVersion < 12) migrateV12(database, opts);
  if (currentVersion < 13) migrateV13(database, opts);
  if (currentVersion < 14) migrateV14(database);
  if (currentVersion < 15) migrateV15(database);
  if (currentVersion < 16) migrateV16(database);
  if (currentVersion < 17) migrateV17(database, opts);
  if (currentVersion < 18) migrateV18(database, opts);
  if (currentVersion < 19) migrateV19(database);
  if (currentVersion < 20) migrateV20(database, opts);
  if (currentVersion < 21) migrateV21(database, opts);
  if (
    currentVersion < 22 ||
    skillObservationsNeedCoworkerMigration(database) ||
    coworkerSkillScoresNeedMigration(database)
  ) {
    migrateV22(database, opts);
  }

  setSchemaVersion(database, DATABASE_SCHEMA_VERSION);
  if (!quiet && currentVersion < DATABASE_SCHEMA_VERSION) {
    logger.info(
      { fromVersion: currentVersion, toVersion: DATABASE_SCHEMA_VERSION },
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
  databaseInitialized = true;
  if (!quiet) logger.info({ path: dbPath }, 'Database initialized');
}

export function isDatabaseInitialized(): boolean {
  return databaseInitialized;
}

function ensureDatabaseReady(): void {
  if (databaseInitialized) return;
  initDatabase({ quiet: true });
}

function serializeAgentModelConfig(
  model: AgentModelConfig | undefined,
): string | null {
  if (!model) return null;
  if (typeof model === 'string') {
    const normalized = model.trim();
    return normalized || null;
  }
  const primary = model.primary.trim();
  if (!primary) return null;
  const fallbacks = Array.isArray(model.fallbacks)
    ? Array.from(
        new Set(
          model.fallbacks
            .map((fallback) => fallback.trim())
            .filter((fallback) => fallback && fallback !== primary),
        ),
      )
    : [];
  return JSON.stringify(
    fallbacks.length > 0 ? { primary, fallbacks } : { primary },
  );
}

function parseAgentModelConfig(
  rawModel: string | null,
): AgentModelConfig | undefined {
  const normalized = rawModel?.trim() || '';
  if (!normalized) return undefined;

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (typeof parsed === 'string') {
      const value = parsed.trim();
      return value || undefined;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const primary =
        typeof (parsed as { primary?: unknown }).primary === 'string'
          ? (parsed as { primary: string }).primary.trim()
          : '';
      if (!primary) return undefined;
      const fallbacks = Array.isArray(
        (parsed as { fallbacks?: unknown }).fallbacks,
      )
        ? Array.from(
            new Set(
              ((parsed as { fallbacks?: unknown[] }).fallbacks ?? [])
                .filter((entry): entry is string => typeof entry === 'string')
                .map((entry) => entry.trim())
                .filter((entry) => entry && entry !== primary),
            ),
          )
        : [];
      return fallbacks.length > 0 ? { primary, fallbacks } : { primary };
    }
  } catch {
    // Keep supporting legacy plain-string rows stored before JSON objects.
  }

  return normalized;
}

function parseAgentSkillsConfig(
  rawSkills: string | null,
): string[] | undefined {
  const normalized = rawSkills?.trim() || '';
  if (!normalized) return undefined;

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!Array.isArray(parsed)) return undefined;

    return normalizeTrimmedUniqueStringArray(parsed);
  } catch {
    logger.warn(
      { rawSkills: normalized },
      'Failed to parse persisted agent skills configuration',
    );
    return undefined;
  }
}

function serializeAgentSkillsConfig(skills?: string[]): string | null {
  if (!Array.isArray(skills)) return null;
  return JSON.stringify(normalizeTrimmedUniqueStringArray(skills));
}

function serializeAgentCv(cv: AgentCv | undefined): string | null {
  return cv ? JSON.stringify(cv) : null;
}

function parseAgentCv(rawCv: string | null): AgentCv | undefined {
  const normalized = rawCv?.trim() || '';
  if (!normalized) return undefined;

  try {
    return normalizeAgentCv(JSON.parse(normalized));
  } catch {
    logger.warn(
      { cvLength: normalized.length },
      'Failed to parse persisted agent CV configuration',
    );
    return undefined;
  }
}

function mapAgentRow(row: AgentRow): AgentConfig {
  const name = row.name?.trim() || '';
  const displayName = row.display_name?.trim() || '';
  const imageAsset = row.image_asset?.trim() || '';
  const model = parseAgentModelConfig(row.model);
  const skills = parseAgentSkillsConfig(row.skills);
  const chatbotId = row.chatbot_id?.trim() || '';
  const workspace = row.workspace?.trim() || '';
  const owner = row.owner?.trim() || '';
  const role = row.role?.trim() || '';
  const cv = parseAgentCv(row.cv);
  return {
    id: row.id,
    ...(name ? { name } : {}),
    ...(displayName ? { displayName } : {}),
    ...(imageAsset ? { imageAsset } : {}),
    ...(model ? { model } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(chatbotId ? { chatbotId } : {}),
    ...(workspace ? { workspace } : {}),
    ...(typeof row.enable_rag === 'number'
      ? { enableRag: row.enable_rag !== 0 }
      : {}),
    ...(owner ? { owner } : {}),
    ...(role ? { role } : {}),
    ...(cv ? { cv } : {}),
  };
}

const AGENT_SELECT_COLUMNS =
  'id, name, display_name, image_asset, model, skills, chatbot_id, enable_rag, workspace, owner, role, cv, created_at, updated_at';

export function getAgentById(agentId: string): AgentConfig | null {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) return null;
  const row = queryOne<AgentRow, [string]>(
    db,
    `SELECT ${AGENT_SELECT_COLUMNS}
     FROM agents
     WHERE id = ?`,
    normalizedAgentId,
  );
  return row ? mapAgentRow(row) : null;
}

export function listAgents(): AgentConfig[] {
  const rows = queryAll<AgentRow, [string]>(
    db,
    `SELECT ${AGENT_SELECT_COLUMNS}
     FROM agents
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id ASC`,
    DEFAULT_AGENT_ID,
  );
  return rows.map(mapAgentRow);
}

export function upsertAgent(agent: AgentConfig): AgentConfig {
  const normalizedId = agent.id.trim();
  if (!normalizedId) {
    throw new Error('Agent id is required.');
  }
  const normalizedName = agent.name?.trim() || null;
  const normalizedDisplayName = agent.displayName?.trim() || null;
  const normalizedImageAsset = agent.imageAsset?.trim() || null;
  const normalizedModel = serializeAgentModelConfig(agent.model);
  const normalizedSkills = serializeAgentSkillsConfig(agent.skills);
  const normalizedChatbotId = agent.chatbotId?.trim() || null;
  const normalizedWorkspace = agent.workspace?.trim() || null;
  const normalizedOwner = agent.owner?.trim() || null;
  const normalizedRole = agent.role?.trim() || null;
  const normalizedCv = serializeAgentCv(agent.cv);
  const enableRag =
    typeof agent.enableRag === 'boolean' ? (agent.enableRag ? 1 : 0) : null;
  db.prepare(
    `INSERT INTO agents (
       id,
       name,
       display_name,
       image_asset,
       model,
       skills,
       chatbot_id,
       enable_rag,
       workspace,
       owner,
       role,
       cv,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       display_name = excluded.display_name,
       image_asset = excluded.image_asset,
       model = excluded.model,
       skills = excluded.skills,
       chatbot_id = excluded.chatbot_id,
       enable_rag = excluded.enable_rag,
       workspace = excluded.workspace,
       owner = excluded.owner,
       role = excluded.role,
       cv = excluded.cv,
       updated_at = datetime('now')`,
  ).run(
    normalizedId,
    normalizedName,
    normalizedDisplayName,
    normalizedImageAsset,
    normalizedModel,
    normalizedSkills,
    normalizedChatbotId,
    enableRag,
    normalizedWorkspace,
    normalizedOwner,
    normalizedRole,
    normalizedCv,
  );
  const storedAgent = getAgentById(normalizedId);
  if (!storedAgent) {
    throw new Error(`Failed to read persisted agent: ${normalizedId}`);
  }
  return storedAgent;
}

export function deleteAgent(agentId: string): boolean {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId || normalizedAgentId === DEFAULT_AGENT_ID) {
    return false;
  }
  return (
    db.prepare('DELETE FROM agents WHERE id = ?').run(normalizedAgentId)
      .changes > 0
  );
}

type MemoryKvRow = Omit<StructuredMemoryEntry, 'value'> & {
  value: Buffer | Uint8Array | string;
};

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
  const row = queryOne<
    { value: Buffer | Uint8Array | string },
    [string, string]
  >(
    db,
    `SELECT value
     FROM kv_store
     WHERE agent_id = ?
       AND key = ?`,
    sessionId,
    normalizedKey,
  );
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
    ? queryAll<MemoryKvRow, [string, string]>(
        db,
        `SELECT agent_id, key, value, version, updated_at
         FROM kv_store
         WHERE agent_id = ?
           AND key LIKE ?
         ORDER BY key ASC`,
        sessionId,
        `${normalizedPrefix}%`,
      )
    : queryAll<MemoryKvRow, [string]>(
        db,
        `SELECT agent_id, key, value, version, updated_at
         FROM kv_store
         WHERE agent_id = ?
         ORDER BY key ASC`,
        sessionId,
      );

  return rows.map((row) => ({
    agent_id: row.agent_id,
    key: row.key,
    value: parseMemoryKvValue(row.value),
    version: row.version,
    updated_at: row.updated_at,
  }));
}

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

type CanonicalSessionRow = Omit<CanonicalSession, 'messages'> & {
  messages: string;
};

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
  const row = queryOne<CanonicalSessionRow, [string, string]>(
    db,
    `SELECT canonical_id, agent_id, user_id, messages, compaction_cursor, compacted_summary, message_count, created_at, updated_at
     FROM canonical_sessions
     WHERE agent_id = ?
       AND user_id = ?
     LIMIT 1`,
    normalizedAgentId,
    normalizedUserId,
  );

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

export function clearCanonicalContext(params: {
  agentId: string;
  userId: string;
}): number {
  const agentId = params.agentId.trim();
  const userId = params.userId.trim();
  if (!agentId || !userId) return 0;
  return db
    .prepare(
      `DELETE FROM canonical_sessions
       WHERE agent_id = ?
         AND user_id = ?`,
    )
    .run(agentId, userId).changes;
}

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
  const sessionId = resolveSessionIdCompat(params.sessionId.trim());
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

function serializeRequestLogJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function recordRequestLog(params: {
  sessionId: string;
  model?: string | null;
  chatbotId?: string | null;
  messages?: unknown;
  status?: string | null;
  response?: string | null;
  error?: string | null;
  toolExecutions?: unknown;
  toolsUsed?: unknown;
  durationMs?: number | null;
}): void {
  const sessionId = resolveSessionIdCompat(params.sessionId.trim());
  if (!sessionId) return;
  const model = params.model?.trim() || null;
  const chatbotId = params.chatbotId?.trim() || null;
  const status = params.status?.trim() || null;
  const response = params.response ?? null;
  const error = params.error ?? null;
  const durationMs =
    typeof params.durationMs === 'number' && Number.isFinite(params.durationMs)
      ? Math.max(0, Math.trunc(params.durationMs))
      : null;
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO request_log (
       session_id,
       model,
       chatbot_id,
       messages_json,
       status,
       response,
       error,
       tool_executions_json,
       tools_used,
       duration_ms,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    model,
    chatbotId,
    serializeRequestLogJson(params.messages),
    status,
    response,
    error,
    serializeRequestLogJson(params.toolExecutions),
    serializeRequestLogJson(params.toolsUsed),
    durationMs,
    createdAt,
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

  const row = queryOne<UsageTotals>(
    db,
    `SELECT
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
         COUNT(*) AS call_count,
         COALESCE(SUM(tool_calls), 0) AS total_tool_calls
       FROM usage_events
       ${where}`,
    ...args,
  ) || {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_tokens: 0,
    total_cost_usd: 0,
    call_count: 0,
    total_tool_calls: 0,
  };

  return {
    total_input_tokens: normalizeUsageNumber(row.total_input_tokens),
    total_output_tokens: normalizeUsageNumber(row.total_output_tokens),
    total_tokens: normalizeUsageNumber(row.total_tokens),
    total_cost_usd: normalizeUsageCost(row.total_cost_usd),
    call_count: normalizeUsageNumber(row.call_count),
    total_tool_calls: normalizeUsageNumber(row.total_tool_calls),
  };
}

export function getSessionUsageTotals(sessionId: string): UsageTotals {
  return getSessionUsageTotalsSince(sessionId, null);
}

export interface RecentSessionUsageEvent {
  sessionId: string;
  agentId: string;
  model: string;
  totalTokens: number;
  timestamp: string;
}

export function getRecentSessionUsageEvents(
  sessionId: string,
  limit = 20,
): RecentSessionUsageEvent[] {
  ensureDatabaseReady();
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const boundedLimit =
    typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : 20;
  const rows = queryAll<
    {
      session_id: string;
      agent_id: string;
      model: string;
      total_tokens: number;
      timestamp: string;
    },
    [string, number]
  >(
    db,
    `SELECT session_id, agent_id, model, total_tokens, timestamp
     FROM usage_events
     WHERE session_id = ?
     ORDER BY timestamp DESC
     LIMIT ?`,
    resolvedSessionId,
    boundedLimit,
  );

  return rows.map((row) => ({
    sessionId: String(row.session_id || '').trim(),
    agentId: String(row.agent_id || '').trim(),
    model: String(row.model || '').trim(),
    totalTokens: normalizeUsageNumber(row.total_tokens),
    timestamp: String(row.timestamp || '').trim(),
  }));
}

export function getSessionUsageTotalsSince(
  sessionId: string,
  sinceTimestamp: string | null,
): UsageTotals {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const normalizedSince =
    typeof sinceTimestamp === 'string' && sinceTimestamp.trim()
      ? sinceTimestamp.trim()
      : null;
  const row = queryOne<UsageTotals, [string, string | null, string | null]>(
    db,
    `SELECT
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
         COUNT(*) AS call_count,
         COALESCE(SUM(tool_calls), 0) AS total_tool_calls
       FROM usage_events
       WHERE session_id = ?
         AND (? IS NULL OR timestamp >= ?)`,
    resolvedSessionId,
    normalizedSince,
    normalizedSince,
  ) || {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_tokens: 0,
    total_cost_usd: 0,
    call_count: 0,
    total_tool_calls: 0,
  };

  return {
    total_input_tokens: normalizeUsageNumber(row.total_input_tokens),
    total_output_tokens: normalizeUsageNumber(row.total_output_tokens),
    total_tokens: normalizeUsageNumber(row.total_tokens),
    total_cost_usd: normalizeUsageCost(row.total_cost_usd),
    call_count: normalizeUsageNumber(row.call_count),
    total_tool_calls: normalizeUsageNumber(row.total_tool_calls),
  };
}

export function getSessionToolCallBreakdown(
  sessionId: string,
  sinceTimestamp: string | null = null,
): Array<{ toolName: string; count: number }> {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const normalizedSince =
    typeof sinceTimestamp === 'string' && sinceTimestamp.trim()
      ? sinceTimestamp.trim()
      : null;
  const rows = queryAll<
    { payload: string },
    [string, string | null, string | null]
  >(
    db,
    `SELECT payload
     FROM audit_events
     WHERE session_id = ?
       AND event_type = 'tool.call'
       AND (? IS NULL OR timestamp >= ?)
     ORDER BY id ASC`,
    resolvedSessionId,
    normalizedSince,
    normalizedSince,
  );

  const counts = new Map<string, number>();
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as { toolName?: unknown };
      const toolName = String(payload.toolName || '').trim();
      if (!toolName) continue;
      counts.set(toolName, (counts.get(toolName) || 0) + 1);
    } catch {
      // Best effort only. Skip malformed audit payloads.
    }
  }

  return [...counts.entries()]
    .map(([toolName, count]) => ({ toolName, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.toolName.localeCompare(right.toolName),
    );
}

export interface ToolUsageSummary {
  toolName: string;
  callsSinceCutoff: number;
  lastUsedAt: string | null;
}

export function getToolUsageSummary(params?: {
  sinceTimestamp?: string | null;
}): ToolUsageSummary[] {
  ensureDatabaseReady();
  const normalizedSince =
    typeof params?.sinceTimestamp === 'string' && params.sinceTimestamp.trim()
      ? params.sinceTimestamp.trim()
      : null;
  return queryAll<
    {
      toolName: string;
      callsSinceCutoff: number;
      lastUsedAt: string | null;
    },
    [string | null, string | null]
  >(
    db,
    `SELECT toolName, callsSinceCutoff, lastUsedAt
     FROM (
       SELECT
         TRIM(CAST(JSON_EXTRACT(payload, '$.toolName') AS TEXT)) AS toolName,
         SUM(CASE WHEN ? IS NULL OR timestamp >= ? THEN 1 ELSE 0 END) AS callsSinceCutoff,
         MAX(timestamp) AS lastUsedAt
       FROM audit_events
       WHERE event_type = 'tool.call'
         AND json_valid(payload)
       GROUP BY TRIM(CAST(JSON_EXTRACT(payload, '$.toolName') AS TEXT))
     )
     WHERE toolName != ''
     ORDER BY toolName ASC`,
    normalizedSince,
    normalizedSince,
  );
}

function extractToolFilePath(argumentsValue: unknown): string | null {
  if (!argumentsValue || typeof argumentsValue !== 'object') return null;
  const pathValue = (argumentsValue as Record<string, unknown>).path;
  if (typeof pathValue !== 'string') return null;
  const normalized = pathValue.trim().replace(/\\/g, '/');
  return normalized || null;
}

export function getSessionFileChangeCounts(
  sessionId: string,
  sinceTimestamp: string | null = null,
): {
  readCount: number;
  modifiedCount: number;
  createdCount: number;
  deletedCount: number;
} {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const normalizedSince =
    typeof sinceTimestamp === 'string' && sinceTimestamp.trim()
      ? sinceTimestamp.trim()
      : null;
  const rows = queryAll<
    Pick<StructuredAuditEntry, 'event_type' | 'payload'>,
    [string, string | null, string | null]
  >(
    db,
    `SELECT event_type, payload
     FROM audit_events
     WHERE session_id = ?
       AND event_type IN ('tool.call', 'tool.result')
       AND (? IS NULL OR timestamp >= ?)
     ORDER BY id ASC`,
    resolvedSessionId,
    normalizedSince,
    normalizedSince,
  );

  const toolCalls = new Map<
    string,
    {
      toolName: string;
      path: string | null;
    }
  >();
  const readPaths = new Set<string>();
  const modifiedPaths = new Set<string>();
  const createdPaths = new Set<string>();
  const deletedPaths = new Set<string>();

  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as {
        toolCallId?: unknown;
        toolName?: unknown;
        arguments?: unknown;
        isError?: unknown;
        blocked?: unknown;
      };
      const toolCallId = String(payload.toolCallId || '').trim();
      if (!toolCallId) continue;

      if (row.event_type === 'tool.call') {
        const toolName = String(payload.toolName || '').trim();
        if (!toolName) continue;
        toolCalls.set(toolCallId, {
          toolName,
          path: extractToolFilePath(payload.arguments),
        });
        continue;
      }

      if (payload.isError === true || payload.blocked === true) continue;
      const toolCall = toolCalls.get(toolCallId);
      if (!toolCall?.path) continue;

      switch (toolCall.toolName) {
        case 'read':
          readPaths.add(toolCall.path);
          break;
        case 'edit':
          modifiedPaths.add(toolCall.path);
          break;
        case 'write':
          createdPaths.add(toolCall.path);
          break;
        case 'delete':
          deletedPaths.add(toolCall.path);
          break;
        default:
          break;
      }
    } catch {
      // Best effort only. Skip malformed audit payloads.
    }
  }

  return {
    readCount: readPaths.size,
    modifiedCount: modifiedPaths.size,
    createdCount: createdPaths.size,
    deletedCount: deletedPaths.size,
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
  const rows = queryAll<UsageModelAggregate>(
    db,
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
    ...args,
  );

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
  const rows = queryAll<UsageAgentAggregate>(
    db,
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
    ...args,
  );

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

export function listUsageBySession(params?: {
  window?: UsageWindow;
}): UsageSessionAggregate[] {
  const whereClauses: string[] = [];
  const args: unknown[] = [];
  applyUsageFilters({
    whereClauses,
    args,
    window: params?.window,
  });
  const where =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const rows = queryAll<UsageSessionAggregate>(
    db,
    `SELECT
       session_id,
       COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
       COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
       COALESCE(SUM(total_tokens), 0) AS total_tokens,
       COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
       COUNT(*) AS call_count,
       COALESCE(SUM(tool_calls), 0) AS total_tool_calls
     FROM usage_events
     ${where}
     GROUP BY session_id
     ORDER BY total_cost_usd DESC, total_tokens DESC, call_count DESC`,
    ...args,
  );

  return rows.map((row) => ({
    session_id: row.session_id,
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
  const rows = queryAll<UsageDailyAggregate>(
    db,
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
    ...args,
  );

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

type RawKnowledgeGraphRow = {
  s_id: KnowledgeEntity['id'];
  s_type: string;
  s_name: KnowledgeEntity['name'];
  s_properties: string;
  s_created_at: KnowledgeEntity['created_at'];
  s_updated_at: KnowledgeEntity['updated_at'];
  r_id: string;
  r_source: KnowledgeEntity['id'];
  r_type: string;
  r_target: KnowledgeEntity['id'];
  r_properties: string;
  r_confidence: number;
  r_created_at: string;
  t_id: KnowledgeEntity['id'];
  t_type: string;
  t_name: KnowledgeEntity['name'];
  t_properties: string;
  t_created_at: KnowledgeEntity['created_at'];
  t_updated_at: KnowledgeEntity['updated_at'];
};

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

  const rows = queryAll<RawKnowledgeGraphRow>(db, sql.join('\n'), ...args);
  return rows.map(mapKnowledgeMatchRow);
}

export function resetSessionIfExpired(
  sessionId: string,
  opts: {
    policy: SessionResetPolicy;
    expiryEvaluation?: SessionExpiryEvaluation;
  },
): Session | null {
  const existing = getSessionById(sessionId);
  if (!existing) return null;

  let expiryEvaluation: SessionExpiryEvaluation;
  if (opts?.expiryEvaluation?.lastActive === existing.last_active) {
    expiryEvaluation = opts.expiryEvaluation;
  } else {
    try {
      const expiryStatus = evaluateSessionExpiry(
        opts.policy,
        existing.last_active,
      );
      expiryEvaluation = {
        lastActive: existing.last_active,
        isExpired: expiryStatus.isExpired,
        reason: expiryStatus.reason,
      };
    } catch (err) {
      logger.warn(
        {
          sessionId,
          lastActive: existing.last_active,
          err,
        },
        'Skipping session auto-reset due to invalid last_active timestamp',
      );
      expiryEvaluation = {
        lastActive: existing.last_active,
        isExpired: false,
        reason: null,
      };
    }
  }
  if (!expiryEvaluation.isExpired) return null;

  const rotated = createFreshSessionInstance(existing.id);
  logger.info(
    {
      previousSessionId: existing.id,
      sessionId: rotated.session.id,
      sessionKey: rotated.session.session_key,
      resetCount: rotated.session.reset_count,
      reason: expiryEvaluation.reason,
    },
    'Session auto-reset',
  );
  return rotated.session;
}

function requireSessionById(sessionId: string): Session {
  const session = selectSessionById(sessionId) || getSessionById(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} disappeared during database update`);
  }
  return session;
}

function padSessionTimestampPart(value: number): string {
  return String(Math.max(0, Math.trunc(value))).padStart(2, '0');
}

function generateSessionInstanceId(now: Date = new Date()): string {
  const timestamp = [
    String(now.getUTCFullYear()).padStart(4, '0'),
    padSessionTimestampPart(now.getUTCMonth() + 1),
    padSessionTimestampPart(now.getUTCDate()),
  ].join('');
  const time = [
    padSessionTimestampPart(now.getUTCHours()),
    padSessionTimestampPart(now.getUTCMinutes()),
    padSessionTimestampPart(now.getUTCSeconds()),
  ].join('');
  return `sess_${timestamp}_${time}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function selectSessionById(sessionId: string): Session | undefined {
  return queryOne<Session, [string]>(
    db,
    'SELECT * FROM sessions WHERE id = ?',
    sessionId,
  );
}

function selectCurrentSessionBySessionKey(
  sessionKey: string,
): Session | undefined {
  if (!hasSessionKeyColumn(db) || !hasSessionCurrentColumn(db))
    return undefined;
  return queryOne<Session, [string]>(
    db,
    `SELECT *
     FROM sessions
     WHERE session_key = ?
       AND is_current = 1
     LIMIT 1`,
    sessionKey,
  );
}

function selectCurrentSessionByMainSessionKey(
  mainSessionKey: string,
): Session | undefined {
  if (!hasSessionMainKeyColumn(db) || !hasSessionCurrentColumn(db)) {
    return undefined;
  }
  return queryOne<Session, [string]>(
    db,
    `SELECT *
     FROM sessions
     WHERE main_session_key = ?
       AND is_current = 1
     LIMIT 1`,
    mainSessionKey,
  );
}

function selectCurrentSessionByLegacySessionId(
  legacySessionId: string,
): Session | undefined {
  if (!hasSessionLegacySessionIdColumn(db) || !hasSessionCurrentColumn(db)) {
    return undefined;
  }
  return queryOne<Session, [string]>(
    db,
    `SELECT *
     FROM sessions
     WHERE legacy_session_id = ?
       AND is_current = 1
     LIMIT 1`,
    legacySessionId,
  );
}

function deriveSessionKeyFromContext(params: {
  requestedSessionId: string;
  channelId: string;
  agentId: string;
}): string {
  const channelKind = resolveSessionResetChannelKind(params.channelId);
  if (channelKind === 'heartbeat') {
    return buildSessionKey(params.agentId, 'heartbeat', 'system', 'default');
  }
  if (channelKind === 'tui') {
    return buildSessionKey(params.agentId, 'tui', 'dm', 'local');
  }
  return params.requestedSessionId;
}

function resolveCanonicalSessionKey(params: {
  requestedSessionId: string;
  guildId: string | null;
  channelId: string;
  agentId: string;
}): string {
  const requestedShape = classifySessionKeyShape(params.requestedSessionId);
  if (requestedShape === 'canonical_malformed') {
    throw new Error(
      `Malformed canonical session key: ${params.requestedSessionId}`,
    );
  }
  const exactSession = selectSessionById(params.requestedSessionId);
  if (exactSession?.session_key) {
    return exactSession.session_key;
  }
  if (isLegacySessionKey(params.requestedSessionId)) {
    return migrateLegacySessionKey(params.requestedSessionId, {
      agent_id: params.agentId,
      guild_id: params.guildId,
      channel_id: params.channelId,
    });
  }
  if (parseSessionKey(params.requestedSessionId)) {
    return params.requestedSessionId;
  }
  return deriveSessionKeyFromContext(params);
}

function resolveMainSessionKey(sessionKey: string): string {
  const scope = resolveSessionRoutingScope(
    sessionKey,
    getRuntimeConfig().sessionRouting,
  );
  return scope.mainSessionKey;
}

function resolveNewSessionInstanceId(params: {
  requestedSessionId: string;
}): string {
  if (
    classifySessionKeyShape(params.requestedSessionId) === 'canonical_malformed'
  ) {
    throw new Error(
      `Malformed canonical session key: ${params.requestedSessionId}`,
    );
  }
  if (
    params.requestedSessionId &&
    !parseSessionKey(params.requestedSessionId) &&
    !isLegacySessionKey(params.requestedSessionId)
  ) {
    return params.requestedSessionId;
  }
  let nextId = generateSessionInstanceId();
  while (selectSessionById(nextId)) {
    nextId = generateSessionInstanceId();
  }
  return nextId;
}

function resolveFreshSessionInstanceId(
  requestedSessionId?: string | null,
): string {
  const normalized = String(requestedSessionId || '').trim();
  if (classifySessionKeyShape(normalized) === 'canonical_malformed') {
    throw new Error(`Malformed canonical session key: ${normalized}`);
  }
  if (normalized) return normalized;
  let nextId = generateSessionInstanceId();
  while (selectSessionById(nextId)) {
    nextId = generateSessionInstanceId();
  }
  return nextId;
}

export function resolveSessionIdCompat(sessionId: string): string {
  const normalized = String(sessionId || '').trim();
  if (!normalized) return normalized;
  const exactSession = selectSessionById(normalized);
  if (exactSession) return exactSession.id;
  return (
    selectCurrentSessionBySessionKey(normalized)?.id ||
    selectCurrentSessionByMainSessionKey(normalized)?.id ||
    selectCurrentSessionByLegacySessionId(normalized)?.id ||
    normalized
  );
}

export function getOrCreateSession(
  sessionId: string,
  guildId: string | null,
  channelId: string,
  agentId?: string,
  options?: {
    forceNewCurrent?: boolean;
  },
): Session {
  const requestedSessionId = String(sessionId || '').trim();
  const requestedAgentId = agentId?.trim() || '';
  const defaultAgentId = resolveDefaultAgentId(getRuntimeConfig());
  const forceNewCurrent = options?.forceNewCurrent === true;
  const canonicalSessionKey = resolveCanonicalSessionKey({
    requestedSessionId,
    guildId,
    channelId,
    agentId: requestedAgentId || defaultAgentId,
  });
  const mainSessionKey = resolveMainSessionKey(canonicalSessionKey);
  const exactSession = requestedSessionId
    ? selectSessionById(requestedSessionId)
    : undefined;

  if (exactSession) {
    const nextAgentId =
      requestedAgentId || exactSession.agent_id || defaultAgentId;
    db.prepare(
      `UPDATE sessions
       SET last_active = datetime('now'),
           agent_id = ?,
           guild_id = ?,
           channel_id = ?,
           session_key = ?,
           main_session_key = ?
       WHERE id = ?`,
    ).run(
      nextAgentId,
      guildId,
      channelId,
      canonicalSessionKey || exactSession.id,
      mainSessionKey || canonicalSessionKey || exactSession.id,
      exactSession.id,
    );
    return requireSessionById(exactSession.id);
  }

  const existing =
    selectCurrentSessionBySessionKey(canonicalSessionKey) ||
    (requestedSessionId
      ? selectCurrentSessionByLegacySessionId(requestedSessionId)
      : undefined);
  if (existing) {
    if (forceNewCurrent) {
      return createFreshSessionInstance(existing.id, {
        nextSessionId: resolveNewSessionInstanceId({ requestedSessionId }),
      }).session;
    }
    const nextAgentId = requestedAgentId || existing.agent_id || defaultAgentId;
    db.prepare(
      `UPDATE sessions
       SET last_active = datetime('now'),
           agent_id = ?,
           guild_id = ?,
           channel_id = ?,
           session_key = ?,
           main_session_key = ?,
           legacy_session_id = CASE
             WHEN ? THEN ?
             ELSE legacy_session_id
           END
       WHERE id = ?`,
    ).run(
      nextAgentId,
      guildId,
      channelId,
      canonicalSessionKey || existing.id,
      mainSessionKey || canonicalSessionKey || existing.id,
      requestedSessionId !== canonicalSessionKey &&
        isLegacySessionKey(requestedSessionId)
        ? 1
        : 0,
      requestedSessionId || null,
      existing.id,
    );
    return requireSessionById(existing.id);
  }

  const nextSessionId = resolveNewSessionInstanceId({ requestedSessionId });
  db.prepare(
    `INSERT INTO sessions (
       id,
       session_key,
       main_session_key,
       is_current,
       guild_id,
       channel_id,
       agent_id,
       legacy_session_id
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    nextSessionId,
    canonicalSessionKey || nextSessionId,
    mainSessionKey || canonicalSessionKey || nextSessionId,
    guildId,
    channelId,
    requestedAgentId || defaultAgentId,
    requestedSessionId !== canonicalSessionKey &&
      isLegacySessionKey(requestedSessionId)
      ? requestedSessionId
      : null,
  );

  return requireSessionById(nextSessionId);
}

export function getSessionById(sessionId: string): Session | undefined {
  ensureDatabaseReady();
  const normalized = String(sessionId || '').trim();
  if (!normalized) return undefined;
  return (
    selectSessionById(normalized) ||
    selectCurrentSessionBySessionKey(normalized) ||
    selectCurrentSessionByMainSessionKey(normalized) ||
    selectCurrentSessionByLegacySessionId(normalized)
  );
}

export function getSessionsByChannelId(channelId: string): Session[] {
  ensureDatabaseReady();
  const normalized = String(channelId || '').trim();
  if (!normalized) return [];
  return queryAll<Session, [string]>(
    db,
    `SELECT *
     FROM sessions
     WHERE channel_id = ?
     ORDER BY created_at DESC, last_active DESC, id DESC`,
    normalized,
  );
}

function countSessionMessages(sessionId: string): number {
  const row = queryOne<{ count: number }, [string]>(
    db,
    'SELECT COUNT(*) AS count FROM messages WHERE session_id = ?',
    sessionId,
  );
  return row?.count ?? 0;
}

function copySessionKvStore(
  previousSessionId: string,
  nextSessionId: string,
): void {
  if (!tableExists(db, 'kv_store')) return;
  const rows = queryAll<MemoryKvRow, [string]>(
    db,
    `SELECT key, value, version, updated_at
     FROM kv_store
     WHERE agent_id = ?`,
    previousSessionId,
  );
  if (rows.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO kv_store (agent_id, key, value, version, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(nextSessionId, row.key, row.value, row.version, row.updated_at);
  }
}

export function forkSessionBranch(
  params: ForkSessionBranchParams,
): ForkSessionBranchResult {
  const sourceSession = requireSessionById(
    resolveSessionIdCompat(params.sessionId),
  );
  const beforeMessageId = params.beforeMessageId;
  if (!Number.isInteger(beforeMessageId) || beforeMessageId < 1) {
    throw new Error(
      `Invalid beforeMessageId ${String(params.beforeMessageId)}. Expected a positive integer.`,
    );
  }
  const branchTarget = db
    .prepare(
      `SELECT id
       FROM messages
       WHERE session_id = ?
         AND id = ?`,
    )
    .get(sourceSession.id, beforeMessageId) as { id: number } | undefined;
  if (!branchTarget) {
    throw new Error(
      `Message ${beforeMessageId} was not found in session ${sourceSession.id}.`,
    );
  }

  const nextSessionId = resolveFreshSessionInstanceId();
  const nextMainSessionKey =
    sourceSession.main_session_key ||
    sourceSession.session_key ||
    sourceSession.id;
  const nowIso = new Date().toISOString();

  const fork = db.transaction(() => {
    ensureSessionBranchesTable(db);
    const copiedMessageCount =
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM messages
             WHERE session_id = ?
               AND id < ?`,
          )
          .get(sourceSession.id, beforeMessageId) as { count: number }
      ).count || 0;
    db.prepare(
      `INSERT INTO sessions (
         id,
         session_key,
         main_session_key,
         is_current,
         guild_id,
         channel_id,
         agent_id,
         chatbot_id,
         model,
         enable_rag,
         message_count,
         session_summary,
         summary_updated_at,
         compaction_count,
         memory_flush_at,
         full_auto_enabled,
         full_auto_prompt,
         full_auto_started_at,
         show_mode,
         created_at,
         last_active,
         reset_count,
         reset_at,
         legacy_session_id
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      nextSessionId,
      nextSessionId,
      nextMainSessionKey,
      sourceSession.guild_id,
      sourceSession.channel_id,
      sourceSession.agent_id,
      sourceSession.chatbot_id,
      sourceSession.model,
      sourceSession.enable_rag,
      copiedMessageCount,
      sourceSession.full_auto_enabled,
      sourceSession.full_auto_prompt,
      sourceSession.full_auto_started_at,
      sourceSession.show_mode,
      nowIso,
      nowIso,
      sourceSession.reset_count,
      sourceSession.reset_at,
    );
    db.prepare(
      `INSERT INTO session_branches (
         session_id,
         parent_session_id,
         parent_message_id,
         copied_message_count
       ) VALUES (?, ?, ?, ?)`,
    ).run(nextSessionId, sourceSession.id, beforeMessageId, copiedMessageCount);
    copySessionKvStore(sourceSession.id, nextSessionId);
    db.prepare(
      `INSERT INTO messages (session_id, user_id, username, role, agent_id, content, created_at)
       SELECT ?, user_id, username, role, agent_id, content, created_at
       FROM messages
       WHERE session_id = ?
         AND id < ?
       ORDER BY id ASC`,
    ).run(nextSessionId, sourceSession.id, beforeMessageId);
    return copiedMessageCount;
  });
  const copiedMessageCount = fork();

  return {
    session: requireSessionById(nextSessionId),
    copiedMessageCount,
  };
}

export function createFreshSessionInstance(
  sessionId: string,
  params?: {
    nextSessionId?: string | null;
    resetSettings?: boolean;
    defaultEnableRag?: boolean;
  },
): {
  previousSession: Session;
  session: Session;
  deletedMessages: number;
} {
  const previousSession = requireSessionById(resolveSessionIdCompat(sessionId));
  const nextSessionId = resolveFreshSessionInstanceId(params?.nextSessionId);
  const nowIso = new Date().toISOString();
  const deletedMessages = countSessionMessages(previousSession.id);
  const nextSessionKey = previousSession.session_key || previousSession.id;
  const nextMainSessionKey =
    previousSession.main_session_key || nextSessionKey || previousSession.id;
  const nextEnableRag =
    params?.resetSettings && typeof params.defaultEnableRag === 'boolean'
      ? params.defaultEnableRag
        ? 1
        : 0
      : previousSession.enable_rag;

  const rotate = db.transaction(() => {
    if (hasSessionLegacySessionIdColumn(db)) {
      db.prepare(
        'UPDATE sessions SET legacy_session_id = NULL WHERE id = ?',
      ).run(previousSession.id);
    }
    if (hasSessionCurrentColumn(db)) {
      db.prepare(
        'UPDATE sessions SET is_current = 0 WHERE session_key = ?',
      ).run(nextSessionKey);
    }
    db.prepare(
      `INSERT INTO sessions (
         id,
         session_key,
         main_session_key,
         is_current,
         guild_id,
         channel_id,
         agent_id,
         chatbot_id,
         model,
         enable_rag,
         message_count,
         session_summary,
         summary_updated_at,
         compaction_count,
         memory_flush_at,
         full_auto_enabled,
         full_auto_prompt,
         full_auto_started_at,
         show_mode,
         created_at,
         last_active,
         reset_count,
         reset_at,
         legacy_session_id
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nextSessionId,
      nextSessionKey,
      nextMainSessionKey,
      previousSession.guild_id,
      previousSession.channel_id,
      previousSession.agent_id,
      params?.resetSettings ? null : previousSession.chatbot_id,
      params?.resetSettings ? null : previousSession.model,
      nextEnableRag,
      params?.resetSettings ? 0 : previousSession.full_auto_enabled,
      params?.resetSettings ? null : previousSession.full_auto_prompt,
      params?.resetSettings ? null : previousSession.full_auto_started_at,
      params?.resetSettings ? 'all' : previousSession.show_mode,
      nowIso,
      nowIso,
      previousSession.reset_count + 1,
      nowIso,
      previousSession.legacy_session_id || null,
    );
    db.prepare('UPDATE tasks SET session_id = ? WHERE session_id = ?').run(
      nextSessionId,
      previousSession.id,
    );
    copySessionKvStore(previousSession.id, nextSessionId);
  });
  rotate();

  return {
    previousSession,
    session: requireSessionById(nextSessionId),
    deletedMessages,
  };
}

export function getAnyChatbotId(): string | null {
  const row = queryOne<Pick<Session, 'chatbot_id'>>(
    db,
    `SELECT chatbot_id FROM sessions
     WHERE chatbot_id IS NOT NULL AND chatbot_id != ''
     ORDER BY last_active DESC
     LIMIT 1`,
  );
  return row?.chatbot_id?.trim() || null;
}

export function updateSessionChatbot(
  sessionId: string,
  chatbotId: string | null,
): void {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  db.prepare('UPDATE sessions SET chatbot_id = ? WHERE id = ?').run(
    chatbotId,
    resolvedSessionId,
  );
}

export function updateSessionAgent(sessionId: string, agentId: string): void {
  const normalizedAgentId =
    agentId.trim() || resolveDefaultAgentId(getRuntimeConfig());
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  db.prepare('UPDATE sessions SET agent_id = ? WHERE id = ?').run(
    normalizedAgentId,
    resolvedSessionId,
  );
}

export function updateSessionModel(
  sessionId: string,
  model: string | null,
): void {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  db.prepare('UPDATE sessions SET model = ? WHERE id = ?').run(
    model,
    resolvedSessionId,
  );
}

export function updateSessionRag(sessionId: string, enableRag: boolean): void {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  db.prepare('UPDATE sessions SET enable_rag = ? WHERE id = ?').run(
    enableRag ? 1 : 0,
    resolvedSessionId,
  );
}

export function updateSessionFullAuto(
  sessionId: string,
  params: {
    enabled: boolean;
    prompt?: string | null;
    startedAt?: string | null;
  },
): void {
  const normalizedPrompt =
    typeof params.prompt === 'string' ? params.prompt.trim() || null : null;
  const normalizedStartedAt =
    typeof params.startedAt === 'string'
      ? params.startedAt.trim() || null
      : params.startedAt === null
        ? null
        : params.enabled
          ? new Date().toISOString()
          : null;
  db.prepare(
    `UPDATE sessions
     SET full_auto_enabled = ?,
         full_auto_prompt = ?,
         full_auto_started_at = ?
     WHERE id = ?`,
  ).run(
    params.enabled ? 1 : 0,
    normalizedPrompt,
    normalizedStartedAt,
    resolveSessionIdCompat(sessionId),
  );
}

export function updateSessionShowMode(
  sessionId: string,
  showMode: SessionShowMode,
): void {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  db.prepare('UPDATE sessions SET show_mode = ? WHERE id = ?').run(
    showMode,
    resolvedSessionId,
  );
}

export function getAllSessions(options?: {
  limit?: number;
  warnLabel?: string;
}): Session[] {
  const limit =
    options?.limit == null ? null : Math.max(1, Math.floor(options.limit));
  const warnLabel = options?.warnLabel || null;
  const sql = hasSessionCurrentColumn(db)
    ? `SELECT * FROM sessions WHERE is_current = 1 ORDER BY last_active DESC${limit == null ? '' : ' LIMIT ?'}`
    : `SELECT * FROM sessions ORDER BY last_active DESC${limit == null ? '' : ' LIMIT ?'}`;
  const rows =
    limit == null
      ? queryAll<Session>(db, sql)
      : queryAll<Session, [number]>(db, sql, limit + 1);
  if (limit != null && warnLabel && rows.length > limit) {
    logger.warn(
      {
        limit,
        returnedRows: rows.length,
        warnLabel,
      },
      'Session query hit safety cap; returning truncated results',
    );
    return rows.slice(0, limit);
  }
  return rows;
}

export interface RecentUserSessionSummary {
  sessionId: string;
  lastActive: string;
  messageCount: number;
  title: string | null;
  searchSnippet?: string | null;
}

type RecentUserSessionRow = Pick<
  Session,
  'id' | 'last_active' | 'message_count'
>;

interface RecentSessionBoundaryRow {
  session_id: string;
  first_user_content: string | null;
  first_content: string | null;
  last_content: string | null;
  last_role: string | null;
}

interface RecentSessionContentMatchRow {
  session_id: string;
  content: string | null;
}

const RECENT_SESSION_BOUNDARY_BATCH_SIZE = 400;

function batchQueryAllBySessionIds<Row>(
  sessionIds: string[],
  queryBatch: (batch: string[], placeholders: string) => Row[],
): Row[] {
  const rows: Row[] = [];

  for (
    let index = 0;
    index < sessionIds.length;
    index += RECENT_SESSION_BOUNDARY_BATCH_SIZE
  ) {
    const batch = sessionIds.slice(
      index,
      index + RECENT_SESSION_BOUNDARY_BATCH_SIZE,
    );
    const placeholders = batch.map(() => '?').join(', ');
    rows.push(...queryBatch(batch, placeholders));
  }

  return rows;
}

function getRecentSessionBoundaryRows(
  sessionIds: string[],
  userId: string | null,
): RecentSessionBoundaryRow[] {
  return batchQueryAllBySessionIds(sessionIds, (batch, placeholders) =>
    queryAll<RecentSessionBoundaryRow>(
      db,
      `WITH ranked AS (
         SELECT
           session_id,
           role,
           content,
           CASE WHEN role = 'user' AND (? IS NULL OR user_id = ?) THEN 1 ELSE 0 END AS is_target_user,
           ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id ASC) AS rn_first,
           ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) AS rn_last,
           ROW_NUMBER() OVER (
             PARTITION BY session_id, CASE WHEN role = 'user' AND (? IS NULL OR user_id = ?) THEN 1 ELSE 0 END
             ORDER BY id ASC
           ) AS rn_target_group
         FROM messages
         WHERE session_id IN (${placeholders})
       )
       SELECT
         session_id,
         MAX(CASE WHEN is_target_user = 1 AND rn_target_group = 1 THEN content END) AS first_user_content,
         MAX(CASE WHEN rn_first = 1 THEN content END) AS first_content,
         MAX(CASE WHEN rn_last = 1 THEN content END) AS last_content,
         MAX(CASE WHEN rn_last = 1 THEN role END) AS last_role
       FROM ranked
       GROUP BY session_id`,
      userId,
      userId,
      userId,
      userId,
      ...batch,
    ),
  );
}

function getRecentSessionContentMatches(
  sessionIds: string[],
  normalizedQuery: string,
): Map<string, string> {
  const matchQuery = buildRecentChatSearchMatchQuery(normalizedQuery);
  if (!normalizedQuery || !matchQuery || sessionIds.length === 0) {
    return new Map();
  }

  const rows = batchQueryAllBySessionIds(sessionIds, (batch, placeholders) =>
    queryAll<RecentSessionContentMatchRow>(
      db,
      `WITH ranked_matches AS (
           SELECT
             session_id,
             content,
             ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY rowid DESC) AS rn
           FROM ${RECENT_CHAT_MESSAGE_SEARCH_TABLE}
           WHERE ${RECENT_CHAT_MESSAGE_SEARCH_TABLE} MATCH ?
             AND session_id IN (${placeholders})
             AND instr(lower(content), ?) > 0
         )
         SELECT session_id, content
         FROM ranked_matches
         WHERE rn = 1`,
      matchQuery,
      ...batch,
      normalizedQuery,
    ),
  );

  return new Map(
    rows
      .filter((row) => row.session_id && row.content)
      .map((row) => [row.session_id, row.content as string] as const),
  );
}

function buildRecentSessionSummaries(params: {
  rows: RecentUserSessionRow[];
  boundaryUserId: string | null;
  searchQuery: string;
  limit: number;
}): RecentUserSessionSummary[] {
  const sortedRows = [...params.rows].sort((left, right) => {
    const rightTimestamp = parseTimestamp(right.last_active);
    const leftTimestamp = parseTimestamp(left.last_active);
    if (rightTimestamp !== leftTimestamp) {
      return rightTimestamp - leftTimestamp;
    }
    return right.id.localeCompare(left.id);
  });
  const targetRows = params.searchQuery
    ? sortedRows.slice(0, MAX_RECENT_CHAT_SESSION_LIMIT)
    : sortedRows.slice(0, params.limit);
  if (targetRows.length === 0) return [];

  const sessionIds = targetRows.map((row) => row.id);
  const boundaryRows = getRecentSessionBoundaryRows(
    sessionIds,
    params.boundaryUserId,
  );
  const contentMatchesBySessionId = getRecentSessionContentMatches(
    sessionIds,
    params.searchQuery,
  );
  const boundariesBySessionId = new Map(
    boundaryRows.map((row) => [row.session_id, row] as const),
  );

  const sessions = targetRows.map((row) => {
    const boundary = boundariesBySessionId.get(row.id);
    const firstMessage =
      boundary?.first_user_content || boundary?.first_content || null;
    const shouldHideApprovalPrompt =
      boundary?.last_role === 'assistant' &&
      Boolean(
        boundary?.last_content &&
          isApprovalHistoryMessage(boundary.last_content),
      );
    const lastMessage =
      boundary?.last_content && !shouldHideApprovalPrompt
        ? boundary.last_content
        : null;
    const title = buildSessionBoundaryPreview({
      firstMessage,
      lastMessage,
      maxLength: RECENT_CHAT_SESSION_TITLE_MAX_LENGTH,
    });
    const rawSearchSnippet = params.searchQuery
      ? buildSessionSearchSnippet(
          contentMatchesBySessionId.get(row.id) || null,
          params.searchQuery,
        )
      : null;

    return {
      sessionId: row.id,
      lastActive: row.last_active,
      messageCount: normalizeUsageNumber(row.message_count),
      title,
      ...(shouldIncludeSessionSearchSnippet(title, rawSearchSnippet)
        ? { searchSnippet: rawSearchSnippet }
        : {}),
    };
  });

  if (!params.searchQuery) return sessions;
  return sessions
    .filter((session) => {
      const titleMatches = String(session.title || '')
        .toLowerCase()
        .includes(params.searchQuery);
      return titleMatches || Boolean(session.searchSnippet);
    })
    .slice(0, params.limit);
}

export function getRecentSessionsForUser(params: {
  userId: string;
  channelId?: string | null;
  limit?: number;
  query?: string | null;
}): RecentUserSessionSummary[] {
  const userId = params.userId.trim();
  if (!userId) return [];
  const channelId = String(params.channelId || '').trim();
  const searchQuery = normalizeRecentChatSearchQuery(
    params.query,
  ).toLowerCase();
  const limit = normalizeRecentChatSessionLimit(params.limit);

  const rows = channelId
    ? queryAll<RecentUserSessionRow, [string, string]>(
        db,
        `SELECT DISTINCT s.id, s.last_active, s.message_count
           FROM sessions s
           INNER JOIN messages m
             ON m.session_id = s.id
           WHERE m.user_id = ?
             AND s.channel_id = ?`,
        userId,
        channelId,
      )
    : queryAll<RecentUserSessionRow, [string]>(
        db,
        `SELECT DISTINCT s.id, s.last_active, s.message_count
           FROM sessions s
           INNER JOIN messages m
             ON m.session_id = s.id
           WHERE m.user_id = ?`,
        userId,
      );

  return buildRecentSessionSummaries({
    rows,
    boundaryUserId: userId,
    searchQuery,
    limit,
  });
}

export function getRecentSessionsForChannel(params: {
  channelId: string;
  limit?: number;
  query?: string | null;
}): RecentUserSessionSummary[] {
  const channelId = params.channelId.trim();
  if (!channelId) return [];
  const searchQuery = normalizeRecentChatSearchQuery(
    params.query,
  ).toLowerCase();
  const limit = normalizeRecentChatSessionLimit(params.limit);
  const sqlLimit = searchQuery ? MAX_RECENT_CHAT_SESSION_LIMIT : limit;

  const rows = queryAll<RecentUserSessionRow, [string, number]>(
    db,
    `SELECT s.id, s.last_active, s.message_count
       FROM sessions s
      WHERE s.channel_id = ?
        AND EXISTS (
          SELECT 1
            FROM messages m
           WHERE m.session_id = s.id
        )
      ORDER BY s.last_active DESC
      LIMIT ?`,
    channelId,
    sqlLimit,
  );

  return buildRecentSessionSummaries({
    rows,
    boundaryUserId: null,
    searchQuery,
    limit,
  });
}

export function getFullAutoSessionCount(): number {
  const row = queryOne<{ count: number }>(
    db,
    hasSessionCurrentColumn(db)
      ? 'SELECT COUNT(*) as count FROM sessions WHERE is_current = 1 AND full_auto_enabled = 1'
      : 'SELECT COUNT(*) as count FROM sessions WHERE full_auto_enabled = 1',
  ) || { count: 0 };
  return row.count;
}

export function getEnabledFullAutoSessions(): Session[] {
  const sql = hasSessionCurrentColumn(db)
    ? 'SELECT * FROM sessions WHERE is_current = 1 AND full_auto_enabled = 1 ORDER BY last_active DESC'
    : 'SELECT * FROM sessions WHERE full_auto_enabled = 1 ORDER BY last_active DESC';
  return queryAll<Session>(db, sql);
}

export function getSessionCount(): number {
  const sql = hasSessionCurrentColumn(db)
    ? 'SELECT COUNT(*) as count FROM sessions WHERE is_current = 1'
    : 'SELECT COUNT(*) as count FROM sessions';
  const row = queryOne<{ count: number }>(db, sql) || { count: 0 };
  return row.count;
}

export function getMostRecentSessionChannelId(): string | null {
  const row = queryOne<Pick<Session, 'channel_id'>>(
    db,
    hasSessionCurrentColumn(db)
      ? 'SELECT channel_id FROM sessions WHERE is_current = 1 ORDER BY last_active DESC LIMIT 1'
      : 'SELECT channel_id FROM sessions ORDER BY last_active DESC LIMIT 1',
  );
  if (!row || typeof row.channel_id !== 'string') return null;
  const channelId = row.channel_id.trim();
  return channelId || null;
}

export function clearSessionHistory(sessionId: string): number {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const result = db
    .prepare('DELETE FROM messages WHERE session_id = ?')
    .run(resolvedSessionId);
  db.prepare('DELETE FROM semantic_memories WHERE session_id = ?').run(
    resolvedSessionId,
  );
  db.prepare(
    'UPDATE sessions SET message_count = 0, session_summary = NULL, summary_updated_at = NULL, compaction_count = 0, memory_flush_at = NULL WHERE id = ?',
  ).run(resolvedSessionId);
  return result.changes;
}

export function resetSessionState(sessionId: string): Session {
  return createFreshSessionInstance(sessionId).session;
}

export function deleteSessionData(sessionId: string): {
  deleted: boolean;
  sessionId: string;
  deletedMessages: number;
  deletedTasks: number;
  deletedSemanticMemories: number;
  deletedUsageEvents: number;
  deletedAuditEntries: number;
  deletedStructuredAuditEntries: number;
  deletedApprovalEntries: number;
} {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const transaction = db.transaction((value: string) => {
    const deletedMessages = db
      .prepare('DELETE FROM messages WHERE session_id = ?')
      .run(value).changes;
    const deletedSemanticMemories = db
      .prepare('DELETE FROM semantic_memories WHERE session_id = ?')
      .run(value).changes;
    const deletedTasks = db
      .prepare('DELETE FROM tasks WHERE session_id = ?')
      .run(value).changes;
    const deletedAuditEntries = db
      .prepare('DELETE FROM audit_log WHERE session_id = ?')
      .run(value).changes;
    const deletedStructuredAuditEntries = db
      .prepare('DELETE FROM audit_events WHERE session_id = ?')
      .run(value).changes;
    const deletedApprovalEntries = db
      .prepare('DELETE FROM approvals WHERE session_id = ?')
      .run(value).changes;
    const deletedUsageEvents = db
      .prepare('DELETE FROM usage_events WHERE session_id = ?')
      .run(value).changes;
    const deletedSession = db
      .prepare('DELETE FROM sessions WHERE id = ?')
      .run(value).changes;

    return {
      deleted: deletedSession > 0,
      sessionId: value,
      deletedMessages,
      deletedTasks,
      deletedSemanticMemories,
      deletedUsageEvents,
      deletedAuditEntries,
      deletedStructuredAuditEntries,
      deletedApprovalEntries,
    };
  });

  return transaction(resolvedSessionId);
}

export function storeMessage(
  sessionId: string,
  userId: string,
  username: string | null,
  role: string,
  content: string,
  agentId?: string | null,
): number {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const normalizedAgentId = agentId?.trim() || null;
  const result = db
    .prepare(
      'INSERT INTO messages (session_id, user_id, username, role, agent_id, content) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(resolvedSessionId, userId, username, role, normalizedAgentId, content);

  db.prepare(
    "UPDATE sessions SET message_count = message_count + 1, last_active = datetime('now') WHERE id = ?",
  ).run(resolvedSessionId);

  return result.lastInsertRowid as number;
}

export function getConversationHistory(
  sessionId: string,
  limit = 50,
): StoredMessage[] {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  return queryAll<StoredMessage, [string, number]>(
    db,
    'SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    resolvedSessionId,
    limit,
  );
}

function getBranchVariantMessageId(
  sessionId: string,
  copiedMessageCount: number,
): number | null {
  const row = db
    .prepare(
      `SELECT id
       FROM messages
       WHERE session_id = ?
       ORDER BY id ASC
       LIMIT 1 OFFSET ?`,
    )
    .get(sessionId, copiedMessageCount) as { id: number } | undefined;
  return row?.id ?? null;
}

function buildConversationBranchFamily(
  parentSessionId: string,
  parentMessageId: number,
): ConversationBranchFamily | null {
  const childRows = db
    .prepare(
      `SELECT
         sb.session_id,
         sb.parent_session_id,
         sb.parent_message_id,
         sb.copied_message_count
       FROM session_branches sb
       JOIN sessions s ON s.id = sb.session_id
       WHERE sb.parent_session_id = ?
         AND sb.parent_message_id = ?
       ORDER BY s.created_at ASC, sb.session_id ASC`,
    )
    .all(parentSessionId, parentMessageId) as SessionBranchRow[];
  if (childRows.length === 0) return null;

  const variants = [
    {
      sessionId: parentSessionId,
      messageId: parentMessageId,
    },
  ];
  for (const row of childRows) {
    const messageId = getBranchVariantMessageId(
      row.session_id,
      row.copied_message_count,
    );
    if (!messageId) continue;
    variants.push({
      sessionId: row.session_id,
      messageId,
    });
  }

  return variants.length < 2
    ? null
    : {
        anchorSessionId: parentSessionId,
        anchorMessageId: parentMessageId,
        variants,
      };
}

export function getConversationBranchFamilies(
  sessionId: string,
): ConversationBranchFamily[] {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  ensureSessionBranchesTable(db);
  const families: ConversationBranchFamily[] = [];
  const seen = new Set<string>();
  const addFamily = (parentSessionId: string, parentMessageId: number) => {
    const familyKey = `${parentSessionId}:${parentMessageId}`;
    if (seen.has(familyKey)) return;
    seen.add(familyKey);
    const family = buildConversationBranchFamily(
      parentSessionId,
      parentMessageId,
    );
    if (family) {
      families.push(family);
    }
  };

  const currentBranch = db
    .prepare(
      `SELECT session_id, parent_session_id, parent_message_id, copied_message_count
       FROM session_branches
       WHERE session_id = ?`,
    )
    .get(resolvedSessionId) as SessionBranchRow | undefined;
  if (currentBranch) {
    addFamily(currentBranch.parent_session_id, currentBranch.parent_message_id);
  }

  const childAnchors = db
    .prepare(
      `SELECT DISTINCT parent_message_id
       FROM session_branches
       WHERE parent_session_id = ?
       ORDER BY parent_message_id ASC`,
    )
    .all(resolvedSessionId) as Array<{ parent_message_id: number }>;
  for (const row of childAnchors) {
    addFamily(resolvedSessionId, row.parent_message_id);
  }

  return families;
}

export function getConversationHistoryPage(
  sessionId: string,
  limit = 50,
): ConversationHistoryPage {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const rows = db
    .prepare(
      `SELECT
         s.session_key,
         s.main_session_key,
         m.id,
         m.session_id,
         m.user_id,
         m.username,
         m.role,
         m.agent_id,
         m.content,
         m.created_at
       FROM sessions s
       LEFT JOIN (
         SELECT *
         FROM messages
         WHERE session_id = ?
         ORDER BY id DESC
         LIMIT ?
       ) m ON m.session_id = s.id
       WHERE s.id = ?
       ORDER BY m.id DESC`,
    )
    .all(
      resolvedSessionId,
      Math.max(1, Math.floor(limit)),
      resolvedSessionId,
    ) as ConversationHistoryPageRow[];

  if (rows.length === 0) {
    return {
      sessionKey: null,
      mainSessionKey: null,
      history: [],
      branchFamilies: [],
    };
  }

  const history: StoredMessage[] = [];
  for (const row of rows) {
    if (
      row.id == null ||
      row.session_id == null ||
      row.user_id == null ||
      row.role == null ||
      row.content == null ||
      row.created_at == null
    ) {
      continue;
    }
    history.push({
      id: row.id,
      session_id: row.session_id,
      user_id: row.user_id,
      username: row.username,
      role: row.role,
      agent_id: row.agent_id,
      content: row.content,
      created_at: row.created_at,
    });
  }

  return {
    sessionKey: rows[0]?.session_key || null,
    mainSessionKey: rows[0]?.main_session_key || null,
    history,
    branchFamilies: getConversationBranchFamilies(resolvedSessionId),
  };
}

export function getRecentMessages(
  sessionId: string,
  limit?: number,
): StoredMessage[] {
  ensureDatabaseReady();
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const boundedLimit =
    typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : null;

  if (boundedLimit == null) {
    return queryAll<StoredMessage, [string]>(
      db,
      'SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC',
      resolvedSessionId,
    );
  }

  const rows = queryAll<StoredMessage, [string, number]>(
    db,
    'SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    resolvedSessionId,
    boundedLimit,
  );
  return rows.reverse();
}

export function getSessionBoundaryMessages(sessionId: string): {
  firstMessage: string | null;
  lastMessage: string | null;
} {
  return (
    getSessionBoundaryMessagesBySessionIds([sessionId]).get(
      resolveSessionIdCompat(sessionId),
    ) || {
      firstMessage: null,
      lastMessage: null,
    }
  );
}

export function getSessionBoundaryMessagesBySessionIds(
  sessionIds: string[],
): Map<
  string,
  {
    firstMessage: string | null;
    lastMessage: string | null;
  }
> {
  const normalizedSessionIds = Array.from(
    new Set(
      sessionIds
        .map((sessionId) => resolveSessionIdCompat(sessionId))
        .filter((sessionId) => sessionId.length > 0),
    ),
  );
  if (normalizedSessionIds.length === 0) return new Map();

  const placeholders = normalizedSessionIds.map(() => '?').join(', ');
  const rows = queryAll<
    {
      session_id: string;
      first_content: string | null;
      last_content: string | null;
    },
    string[]
  >(
    db,
    `WITH bounds AS (
       SELECT
         session_id,
         MIN(id) AS first_id,
         MAX(id) AS last_id
       FROM messages
       WHERE session_id IN (${placeholders})
       GROUP BY session_id
     )
     SELECT
       bounds.session_id,
       MAX(CASE WHEN messages.id = bounds.first_id THEN messages.content END) AS first_content,
       MAX(CASE WHEN messages.id = bounds.last_id THEN messages.content END) AS last_content
     FROM bounds
     INNER JOIN messages
       ON messages.session_id = bounds.session_id
      AND messages.id IN (bounds.first_id, bounds.last_id)
     GROUP BY bounds.session_id`,
    ...normalizedSessionIds,
  );

  return new Map(
    rows.map((row) => [
      row.session_id,
      {
        firstMessage: row.first_content || null,
        lastMessage: row.last_content || null,
      },
    ]),
  );
}

export function getSessionMessageCounts(sessionId: string): {
  totalMessages: number;
  userMessages: number;
} {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const row = queryOne<
    { total_messages: unknown; user_messages: unknown },
    [string]
  >(
    db,
    `SELECT
         COUNT(*) AS total_messages,
         COALESCE(SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END), 0) AS user_messages
       FROM messages
       WHERE session_id = ?`,
    resolvedSessionId,
  ) || {
    total_messages: 0,
    user_messages: 0,
  };

  return {
    totalMessages: normalizeUsageNumber(row.total_messages),
    userMessages: normalizeUsageNumber(row.user_messages),
  };
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

function parseQueryTerms(
  query: string,
  tokenizer: MemoryRecallTokenizer,
): string[] {
  return tokenizeMemoryRecallQuery(query, 8, tokenizer);
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

type RawSemanticMemoryRow = Omit<
  SemanticMemoryEntry,
  'metadata' | 'embedding'
> & {
  metadata: string | null;
  embedding: Buffer | Uint8Array | null;
};

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
  touch?: boolean;
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

  const rawRows = queryAll<RawSemanticMemoryRow>(
    db,
    `SELECT *
     FROM semantic_memories
     WHERE ${whereClauses.join('\n         AND ')}
     ORDER BY confidence DESC, accessed_at DESC
     LIMIT ?`,
    ...args,
  );
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

  if (params.touch !== false) {
    touchSemanticMemoryRows(ranked);
  }
  return ranked;
}

function recallSemanticMemoriesByVector(params: {
  sessionId: string;
  queryEmbedding: Float32Array;
  limit: number;
  minConfidence: number;
  filter?: SemanticRecallFilter;
  touch?: boolean;
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
  const rawRows = queryAll<RawSemanticMemoryRow>(
    db,
    `SELECT *
     FROM semantic_memories
     WHERE ${whereClauses.join('\n         AND ')}
     ORDER BY accessed_at DESC, confidence DESC
     LIMIT ?`,
    ...args,
  );
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

  if (params.touch !== false) {
    touchSemanticMemoryRows(ranked);
  }
  return ranked;
}

function rankSemanticMemoriesWithFts(params: {
  rows: SemanticMemoryEntry[];
  query: string;
  limit: number;
  tokenizer: MemoryRecallTokenizer;
  rankMode: 'source' | 'bm25';
}): SemanticMemoryEntry[] {
  if (params.rows.length === 0) return [];
  const matchQuery = buildMemoryFtsMatchQuery(
    params.query,
    12,
    params.tokenizer,
  );
  if (!matchQuery) {
    return [];
  }

  const ftsDb = new Database(':memory:');
  try {
    const tokenizerSpec = getMemoryFtsTokenizerSpec(params.tokenizer);
    ftsDb.exec(
      `CREATE VIRTUAL TABLE semantic_recall USING fts5(memory_id UNINDEXED, content, tokenize='${tokenizerSpec}')`,
    );
  } catch (error) {
    ftsDb.close();
    throw new Error(
      `Full-text semantic recall requires SQLite FTS5 support: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const rowsById = new Map<number, SemanticMemoryEntry>();
    const insert = ftsDb.prepare(
      'INSERT INTO semantic_recall (memory_id, content) VALUES (?, ?)',
    );
    const transaction = ftsDb.transaction(() => {
      for (const row of params.rows) {
        rowsById.set(row.id, row);
        insert.run(
          row.id,
          buildMemoryFtsDocument(row.content, params.tokenizer),
        );
      }
    });
    transaction();

    if (params.rankMode === 'source') {
      const matches = ftsDb
        .prepare(
          `SELECT memory_id
           FROM semantic_recall
           WHERE semantic_recall MATCH ?`,
        )
        .all(matchQuery) as Array<{
        memory_id: number;
      }>;
      const matchedIds = new Set<number>(
        matches.map((match) => Number(match.memory_id)),
      );
      const ordered: SemanticMemoryEntry[] = [];
      for (const row of params.rows) {
        if (!matchedIds.has(row.id)) {
          continue;
        }
        ordered.push(row);
        if (ordered.length >= Math.max(1, params.limit)) {
          break;
        }
      }
      return ordered;
    }

    const matches = ftsDb
      .prepare(
        `SELECT memory_id
         FROM semantic_recall
         WHERE semantic_recall MATCH ?
         ORDER BY bm25(semantic_recall)
         LIMIT ?`,
      )
      .all(matchQuery, Math.max(1, params.limit)) as Array<{
      memory_id: number;
    }>;

    const ordered: SemanticMemoryEntry[] = [];
    for (const match of matches) {
      const row = rowsById.get(Number(match.memory_id));
      if (row) {
        ordered.push(row);
      }
    }
    return ordered;
  } finally {
    ftsDb.close();
  }
}

function rerankSemanticMemoriesWithFts(params: {
  rows: SemanticMemoryEntry[];
  query: string;
  tokenizer: MemoryRecallTokenizer;
}): SemanticMemoryEntry[] {
  const reranked = rankSemanticMemoriesWithFts({
    rows: params.rows,
    query: params.query,
    limit: params.rows.length,
    tokenizer: params.tokenizer,
    rankMode: 'bm25',
  });
  if (reranked.length === 0) {
    return params.rows;
  }

  const seen = new Set<number>();
  const ordered: SemanticMemoryEntry[] = [];
  for (const row of reranked) {
    seen.add(row.id);
    ordered.push(row);
  }
  for (const row of params.rows) {
    if (seen.has(row.id)) {
      continue;
    }
    ordered.push(row);
  }
  return ordered;
}

function fuseHybridSemanticMemories(params: {
  cosineRows: SemanticMemoryEntry[];
  fullTextRows: SemanticMemoryEntry[];
}): SemanticMemoryEntry[] {
  if (params.cosineRows.length === 0) {
    return params.fullTextRows;
  }
  if (params.fullTextRows.length === 0) {
    return params.cosineRows;
  }

  const rowsById = new Map<number, SemanticMemoryEntry>();
  const scoreById = new Map<number, number>();
  const cosineRankById = new Map<number, number>();
  const fullTextRankById = new Map<number, number>();

  for (let index = 0; index < params.cosineRows.length; index += 1) {
    const row = params.cosineRows[index];
    rowsById.set(row.id, row);
    cosineRankById.set(row.id, index + 1);
    scoreById.set(row.id, (scoreById.get(row.id) || 0) + 1 / (60 + index + 1));
  }

  for (let index = 0; index < params.fullTextRows.length; index += 1) {
    const row = params.fullTextRows[index];
    rowsById.set(row.id, row);
    fullTextRankById.set(row.id, index + 1);
    scoreById.set(row.id, (scoreById.get(row.id) || 0) + 1 / (60 + index + 1));
  }

  return [...rowsById.values()].sort((left, right) => {
    const leftScore = scoreById.get(left.id) || 0;
    const rightScore = scoreById.get(right.id) || 0;
    if (rightScore !== leftScore) return rightScore - leftScore;

    const leftFullTextRank =
      fullTextRankById.get(left.id) || Number.MAX_SAFE_INTEGER;
    const rightFullTextRank =
      fullTextRankById.get(right.id) || Number.MAX_SAFE_INTEGER;
    if (leftFullTextRank !== rightFullTextRank) {
      return leftFullTextRank - rightFullTextRank;
    }

    const leftCosineRank =
      cosineRankById.get(left.id) || Number.MAX_SAFE_INTEGER;
    const rightCosineRank =
      cosineRankById.get(right.id) || Number.MAX_SAFE_INTEGER;
    if (leftCosineRank !== rightCosineRank) {
      return leftCosineRank - rightCosineRank;
    }

    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }
    return parseTimestamp(right.accessed_at) - parseTimestamp(left.accessed_at);
  });
}

function recallSemanticMemoriesByFts(params: {
  sessionId: string;
  normalizedQuery: string;
  limit: number;
  minConfidence: number;
  tokenizer: MemoryRecallTokenizer;
  rankMode: 'source' | 'bm25';
  filter?: SemanticRecallFilter;
  touch?: boolean;
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
  const rows = queryAll<RawSemanticMemoryRow>(
    db,
    `SELECT *
     FROM semantic_memories
     WHERE ${whereClauses.join('\n         AND ')}
     ORDER BY accessed_at DESC, confidence DESC`,
    ...args,
  ).map(mapSemanticMemoryRow);
  if (rows.length === 0) {
    return [];
  }

  const ranked = rankSemanticMemoriesWithFts({
    rows,
    query: params.normalizedQuery,
    limit: params.limit,
    tokenizer: params.tokenizer,
    rankMode: params.rankMode,
  });
  if (params.touch !== false) {
    touchSemanticMemoryRows(ranked);
  }
  return ranked;
}

function recallSemanticMemoriesByRecent(params: {
  sessionId: string;
  limit: number;
  minConfidence: number;
  filter?: SemanticRecallFilter;
  touch?: boolean;
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
  const rows = queryAll<RawSemanticMemoryRow>(
    db,
    `SELECT *
     FROM semantic_memories
     WHERE ${whereClauses.join('\n         AND ')}
     ORDER BY accessed_at DESC, confidence DESC
     LIMIT ?`,
    ...args,
  );
  const mapped = rows.map(mapSemanticMemoryRow);
  if (params.touch !== false) {
    touchSemanticMemoryRows(mapped);
  }
  return mapped;
}

export function listSemanticMemoriesForSession(
  sessionId: string,
  limit = 5,
): SemanticMemoryEntry[] {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit || 5), 50));
  const rows = queryAll<RawSemanticMemoryRow>(
    db,
    `SELECT *
     FROM semantic_memories
     WHERE session_id = ?
       AND deleted = 0
     ORDER BY accessed_at DESC, confidence DESC
     LIMIT ?`,
    resolvedSessionId,
    boundedLimit,
  );
  return rows.map(mapSemanticMemoryRow);
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
  const resolvedSessionId = resolveSessionIdCompat(params.sessionId);
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
      resolvedSessionId,
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
  limitHardCap?: number | null;
  minConfidence?: number;
  queryEmbedding?: number[] | null;
  backend?: MemoryRecallBackend;
  rerank?: MemoryRecallRerank;
  tokenizer?: MemoryRecallTokenizer;
  filter?: SemanticRecallFilter;
  touch?: boolean;
}): SemanticMemoryEntry[] {
  const resolvedSessionId = resolveSessionIdCompat(params.sessionId);
  const normalizedQuery = params.query.trim().toLowerCase();
  const tokenizer = normalizeMemoryRecallTokenizer(
    params.tokenizer,
    'unicode61',
  );
  const queryTerms = parseQueryTerms(normalizedQuery, tokenizer);
  const queryEmbedding = normalizeEmbeddingInput(params.queryEmbedding);

  const requestedLimit = Math.max(1, Math.floor(params.limit || 5));
  const limitHardCap =
    typeof params.limitHardCap === 'number' &&
    Number.isFinite(params.limitHardCap)
      ? Math.max(1, Math.floor(params.limitHardCap))
      : params.limitHardCap === null
        ? null
        : 50;
  const limit =
    limitHardCap == null
      ? requestedLimit
      : Math.min(requestedLimit, limitHardCap);
  const rawMinConfidence =
    typeof params.minConfidence === 'number' &&
    Number.isFinite(params.minConfidence)
      ? params.minConfidence
      : 0.2;
  const minConfidence = Math.max(0, Math.min(1, rawMinConfidence));
  const backend = normalizeMemoryRecallBackend(params.backend, 'cosine');
  const rerank = normalizeMemoryRecallRerank(params.rerank, 'none');

  if (!queryEmbedding && queryTerms.length === 0) {
    return recallSemanticMemoriesByRecent({
      sessionId: resolvedSessionId,
      limit,
      minConfidence,
      filter: params.filter,
      touch: params.touch,
    });
  }

  if (backend === 'full-text') {
    const fullTextCandidateLimit =
      rerank === 'bm25' ? Math.max(limit * 10, 100) : limit;
    const fullTextCandidates = recallSemanticMemoriesByFts({
      sessionId: resolvedSessionId,
      normalizedQuery,
      limit: fullTextCandidateLimit,
      minConfidence,
      tokenizer,
      rankMode: 'source',
      filter: params.filter,
      touch: false,
    });
    const selected =
      rerank === 'bm25'
        ? rerankSemanticMemoriesWithFts({
            rows: fullTextCandidates,
            query: normalizedQuery,
            tokenizer,
          }).slice(0, limit)
        : fullTextCandidates;
    if (params.touch !== false) {
      touchSemanticMemoryRows(selected);
    }
    return selected;
  }

  const cosineCandidateLimit = Math.max(limit * 10, 100);
  const cosineCandidates = queryEmbedding
    ? recallSemanticMemoriesByVector({
        sessionId: resolvedSessionId,
        queryEmbedding,
        limit:
          backend === 'hybrid' || rerank === 'bm25'
            ? cosineCandidateLimit
            : limit,
        minConfidence,
        filter: params.filter,
        touch: false,
      })
    : recallSemanticMemoriesByLike({
        sessionId: resolvedSessionId,
        normalizedQuery,
        queryTerms,
        limit:
          backend === 'hybrid' || rerank === 'bm25'
            ? Math.max(limit * 8, 50)
            : limit,
        minConfidence,
        filter: params.filter,
        touch: false,
      });

  if (backend === 'hybrid') {
    const fullTextCandidates = recallSemanticMemoriesByFts({
      sessionId: resolvedSessionId,
      normalizedQuery,
      limit: cosineCandidateLimit,
      minConfidence,
      tokenizer,
      rankMode: 'source',
      filter: params.filter,
      touch: false,
    });
    const fused = fuseHybridSemanticMemories({
      cosineRows: cosineCandidates,
      fullTextRows: fullTextCandidates,
    });
    const selected =
      rerank === 'bm25'
        ? rerankSemanticMemoriesWithFts({
            rows: fused,
            query: normalizedQuery,
            tokenizer,
          }).slice(0, limit)
        : fused.slice(0, limit);
    if (params.touch !== false) {
      touchSemanticMemoryRows(selected);
    }
    return selected;
  }

  if (rerank === 'bm25') {
    const reranked = rerankSemanticMemoriesWithFts({
      rows: cosineCandidates,
      query: normalizedQuery,
      tokenizer,
    }).slice(0, limit);
    if (params.touch !== false) {
      touchSemanticMemoryRows(reranked);
    }
    return reranked;
  }

  if (params.touch !== false) {
    touchSemanticMemoryRows(cosineCandidates);
  }
  return cosineCandidates;
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
  const cutoffRow = queryOne<{ id: number }, [string, number]>(
    db,
    'SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?',
    sessionId,
    keep - 1,
  );
  if (!cutoffRow) return null;

  const older = queryAll<StoredMessage, [string, number]>(
    db,
    'SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id ASC',
    sessionId,
    cutoffRow.id,
  );
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

export function deleteMessagesByIds(
  sessionId: string,
  messageIds: number[],
): number {
  const ids = Array.from(
    new Set(
      messageIds
        .map((value) => Math.floor(value))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  );
  if (ids.length === 0) return 0;

  const chunkSize = 900;
  const updateSessionCounts = db.prepare(
    "UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?), last_active = datetime('now') WHERE id = ?",
  );
  const transaction = db.transaction((rowIds: number[]): number => {
    let deleted = 0;
    for (let index = 0; index < rowIds.length; index += chunkSize) {
      const chunk = rowIds.slice(index, index + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const result = db
        .prepare(
          `DELETE FROM messages
           WHERE session_id = ?
             AND id IN (${placeholders})`,
        )
        .run(sessionId, ...chunk);
      deleted += result.changes;
    }

    updateSessionCounts.run(sessionId, sessionId);
    return deleted;
  });

  return transaction(ids);
}

export function updateSessionSummary(sessionId: string, summary: string): void {
  const normalized = summary.trim();
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  db.prepare(
    "UPDATE sessions SET session_summary = ?, summary_updated_at = datetime('now'), compaction_count = compaction_count + 1 WHERE id = ?",
  ).run(normalized || null, resolvedSessionId);
}

export function markSessionMemoryFlush(sessionId: string): void {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  db.prepare(
    "UPDATE sessions SET memory_flush_at = datetime('now') WHERE id = ?",
  ).run(resolvedSessionId);
}

export function createTask(
  sessionId: string,
  channelId: string,
  cronExpr: string,
  prompt: string,
  runAt?: string,
  everyMs?: number,
): number {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const result = db
    .prepare(
      'INSERT INTO tasks (session_id, channel_id, cron_expr, prompt, run_at, every_ms) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      resolvedSessionId,
      channelId,
      cronExpr,
      prompt,
      runAt || null,
      everyMs || null,
    );
  return result.lastInsertRowid as number;
}

export function getTasksForSession(sessionId: string): ScheduledTask[] {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  return queryAll<ScheduledTask, [string]>(
    db,
    'SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC',
    resolvedSessionId,
  );
}

export function getAllTasks(): ScheduledTask[] {
  return queryAll<ScheduledTask>(
    db,
    'SELECT * FROM tasks ORDER BY created_at DESC',
  );
}

export function getAllEnabledTasks(): ScheduledTask[] {
  return queryAll<ScheduledTask>(db, 'SELECT * FROM tasks WHERE enabled = 1');
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
  const row = queryOne<Pick<ScheduledTask, 'consecutive_errors'>, [number]>(
    db,
    'SELECT consecutive_errors FROM tasks WHERE id = ?',
    taskId,
  );
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

function parseSkillMetricsJson(raw: string | null): SkillHealthMetrics | null {
  const normalized = raw?.trim() || '';
  if (!normalized) return null;
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as SkillHealthMetrics;
  } catch {
    return null;
  }
}

function serializeSkillMetricsJson(
  metrics: SkillHealthMetrics | null | undefined,
): string | null {
  if (!metrics) return null;
  try {
    return JSON.stringify(metrics);
  } catch {
    return null;
  }
}

function normalizeSkillOutcome(
  value: string | null | undefined,
): SkillExecutionOutcome {
  if (value === 'success' || value === 'failure' || value === 'partial') {
    return value;
  }
  return 'failure';
}

function normalizeSkillErrorCategoryValue(
  value: string | null | undefined,
): SkillErrorCategory | null {
  if (
    value === 'tool_error' ||
    value === 'timeout' ||
    value === 'user_abort' ||
    value === 'model_error' ||
    value === 'env_changed' ||
    value === 'unknown'
  ) {
    return value;
  }
  return null;
}

function normalizeSkillFeedbackSentimentValue(
  value: string | null | undefined,
): SkillFeedbackSentiment | null {
  if (value === 'positive' || value === 'negative' || value === 'neutral') {
    return value;
  }
  return null;
}

function normalizeSkillAmendmentStatusValue(
  value: string | null | undefined,
): SkillAmendmentStatus {
  if (
    value === 'staged' ||
    value === 'applied' ||
    value === 'rolled_back' ||
    value === 'rejected'
  ) {
    return value;
  }
  return 'staged';
}

function normalizeSkillGuardVerdictValue(
  value: string | null | undefined,
): SkillGuardVerdict {
  if (value === 'safe' || value === 'caution' || value === 'dangerous') {
    return value;
  }
  return 'caution';
}

function mapSkillObservationRow(row: SkillObservationRow): SkillObservation {
  return {
    id: Math.floor(row.id),
    skill_name: row.skill_name,
    coworker_id: row.coworker_id,
    session_id: row.session_id,
    run_id: row.run_id,
    outcome: normalizeSkillOutcome(row.outcome),
    error_category: normalizeSkillErrorCategoryValue(row.error_category),
    error_detail: row.error_detail,
    tool_calls_attempted: Math.max(
      0,
      Math.floor(row.tool_calls_attempted || 0),
    ),
    tool_calls_failed: Math.max(0, Math.floor(row.tool_calls_failed || 0)),
    duration_ms: Math.max(0, Math.floor(row.duration_ms || 0)),
    user_feedback: row.user_feedback,
    feedback_sentiment: normalizeSkillFeedbackSentimentValue(
      row.feedback_sentiment,
    ),
    created_at: row.created_at,
  };
}

function mapSkillAmendmentRow(row: SkillAmendmentRow): SkillAmendment {
  return {
    id: Math.floor(row.id),
    skill_name: row.skill_name,
    skill_file_path: row.skill_file_path,
    version: Math.max(1, Math.floor(row.version || 1)),
    previous_version:
      typeof row.previous_version === 'number'
        ? Math.floor(row.previous_version)
        : null,
    status: normalizeSkillAmendmentStatusValue(row.status),
    original_content: row.original_content,
    proposed_content: row.proposed_content,
    original_content_hash: row.original_content_hash,
    proposed_content_hash: row.proposed_content_hash,
    rationale: row.rationale,
    diff_summary: row.diff_summary,
    proposed_by: row.proposed_by,
    reviewed_by: row.reviewed_by,
    guard_verdict: normalizeSkillGuardVerdictValue(row.guard_verdict),
    guard_findings_count: Math.max(
      0,
      Math.floor(row.guard_findings_count || 0),
    ),
    metrics_at_proposal: parseSkillMetricsJson(row.metrics_at_proposal),
    metrics_post_apply: parseSkillMetricsJson(row.metrics_post_apply),
    runs_since_apply: Math.max(0, Math.floor(row.runs_since_apply || 0)),
    created_at: row.created_at,
    updated_at: row.updated_at,
    applied_at: row.applied_at,
    rolled_back_at: row.rolled_back_at,
    rejected_at: row.rejected_at,
  };
}

function mapSkillObservationSummaries(params: {
  summaryRows: SkillObservationSummaryRow[];
  clusterRows: SkillObservationErrorClusterRow[];
}): SkillObservationSummary[] {
  const clusterMap = new Map<
    string,
    Array<{
      category: SkillErrorCategory;
      count: number;
      sample_detail?: string | null;
    }>
  >();
  for (const row of params.clusterRows) {
    const skillName = row.skill_name.trim();
    if (!skillName) continue;
    const category =
      normalizeSkillErrorCategoryValue(row.error_category) || 'unknown';
    const existing = clusterMap.get(skillName) || [];
    existing.push({
      category,
      count: Math.max(0, Math.floor(row.count || 0)),
      sample_detail: row.sample_detail,
    });
    clusterMap.set(skillName, existing);
  }

  return params.summaryRows.map((row) => ({
    skill_name: row.skill_name,
    total_executions: Math.max(0, Math.floor(row.total_executions || 0)),
    success_count: Math.max(0, Math.floor(row.success_count || 0)),
    failure_count: Math.max(0, Math.floor(row.failure_count || 0)),
    partial_count: Math.max(0, Math.floor(row.partial_count || 0)),
    avg_duration_ms: Math.max(0, Number(row.avg_duration_ms || 0)),
    tool_calls_attempted: Math.max(
      0,
      Math.floor(row.tool_calls_attempted || 0),
    ),
    tool_calls_failed: Math.max(0, Math.floor(row.tool_calls_failed || 0)),
    positive_feedback_count: Math.max(
      0,
      Math.floor(row.positive_feedback_count || 0),
    ),
    negative_feedback_count: Math.max(
      0,
      Math.floor(row.negative_feedback_count || 0),
    ),
    error_clusters: clusterMap.get(row.skill_name) || [],
    last_observed_at: row.last_observed_at,
  }));
}

export function recordSkillObservation(input: {
  skillName: string;
  sessionId: string;
  runId: string;
  coworkerId?: string | null;
  outcome: SkillExecutionOutcome;
  errorCategory?: SkillErrorCategory | null;
  errorDetail?: string | null;
  toolCallsAttempted?: number;
  toolCallsFailed?: number;
  durationMs?: number;
}): SkillObservation {
  const result = db
    .prepare(
      `INSERT INTO skill_observations (
         skill_name,
         coworker_id,
         session_id,
         run_id,
         outcome,
         error_category,
         error_detail,
         tool_calls_attempted,
         tool_calls_failed,
         duration_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.skillName.trim(),
      input.coworkerId?.trim() || null,
      input.sessionId.trim(),
      input.runId.trim(),
      input.outcome,
      input.errorCategory || null,
      input.errorDetail?.trim() || null,
      Math.max(0, Math.floor(input.toolCallsAttempted || 0)),
      Math.max(0, Math.floor(input.toolCallsFailed || 0)),
      Math.max(0, Math.floor(input.durationMs || 0)),
    );

  const row = queryOne<SkillObservationRow, [number | bigint]>(
    db,
    'SELECT * FROM skill_observations WHERE id = ?',
    result.lastInsertRowid,
  );
  if (!row) {
    throw new Error('Failed to read persisted skill observation.');
  }
  return mapSkillObservationRow(row);
}

export function getSkillObservations(params?: {
  skillName?: string;
  coworkerId?: string;
  sessionId?: string;
  runId?: string;
  createdAfter?: string | null;
  limit?: number;
}): SkillObservation[] {
  const clauses: string[] = [];
  const args: Array<string | number> = [];
  const skillName = params?.skillName?.trim() || '';
  const sessionId = params?.sessionId?.trim() || '';
  const coworkerId = params?.coworkerId?.trim() || '';
  const runId = params?.runId?.trim() || '';
  const createdAfter = params?.createdAfter?.trim() || '';
  if (skillName) {
    clauses.push('skill_name = ?');
    args.push(skillName);
  }
  if (sessionId) {
    clauses.push('session_id = ?');
    args.push(sessionId);
  }
  if (coworkerId) {
    clauses.push('coworker_id = ?');
    args.push(coworkerId);
  }
  if (runId) {
    clauses.push('run_id = ?');
    args.push(runId);
  }
  if (createdAfter) {
    clauses.push('created_at >= ?');
    args.push(createdAfter);
  }
  const whereClause =
    clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(params?.limit || 100, 1_000));
  return queryAll<SkillObservationRow, Array<string | number>>(
    db,
    `SELECT *
     FROM skill_observations
     ${whereClause}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    ...args,
    limit,
  ).map(mapSkillObservationRow);
}

export function getObservedSkillNames(params?: {
  createdAfter?: string | null;
}): string[] {
  const createdAfter = params?.createdAfter?.trim() || '';
  const rows = createdAfter
    ? queryAll<{ skill_name: string }, [string]>(
        db,
        `SELECT DISTINCT skill_name
         FROM skill_observations
         WHERE created_at >= ?
         ORDER BY skill_name ASC`,
        createdAfter,
      )
    : queryAll<{ skill_name: string }>(
        db,
        `SELECT DISTINCT skill_name
         FROM skill_observations
         ORDER BY skill_name ASC`,
      );
  return rows.map((row) => row.skill_name.trim()).filter(Boolean);
}

export function pruneSkillObservations(params: {
  createdBefore: string;
}): number {
  const createdBefore = params.createdBefore.trim();
  if (!createdBefore) return 0;
  const result = db
    .prepare(
      `DELETE FROM skill_observations
       WHERE created_at < ?`,
    )
    .run(createdBefore);
  return Math.max(0, Number(result.changes || 0));
}

export function getSkillObservationSummary(params?: {
  skillName?: string;
  coworkerId?: string;
  createdAfter?: string | null;
}): SkillObservationSummary[] {
  ensureDatabaseReady();
  const clauses: string[] = [];
  const args: Array<string | number> = [];
  const skillName = params?.skillName?.trim() || '';
  const coworkerId = params?.coworkerId?.trim() || '';
  const createdAfter = params?.createdAfter?.trim() || '';
  if (skillName) {
    clauses.push('skill_name = ?');
    args.push(skillName);
  }
  if (createdAfter) {
    clauses.push('created_at >= ?');
    args.push(createdAfter);
  }
  if (coworkerId) {
    clauses.push('coworker_id = ?');
    args.push(coworkerId);
  }
  const whereClause =
    clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const summaryRows = queryAll<
    SkillObservationSummaryRow,
    Array<string | number>
  >(
    db,
    `SELECT
       skill_name,
       COUNT(*) AS total_executions,
       SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success_count,
       SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failure_count,
       SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) AS partial_count,
       AVG(duration_ms) AS avg_duration_ms,
       COALESCE(SUM(tool_calls_attempted), 0) AS tool_calls_attempted,
       COALESCE(SUM(tool_calls_failed), 0) AS tool_calls_failed,
       SUM(CASE WHEN feedback_sentiment = 'positive' THEN 1 ELSE 0 END) AS positive_feedback_count,
       SUM(CASE WHEN feedback_sentiment = 'negative' THEN 1 ELSE 0 END) AS negative_feedback_count,
       MAX(created_at) AS last_observed_at
     FROM skill_observations
     ${whereClause}
     GROUP BY skill_name
     ORDER BY skill_name ASC`,
    ...args,
  );

  if (summaryRows.length === 0) return [];

  const clusterClauses = [...clauses, "outcome != 'success'"];
  const clusterWhereClause =
    clusterClauses.length > 0 ? `WHERE ${clusterClauses.join(' AND ')}` : '';
  const clusterRows = queryAll<
    SkillObservationErrorClusterRow,
    Array<string | number>
  >(
    db,
    `SELECT
       skill_name,
       COALESCE(NULLIF(TRIM(error_category), ''), 'unknown') AS error_category,
       COUNT(*) AS count,
       MIN(error_detail) AS sample_detail
     FROM skill_observations
     ${clusterWhereClause}
     GROUP BY skill_name, COALESCE(NULLIF(TRIM(error_category), ''), 'unknown')
     ORDER BY skill_name ASC, count DESC`,
    ...args,
  );

  return mapSkillObservationSummaries({
    summaryRows,
    clusterRows,
  });
}

interface CoworkerSkillScoreAggregate {
  coworker_id: string;
  skill_id: string;
  success_count: number;
  failure_count: number;
  partial_count: number;
  avg_duration_ms: number;
  last_run_at: string | null;
  positive_feedback_count: number;
  negative_feedback_count: number;
  tool_breakage_count: number;
}

function scoreCoworkerSkill(row: {
  total_executions: number;
  success_rate: number;
  tool_breakage_rate: number;
  positive_feedback_count: number;
  negative_feedback_count: number;
}): number {
  const successPoints = row.success_rate * 70;
  const feedbackBalance =
    row.positive_feedback_count - row.negative_feedback_count;
  const feedbackPoints = Math.max(-15, Math.min(15, feedbackBalance * 5));
  const reliabilityPoints = Math.max(0, 15 - row.tool_breakage_rate * 15);
  const experiencePoints = Math.min(
    10,
    Math.log10(row.total_executions + 1) * 10,
  );
  return Math.max(
    0,
    Math.min(
      100,
      Math.round(
        successPoints + feedbackPoints + reliabilityPoints + experiencePoints,
      ),
    ),
  );
}

function mapCoworkerSkillScoreRow(
  row: CoworkerSkillScoreAggregate,
): CoworkerSkillScore {
  const successCount = Math.max(0, Math.floor(row.success_count || 0));
  const failureCount = Math.max(0, Math.floor(row.failure_count || 0));
  const partialCount = Math.max(0, Math.floor(row.partial_count || 0));
  const totalExecutions = successCount + failureCount + partialCount;
  const toolBreakageCount = Math.max(
    0,
    Math.floor(row.tool_breakage_count || 0),
  );
  const normalized = {
    coworker_id: row.coworker_id,
    skill_id: row.skill_id,
    skill_name: row.skill_id,
    total_executions: totalExecutions,
    success_count: successCount,
    failure_count: failureCount,
    partial_count: partialCount,
    success_rate: totalExecutions > 0 ? successCount / totalExecutions : 0,
    avg_duration_ms: Math.max(0, Number(row.avg_duration_ms || 0)),
    tool_breakage_rate:
      totalExecutions > 0 ? toolBreakageCount / totalExecutions : 0,
    positive_feedback_count: Math.max(
      0,
      Math.floor(row.positive_feedback_count || 0),
    ),
    negative_feedback_count: Math.max(
      0,
      Math.floor(row.negative_feedback_count || 0),
    ),
    last_run_at: row.last_run_at,
    last_observed_at: row.last_run_at,
  };
  const score = scoreCoworkerSkill(normalized);
  return {
    ...normalized,
    quality_score: score,
    score,
  };
}

export function recomputeCoworkerSkillScore(input: {
  coworkerId: string;
  skillId: string;
}): CoworkerSkillScore | null {
  ensureDatabaseReady();
  const coworkerId = input.coworkerId.trim();
  const skillId = input.skillId.trim();
  if (!coworkerId || !skillId) return null;

  const aggregate = queryOne<CoworkerSkillScoreAggregate, [string, string]>(
    db,
    `SELECT
       coworker_id,
       skill_name AS skill_id,
       SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success_count,
       SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failure_count,
       SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) AS partial_count,
       COALESCE(AVG(duration_ms), 0) AS avg_duration_ms,
       MAX(created_at) AS last_run_at,
       SUM(CASE WHEN feedback_sentiment = 'positive' THEN 1 ELSE 0 END) AS positive_feedback_count,
       SUM(CASE WHEN feedback_sentiment = 'negative' THEN 1 ELSE 0 END) AS negative_feedback_count,
       SUM(CASE WHEN tool_calls_failed > 0 THEN 1 ELSE 0 END) AS tool_breakage_count
     FROM skill_observations
     WHERE coworker_id = ? AND skill_name = ?
     GROUP BY coworker_id, skill_name`,
    coworkerId,
    skillId,
  );

  if (!aggregate) {
    db.prepare(
      `DELETE FROM coworker_skill_scores
       WHERE coworker_id = ? AND skill_id = ?`,
    ).run(coworkerId, skillId);
    return null;
  }

  const score = mapCoworkerSkillScoreRow(aggregate);
  db.prepare(
    `INSERT INTO coworker_skill_scores (
       coworker_id,
       skill_id,
       success_count,
       failure_count,
       partial_count,
       avg_duration_ms,
       last_run_at,
       quality_score,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(coworker_id, skill_id) DO UPDATE SET
       success_count = excluded.success_count,
       failure_count = excluded.failure_count,
       partial_count = excluded.partial_count,
       avg_duration_ms = excluded.avg_duration_ms,
       last_run_at = excluded.last_run_at,
       quality_score = excluded.quality_score,
       updated_at = excluded.updated_at`,
  ).run(
    score.coworker_id,
    score.skill_id,
    score.success_count,
    score.failure_count,
    score.partial_count,
    score.avg_duration_ms,
    score.last_run_at,
    score.quality_score,
  );
  return score;
}

export function getCoworkerSkillScores(params?: {
  coworkerId?: string;
  skillName?: string;
  createdAfter?: string | null;
  limit?: number;
}): CoworkerSkillScore[] {
  ensureDatabaseReady();
  const clauses = [
    'score.coworker_id IS NOT NULL',
    "TRIM(score.coworker_id) != ''",
  ];
  const args: Array<string | number> = [];
  const coworkerId = params?.coworkerId?.trim() || '';
  const skillName = params?.skillName?.trim() || '';
  const createdAfter = params?.createdAfter?.trim() || '';
  if (coworkerId) {
    clauses.push('score.coworker_id = ?');
    args.push(coworkerId);
  }
  if (skillName) {
    clauses.push('score.skill_id = ?');
    args.push(skillName);
  }
  if (createdAfter) {
    clauses.push('score.last_run_at >= ?');
    args.push(createdAfter);
  }
  const limit = Math.max(1, Math.min(params?.limit || 500, 2_000));
  const rows = queryAll<CoworkerSkillScoreAggregate, Array<string | number>>(
    db,
    `SELECT
       score.coworker_id,
       score.skill_id,
       score.success_count,
       score.failure_count,
       score.partial_count,
       score.avg_duration_ms,
       score.last_run_at,
       COALESCE(feedback.positive_feedback_count, 0) AS positive_feedback_count,
       COALESCE(feedback.negative_feedback_count, 0) AS negative_feedback_count,
       COALESCE(feedback.tool_breakage_count, 0) AS tool_breakage_count
     FROM coworker_skill_scores score
     LEFT JOIN (
       SELECT
         coworker_id,
         skill_name,
         SUM(CASE WHEN feedback_sentiment = 'positive' THEN 1 ELSE 0 END) AS positive_feedback_count,
         SUM(CASE WHEN feedback_sentiment = 'negative' THEN 1 ELSE 0 END) AS negative_feedback_count,
         SUM(CASE WHEN tool_calls_failed > 0 THEN 1 ELSE 0 END) AS tool_breakage_count
       FROM skill_observations
       GROUP BY coworker_id, skill_name
     ) feedback
       ON feedback.coworker_id = score.coworker_id
      AND feedback.skill_name = score.skill_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY COALESCE(score.quality_score, 0) DESC, score.last_run_at DESC, score.coworker_id ASC, score.skill_id ASC
     LIMIT ?`,
    ...args,
    limit,
  );

  return rows
    .map(mapCoworkerSkillScoreRow)
    .sort(
      (left, right) =>
        right.quality_score - left.quality_score ||
        right.total_executions - left.total_executions ||
        left.coworker_id.localeCompare(right.coworker_id) ||
        left.skill_id.localeCompare(right.skill_id),
    );
}

export function attachFeedbackToObservation(input: {
  sessionId: string;
  feedback: string;
  sentiment: SkillFeedbackSentiment;
}): SkillObservation | null {
  const sessionId = input.sessionId.trim();
  if (!sessionId) return null;
  const target = queryOne<{ id: number }, [string]>(
    db,
    `SELECT id
     FROM skill_observations
     WHERE session_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    sessionId,
  );
  if (!target) return null;

  db.prepare(
    `UPDATE skill_observations
     SET user_feedback = ?,
         feedback_sentiment = ?
     WHERE id = ?`,
  ).run(input.feedback.trim() || null, input.sentiment, target.id);

  const row = queryOne<SkillObservationRow, [number]>(
    db,
    'SELECT * FROM skill_observations WHERE id = ?',
    target.id,
  );
  if (!row) {
    throw new Error('Failed to read updated skill observation.');
  }
  return mapSkillObservationRow(row);
}

export function createSkillAmendment(input: {
  skillName: string;
  skillFilePath: string;
  previousVersion?: number | null;
  status?: SkillAmendmentStatus;
  originalContent: string;
  proposedContent: string;
  originalContentHash: string;
  proposedContentHash: string;
  rationale: string;
  diffSummary: string;
  proposedBy: string;
  reviewedBy?: string | null;
  guardVerdict: SkillGuardVerdict;
  guardFindingsCount?: number;
  metricsAtProposal?: SkillHealthMetrics | null;
  metricsPostApply?: SkillHealthMetrics | null;
  runsSinceApply?: number;
}): SkillAmendment {
  const skillName = input.skillName.trim();
  const latest = queryOne<Pick<SkillAmendment, 'version'>, [string]>(
    db,
    `SELECT version
     FROM skill_amendments
     WHERE skill_name = ?
     ORDER BY version DESC
     LIMIT 1`,
    skillName,
  );
  const version = Math.max(1, Math.floor((latest?.version || 0) + 1));
  const result = db
    .prepare(
      `INSERT INTO skill_amendments (
         skill_name,
         skill_file_path,
         version,
         previous_version,
         status,
         original_content,
         proposed_content,
         original_content_hash,
         proposed_content_hash,
         rationale,
         diff_summary,
         proposed_by,
         reviewed_by,
         guard_verdict,
         guard_findings_count,
         metrics_at_proposal,
         metrics_post_apply,
         runs_since_apply
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      skillName,
      input.skillFilePath,
      version,
      typeof input.previousVersion === 'number'
        ? Math.floor(input.previousVersion)
        : null,
      input.status || 'staged',
      input.originalContent,
      input.proposedContent,
      input.originalContentHash,
      input.proposedContentHash,
      input.rationale.trim(),
      input.diffSummary.trim(),
      input.proposedBy.trim(),
      input.reviewedBy?.trim() || null,
      input.guardVerdict,
      Math.max(0, Math.floor(input.guardFindingsCount || 0)),
      serializeSkillMetricsJson(input.metricsAtProposal),
      serializeSkillMetricsJson(input.metricsPostApply),
      Math.max(0, Math.floor(input.runsSinceApply || 0)),
    );

  const row = queryOne<SkillAmendmentRow, [number | bigint]>(
    db,
    'SELECT * FROM skill_amendments WHERE id = ?',
    result.lastInsertRowid,
  );
  if (!row) {
    throw new Error('Failed to read persisted skill amendment.');
  }
  return mapSkillAmendmentRow(row);
}

export function getSkillAmendmentById(
  amendmentId: number,
): SkillAmendment | null {
  const row = queryOne<SkillAmendmentRow, [number]>(
    db,
    'SELECT * FROM skill_amendments WHERE id = ?',
    Math.floor(amendmentId),
  );
  return row ? mapSkillAmendmentRow(row) : null;
}

export function getLatestSkillAmendment(params: {
  skillName: string;
  status?: SkillAmendmentStatus | SkillAmendmentStatus[];
}): SkillAmendment | null {
  const skillName = params.skillName.trim();
  if (!skillName) return null;
  const statuses = Array.isArray(params.status)
    ? params.status
    : params.status
      ? [params.status]
      : [];
  const clauses = ['skill_name = ?'];
  const args: Array<string | number> = [skillName];
  if (statuses.length > 0) {
    clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    args.push(...statuses);
  }
  const row = queryOne<SkillAmendmentRow, Array<string | number>>(
    db,
    `SELECT *
     FROM skill_amendments
     WHERE ${clauses.join(' AND ')}
     ORDER BY version DESC, id DESC
     LIMIT 1`,
    ...args,
  );
  return row ? mapSkillAmendmentRow(row) : null;
}

export function getStagedAmendments(): SkillAmendment[] {
  return queryAll<SkillAmendmentRow>(
    db,
    `SELECT *
     FROM skill_amendments
     WHERE status = 'staged'
     ORDER BY created_at DESC, id DESC`,
  ).map(mapSkillAmendmentRow);
}

export function updateAmendmentStatus(input: {
  amendmentId: number;
  status: SkillAmendmentStatus;
  reviewedBy?: string | null;
  metricsPostApply?: SkillHealthMetrics | null;
  resetRunsSinceApply?: boolean;
}): SkillAmendment | null {
  const amendmentId = Math.floor(input.amendmentId);
  if (!Number.isFinite(amendmentId) || amendmentId <= 0) return null;

  const reviewedBy = input.reviewedBy?.trim() || null;
  const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  const extraAssignments: string[] = [];
  if (reviewedBy) {
    extraAssignments.push('reviewed_by = ?');
  }
  if (typeof input.metricsPostApply !== 'undefined') {
    extraAssignments.push('metrics_post_apply = ?');
  }
  if (input.status === 'applied') {
    extraAssignments.push(`applied_at = COALESCE(applied_at, ${nowSql})`);
    if (input.resetRunsSinceApply !== false) {
      extraAssignments.push('runs_since_apply = 0');
    }
  } else if (input.status === 'rolled_back') {
    extraAssignments.push(`rolled_back_at = ${nowSql}`);
  } else if (input.status === 'rejected') {
    extraAssignments.push(`rejected_at = ${nowSql}`);
  }

  const sql = `
    UPDATE skill_amendments
    SET status = ?,
        updated_at = ${nowSql}
        ${extraAssignments.length > 0 ? `, ${extraAssignments.join(', ')}` : ''}
    WHERE id = ?
  `;
  const args: Array<string | number | null> = [input.status];
  if (reviewedBy) args.push(reviewedBy);
  if (typeof input.metricsPostApply !== 'undefined') {
    args.push(serializeSkillMetricsJson(input.metricsPostApply));
  }
  args.push(amendmentId);
  db.prepare(sql).run(...args);
  return getSkillAmendmentById(amendmentId);
}

export function incrementAmendmentRunCount(
  skillName: string,
): SkillAmendment | null {
  const target = getLatestSkillAmendment({
    skillName,
    status: 'applied',
  });
  if (!target) return null;
  db.prepare(
    `UPDATE skill_amendments
     SET runs_since_apply = runs_since_apply + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  ).run(target.id);
  return getSkillAmendmentById(target.id);
}

export function getAmendmentHistory(skillName: string): SkillAmendment[] {
  const normalized = skillName.trim();
  if (!normalized) return [];
  return queryAll<SkillAmendmentRow, [string]>(
    db,
    `SELECT *
     FROM skill_amendments
     WHERE skill_name = ?
     ORDER BY version DESC, id DESC`,
    normalized,
  ).map(mapSkillAmendmentRow);
}

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
  return queryAll<AuditEntry, [number]>(
    db,
    'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?',
    limit,
  );
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

  const payload = record.event;
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
  ensureDatabaseReady();
  const bounded = Math.max(1, Math.min(limit, 1_000));
  return queryAll<StructuredAuditEntry, [number]>(
    db,
    `SELECT ${STRUCTURED_AUDIT_SELECT_COLUMNS}
     FROM audit_events
     ORDER BY id DESC
     LIMIT ?`,
    bounded,
  );
}

function queryStructuredAuditEntries(params?: {
  sessionId?: string;
  eventType?: string;
  query?: string;
  limit?: number;
  maxLimit?: number;
  orderBy?: 'id' | 'seq';
  sortDirection?: 'ASC' | 'DESC';
}): StructuredAuditEntry[] {
  const sessionId = String(params?.sessionId || '').trim();
  const eventType = String(params?.eventType || '').trim();
  const query = String(params?.query || '').trim();
  const orderBy = params?.orderBy === 'seq' ? 'seq' : 'id';
  const sortDirection = params?.sortDirection === 'ASC' ? 'ASC' : 'DESC';
  ensureDatabaseReady();

  const clauses: string[] = [];
  const values: Array<string | number> = [];

  if (sessionId) {
    clauses.push('session_id = ?');
    values.push(sessionId);
  }
  if (eventType) {
    clauses.push('event_type = ?');
    values.push(eventType);
  }
  if (query) {
    const like = `%${query}%`;
    clauses.push(
      '(event_type LIKE ? OR payload LIKE ? OR session_id LIKE ? OR run_id LIKE ?)',
    );
    values.push(like, like, like, like);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const maxLimit = Math.max(1, params?.maxLimit ?? 200);
  const limit =
    params?.limit == null
      ? null
      : Math.max(1, Math.min(params.limit, maxLimit));
  const sql = `
    SELECT ${STRUCTURED_AUDIT_SELECT_COLUMNS}
    FROM audit_events
    ${where}
    ORDER BY ${orderBy} ${sortDirection}
    ${limit == null ? '' : 'LIMIT ?'}
  `;

  if (limit == null) {
    return queryAll<StructuredAuditEntry, Array<string | number>>(
      db,
      sql,
      ...values,
    );
  }

  return queryAll<StructuredAuditEntry, Array<string | number>>(
    db,
    sql,
    ...values,
    limit,
  );
}

export function getRecentStructuredAuditForSession(
  sessionId: string,
  limit = 20,
): StructuredAuditEntry[] {
  return queryStructuredAuditEntries({
    sessionId,
    limit,
    orderBy: 'seq',
    sortDirection: 'DESC',
  });
}

export function listStructuredAuditSessionIdsByPrefix(
  prefix: string,
  limit = 64,
): string[] {
  ensureDatabaseReady();
  const normalizedPrefix = String(prefix || '').trim();
  if (!normalizedPrefix) return [];
  const normalizedLimit = Math.max(1, Math.min(512, Math.trunc(limit || 64)));
  const rows = queryAll<{ sessionId: string }, [string, number]>(
    db,
    `SELECT session_id AS sessionId
     FROM audit_events
     WHERE session_id LIKE ? || '%'
     GROUP BY session_id
     ORDER BY MAX(id) DESC
     LIMIT ?`,
    normalizedPrefix,
    normalizedLimit,
  );
  return rows.map((row) => String(row.sessionId || '').trim()).filter(Boolean);
}

export function getStructuredAuditForSession(
  sessionId: string,
): StructuredAuditEntry[] {
  const rows = queryStructuredAuditEntries({
    sessionId,
    limit: STRUCTURED_AUDIT_SESSION_LIMIT + 1,
    maxLimit: STRUCTURED_AUDIT_SESSION_LIMIT + 1,
    orderBy: 'seq',
    sortDirection: 'ASC',
  });
  if (rows.length <= STRUCTURED_AUDIT_SESSION_LIMIT) {
    return rows;
  }
  logger.warn(
    {
      sessionId,
      limit: STRUCTURED_AUDIT_SESSION_LIMIT,
      returnedRows: rows.length,
    },
    'Structured audit query hit safety cap; returning truncated results',
  );
  return rows.slice(0, STRUCTURED_AUDIT_SESSION_LIMIT);
}

export function listStructuredAuditEntries(params?: {
  sessionId?: string;
  eventType?: string;
  query?: string;
  limit?: number;
}): StructuredAuditEntry[] {
  return queryStructuredAuditEntries({
    sessionId: params?.sessionId,
    eventType: params?.eventType,
    query: params?.query,
    limit: params?.limit ?? 50,
    orderBy: 'id',
    sortDirection: 'DESC',
  });
}

export function getStructuredAuditAfterId(
  afterId: number,
  limit = 200,
): StructuredAuditEntry[] {
  const boundedAfterId = Math.max(0, Math.floor(afterId));
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 5_000));
  return queryAll<StructuredAuditEntry, [number, number]>(
    db,
    `SELECT ${STRUCTURED_AUDIT_SELECT_COLUMNS}
     FROM audit_events
     WHERE id > ?
     ORDER BY id ASC
     LIMIT ?`,
    boundedAfterId,
    boundedLimit,
  );
}

export function searchStructuredAudit(
  query: string,
  limit = 20,
): StructuredAuditEntry[] {
  ensureDatabaseReady();
  const normalized = query.trim();
  if (!normalized) return [];
  const bounded = Math.max(1, Math.min(limit, 1_000));
  const like = `%${normalized}%`;
  return queryAll<
    StructuredAuditEntry,
    [string, string, string, string, number]
  >(
    db,
    `SELECT ${STRUCTURED_AUDIT_SELECT_COLUMNS}
     FROM audit_events
     WHERE event_type LIKE ?
       OR payload LIKE ?
       OR session_id LIKE ?
       OR run_id LIKE ?
     ORDER BY id DESC
     LIMIT ?`,
    like,
    like,
    like,
    like,
    bounded,
  );
}

export function getRecentApprovals(
  limit = 20,
  deniedOnly = false,
): ApprovalAuditEntry[] {
  const bounded = Math.max(1, Math.min(limit, 200));
  if (deniedOnly) {
    return queryAll<ApprovalAuditEntry, [number]>(
      db,
      'SELECT * FROM approvals WHERE approved = 0 ORDER BY id DESC LIMIT ?',
      bounded,
    );
  }
  return queryAll<ApprovalAuditEntry, [number]>(
    db,
    'SELECT * FROM approvals ORDER BY id DESC LIMIT ?',
    bounded,
  );
}

export function getObservabilityOffset(streamKey: string): number {
  const normalized = streamKey.trim();
  if (!normalized) return 0;
  const row = queryOne<{ last_event_id: number }, [string]>(
    db,
    'SELECT last_event_id FROM observability_offsets WHERE stream_key = ?',
    normalized,
  );
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
  const row = queryOne<{ token: string }, [string]>(
    db,
    'SELECT token FROM observability_ingest_tokens WHERE token_key = ?',
    normalized,
  );
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

  const countRow = queryOne<{ count: number }>(
    db,
    'SELECT COUNT(*) as count FROM proactive_message_queue',
  ) || { count: 0 };
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
  return queryAll<QueuedProactiveMessage, [number]>(
    db,
    'SELECT * FROM proactive_message_queue ORDER BY id ASC LIMIT ?',
    boundedLimit,
  );
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
      const rows = queryAll<QueuedProactiveMessage, [string, number]>(
        db,
        'SELECT * FROM proactive_message_queue WHERE channel_id = ? ORDER BY id ASC LIMIT ?',
        targetChannelId,
        maxRows,
      );
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
  const row = queryOne<{ count: number }>(
    db,
    'SELECT COUNT(*) as count FROM proactive_message_queue',
  ) || { count: 0 };
  return row.count;
}
