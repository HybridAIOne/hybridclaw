import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AgentConfig, AgentModelConfig } from '../agents/agent-types.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import type { AuditEventPayload, WireRecord } from '../audit/audit-trail.js';
import { DB_PATH } from '../config/config.js';
import { logger } from '../logger.js';
import {
  evaluateSessionExpiry,
  type SessionExpiryEvaluation,
  type SessionResetPolicy,
} from '../session/session-reset.js';
import type {
  SkillAmendment,
  SkillAmendmentStatus,
  SkillCogneeGuardVerdict,
  SkillErrorCategory,
  SkillExecutionOutcome,
  SkillFeedbackSentiment,
  SkillHealthMetrics,
  SkillObservation,
  SkillObservationSummary,
} from '../skills/skills-cognee-types.js';
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
  SessionShowMode,
  StoredMessage,
  StructuredAuditEntry,
  UsageAgentAggregate,
  UsageDailyAggregate,
  UsageModelAggregate,
  UsageSessionAggregate,
  UsageTotals,
  UsageWindow,
} from '../types.js';
import { KnowledgeEntityType, KnowledgeRelationType } from '../types.js';

let db: Database.Database;
let databaseInitialized = false;

const SCHEMA_VERSION = 9;

interface InitDatabaseOptions {
  quiet?: boolean;
  dbPath?: string;
}

interface TableInfoRow {
  name: string;
}

interface AgentRow {
  id: string;
  name: string | null;
  model: string | null;
  chatbot_id: string | null;
  enable_rag: number | null;
  workspace: string | null;
  created_at: string;
  updated_at: string;
}

interface SkillObservationRow {
  id: number;
  skill_name: string;
  session_id: string;
  run_id: string;
  outcome: string;
  error_category: string | null;
  error_detail: string | null;
  tool_calls_attempted: number;
  tool_calls_failed: number;
  duration_ms: number;
  user_feedback: string | null;
  feedback_sentiment: string | null;
  created_at: string;
}

interface SkillObservationSummaryRow {
  skill_name: string;
  total_executions: number;
  success_count: number;
  failure_count: number;
  partial_count: number;
  avg_duration_ms: number;
  tool_calls_attempted: number;
  tool_calls_failed: number;
  negative_feedback_count: number;
  last_observed_at: string | null;
}

interface SkillObservationErrorClusterRow {
  skill_name: string;
  error_category: string | null;
  count: number;
  sample_detail: string | null;
}

interface SkillAmendmentRow {
  id: number;
  skill_name: string;
  skill_file_path: string;
  version: number;
  previous_version: number | null;
  status: string;
  original_content: string;
  proposed_content: string;
  original_content_hash: string;
  proposed_content_hash: string;
  rationale: string;
  diff_summary: string;
  proposed_by: string;
  reviewed_by: string | null;
  guard_verdict: string;
  guard_findings_count: number;
  metrics_at_proposal: string | null;
  metrics_post_apply: string | null;
  runs_since_apply: number;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
  rolled_back_at: string | null;
  rejected_at: string | null;
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
  const rows = database
    .prepare(
      `SELECT agent_id, key, value, version, updated_at
       FROM kv_store
       WHERE agent_id IN (${placeholders})
       ORDER BY key ASC, updated_at DESC, version DESC, agent_id ASC`,
    )
    .all(...sourceAgentIds) as MemoryKvRow[];

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
      group.push(rows[index] as MemoryKvRow);
      index += 1;
    }
    if (!key || group.length === 0) continue;

    const winner = [...group].sort((left, right) => {
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
    })[0] as MemoryKvRow;

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
  const rows = database
    .prepare(
      `SELECT canonical_id, agent_id, user_id, messages, compaction_cursor, compacted_summary, message_count, created_at, updated_at
       FROM canonical_sessions
       WHERE agent_id IN (${placeholders})
       ORDER BY user_id ASC, created_at ASC, updated_at ASC, canonical_id ASC`,
    )
    .all(...sourceAgentIds) as CanonicalSessionRow[];

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
      group.push(rows[index] as CanonicalSessionRow);
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
        model TEXT,
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
  if (currentVersion < 5) migrateV5(database, opts);
  if (currentVersion < 6) migrateV6(database, opts);
  if (currentVersion < 7) migrateV7(database, opts);
  if (currentVersion < 8) migrateV8(database, opts);
  if (currentVersion < 9) migrateV9(database, opts);

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
  databaseInitialized = true;
  if (!quiet) logger.info({ path: dbPath }, 'Database initialized');
}

export function isDatabaseInitialized(): boolean {
  return databaseInitialized;
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

function mapAgentRow(row: AgentRow): AgentConfig {
  const name = row.name?.trim() || '';
  const model = parseAgentModelConfig(row.model);
  const chatbotId = row.chatbot_id?.trim() || '';
  const workspace = row.workspace?.trim() || '';
  return {
    id: row.id,
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(chatbotId ? { chatbotId } : {}),
    ...(workspace ? { workspace } : {}),
    ...(typeof row.enable_rag === 'number'
      ? { enableRag: row.enable_rag !== 0 }
      : {}),
  };
}

export function getAgentById(agentId: string): AgentConfig | null {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) return null;
  const row = db
    .prepare(
      `SELECT id, name, model, chatbot_id, enable_rag, workspace, created_at, updated_at
       FROM agents
       WHERE id = ?`,
    )
    .get(normalizedAgentId) as AgentRow | undefined;
  return row ? mapAgentRow(row) : null;
}

export function listAgents(): AgentConfig[] {
  const rows = db
    .prepare(
      `SELECT id, name, model, chatbot_id, enable_rag, workspace, created_at, updated_at
       FROM agents
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id ASC`,
    )
    .all(DEFAULT_AGENT_ID) as AgentRow[];
  return rows.map(mapAgentRow);
}

export function upsertAgent(agent: AgentConfig): AgentConfig {
  const normalizedId = agent.id.trim();
  if (!normalizedId) {
    throw new Error('Agent id is required.');
  }
  const normalizedName = agent.name?.trim() || null;
  const normalizedModel = serializeAgentModelConfig(agent.model);
  const normalizedChatbotId = agent.chatbotId?.trim() || null;
  const normalizedWorkspace = agent.workspace?.trim() || null;
  const enableRag =
    typeof agent.enableRag === 'boolean' ? (agent.enableRag ? 1 : 0) : null;
  db.prepare(
    `INSERT INTO agents (
       id,
       name,
       model,
       chatbot_id,
       enable_rag,
       workspace,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       model = excluded.model,
       chatbot_id = excluded.chatbot_id,
       enable_rag = excluded.enable_rag,
       workspace = excluded.workspace,
       updated_at = datetime('now')`,
  ).run(
    normalizedId,
    normalizedName,
    normalizedModel,
    normalizedChatbotId,
    enableRag,
    normalizedWorkspace,
  );
  return getAgentById(normalizedId) as AgentConfig;
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

export function getSessionUsageTotals(sessionId: string): UsageTotals {
  return getSessionUsageTotalsSince(sessionId, null);
}

export function getSessionUsageTotalsSince(
  sessionId: string,
  sinceTimestamp: string | null,
): UsageTotals {
  const normalizedSince =
    typeof sinceTimestamp === 'string' && sinceTimestamp.trim()
      ? sinceTimestamp.trim()
      : null;
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
       WHERE session_id = ?
         AND (? IS NULL OR timestamp >= ?)`,
    )
    .get(sessionId, normalizedSince, normalizedSince) as UsageTotals;

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
  const normalizedSince =
    typeof sinceTimestamp === 'string' && sinceTimestamp.trim()
      ? sinceTimestamp.trim()
      : null;
  const rows = db
    .prepare(
      `SELECT payload
       FROM audit_events
       WHERE session_id = ?
         AND event_type = 'tool.call'
         AND (? IS NULL OR timestamp >= ?)
       ORDER BY id ASC`,
    )
    .all(sessionId, normalizedSince, normalizedSince) as Array<{
    payload: string;
  }>;

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
  const normalizedSince =
    typeof sinceTimestamp === 'string' && sinceTimestamp.trim()
      ? sinceTimestamp.trim()
      : null;
  const rows = db
    .prepare(
      `SELECT event_type, payload
       FROM audit_events
       WHERE session_id = ?
         AND event_type IN ('tool.call', 'tool.result')
         AND (? IS NULL OR timestamp >= ?)
       ORDER BY id ASC`,
    )
    .all(sessionId, normalizedSince, normalizedSince) as Array<{
    event_type: string;
    payload: string;
  }>;

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
  const rows = db
    .prepare(
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
    )
    .all(...args) as Array<
    UsageSessionAggregate & {
      total_input_tokens: unknown;
      total_output_tokens: unknown;
      total_tokens: unknown;
      total_cost_usd: unknown;
      call_count: unknown;
      total_tool_calls: unknown;
    }
  >;

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

export function resetSessionIfExpired(
  sessionId: string,
  opts: {
    policy: SessionResetPolicy;
    expiryEvaluation?: SessionExpiryEvaluation;
  },
): boolean {
  const existing = getSessionById(sessionId);
  if (!existing) return false;

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
  if (!expiryEvaluation.isExpired) return false;

  resetSessionState(sessionId);
  logger.info(
    {
      sessionId,
      resetCount: existing.reset_count + 1,
      reason: expiryEvaluation.reason,
    },
    'Session auto-reset',
  );
  return true;
}

function requireSessionById(sessionId: string): Session {
  const session = getSessionById(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} disappeared during database update`);
  }
  return session;
}

export function getOrCreateSession(
  sessionId: string,
  guildId: string | null,
  channelId: string,
  agentId?: string,
): Session {
  const existing = getSessionById(sessionId);
  const normalizedAgentId = agentId?.trim() || null;

  if (existing) {
    if (normalizedAgentId && existing.agent_id !== normalizedAgentId) {
      db.prepare(
        `UPDATE sessions
         SET last_active = datetime('now'),
             agent_id = ?
         WHERE id = ?`,
      ).run(normalizedAgentId, sessionId);
      return requireSessionById(sessionId);
    }
    db.prepare(
      "UPDATE sessions SET last_active = datetime('now') WHERE id = ?",
    ).run(sessionId);
    return requireSessionById(sessionId);
  }

  db.prepare(
    'INSERT INTO sessions (id, guild_id, channel_id, agent_id) VALUES (?, ?, ?, ?)',
  ).run(sessionId, guildId, channelId, normalizedAgentId || DEFAULT_AGENT_ID);

  return requireSessionById(sessionId);
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

export function updateSessionAgent(sessionId: string, agentId: string): void {
  const normalizedAgentId = agentId.trim() || DEFAULT_AGENT_ID;
  db.prepare('UPDATE sessions SET agent_id = ? WHERE id = ?').run(
    normalizedAgentId,
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
    sessionId,
  );
}

export function updateSessionShowMode(
  sessionId: string,
  showMode: SessionShowMode,
): void {
  db.prepare('UPDATE sessions SET show_mode = ? WHERE id = ?').run(
    showMode,
    sessionId,
  );
}

export function getAllSessions(): Session[] {
  return db
    .prepare('SELECT * FROM sessions ORDER BY last_active DESC')
    .all() as Session[];
}

export function getFullAutoSessionCount(): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) as count FROM sessions WHERE full_auto_enabled = 1',
    )
    .get() as { count: number };
  return row.count;
}

export function getEnabledFullAutoSessions(): Session[] {
  return db
    .prepare(
      'SELECT * FROM sessions WHERE full_auto_enabled = 1 ORDER BY last_active DESC',
    )
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

export function resetSessionState(sessionId: string): void {
  const transaction = db.transaction((value: string) => {
    db.prepare(
      `UPDATE sessions
       SET message_count = 0,
           session_summary = NULL,
           summary_updated_at = NULL,
           compaction_count = 0,
           memory_flush_at = NULL,
           reset_count = reset_count + 1,
           reset_at = datetime('now'),
           last_active = datetime('now')
       WHERE id = ?`,
    ).run(value);
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(value);
    db.prepare('DELETE FROM semantic_memories WHERE session_id = ?').run(value);
  });
  transaction(sessionId);
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

  return transaction(sessionId);
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

export function getSessionMessageCounts(sessionId: string): {
  totalMessages: number;
  userMessages: number;
} {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total_messages,
         COALESCE(SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END), 0) AS user_messages
       FROM messages
       WHERE session_id = ?`,
    )
    .get(sessionId) as {
    total_messages: unknown;
    user_messages: unknown;
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

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
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
): SkillCogneeGuardVerdict {
  if (value === 'safe' || value === 'caution' || value === 'dangerous') {
    return value;
  }
  return 'caution';
}

function mapSkillObservationRow(row: SkillObservationRow): SkillObservation {
  return {
    id: Math.floor(row.id),
    skill_name: row.skill_name,
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
    negative_feedback_count: Math.max(
      0,
      Math.floor(row.negative_feedback_count || 0),
    ),
    error_clusters: clusterMap.get(row.skill_name) || [],
    last_observed_at: row.last_observed_at,
  }));
}

// --- Skill Cognee ---

export function recordSkillObservation(input: {
  skillName: string;
  sessionId: string;
  runId: string;
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
         session_id,
         run_id,
         outcome,
         error_category,
         error_detail,
         tool_calls_attempted,
         tool_calls_failed,
         duration_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.skillName.trim(),
      input.sessionId.trim(),
      input.runId.trim(),
      input.outcome,
      input.errorCategory || null,
      input.errorDetail?.trim() || null,
      Math.max(0, Math.floor(input.toolCallsAttempted || 0)),
      Math.max(0, Math.floor(input.toolCallsFailed || 0)),
      Math.max(0, Math.floor(input.durationMs || 0)),
    );

  const row = db
    .prepare('SELECT * FROM skill_observations WHERE id = ?')
    .get(result.lastInsertRowid) as SkillObservationRow;
  return mapSkillObservationRow(row);
}

export function getSkillObservations(params?: {
  skillName?: string;
  sessionId?: string;
  runId?: string;
  createdAfter?: string | null;
  limit?: number;
}): SkillObservation[] {
  const clauses: string[] = [];
  const args: Array<string | number> = [];
  const skillName = params?.skillName?.trim() || '';
  const sessionId = params?.sessionId?.trim() || '';
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
  if (runId) {
    clauses.push('run_id = ?');
    args.push(runId);
  }
  if (createdAfter) {
    clauses.push('created_at >= ?');
    args.push(createdAfter);
  }
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(params?.limit || 100, 1_000));
  return (
    db
      .prepare(
        `SELECT *
         FROM skill_observations
         ${whereClause}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...args, limit) as SkillObservationRow[]
  ).map(mapSkillObservationRow);
}

export function getObservedSkillNames(params?: {
  createdAfter?: string | null;
}): string[] {
  const createdAfter = params?.createdAfter?.trim() || '';
  const rows = createdAfter
    ? (db
        .prepare(
          `SELECT DISTINCT skill_name
           FROM skill_observations
           WHERE created_at >= ?
           ORDER BY skill_name ASC`,
        )
        .all(createdAfter) as Array<{ skill_name: string }>)
    : (db
        .prepare(
          `SELECT DISTINCT skill_name
           FROM skill_observations
           ORDER BY skill_name ASC`,
        )
        .all() as Array<{ skill_name: string }>);
  return rows
    .map((row) => row.skill_name.trim())
    .filter(Boolean);
}

export function getSkillObservationSummary(params?: {
  skillName?: string;
  createdAfter?: string | null;
}): SkillObservationSummary[] {
  const clauses: string[] = [];
  const args: Array<string | number> = [];
  const skillName = params?.skillName?.trim() || '';
  const createdAfter = params?.createdAfter?.trim() || '';
  if (skillName) {
    clauses.push('skill_name = ?');
    args.push(skillName);
  }
  if (createdAfter) {
    clauses.push('created_at >= ?');
    args.push(createdAfter);
  }
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const summaryRows = db
    .prepare(
      `SELECT
         skill_name,
         COUNT(*) AS total_executions,
         SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success_count,
         SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failure_count,
         SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) AS partial_count,
         AVG(duration_ms) AS avg_duration_ms,
         COALESCE(SUM(tool_calls_attempted), 0) AS tool_calls_attempted,
         COALESCE(SUM(tool_calls_failed), 0) AS tool_calls_failed,
         SUM(CASE WHEN feedback_sentiment = 'negative' THEN 1 ELSE 0 END) AS negative_feedback_count,
         MAX(created_at) AS last_observed_at
       FROM skill_observations
       ${whereClause}
       GROUP BY skill_name
       ORDER BY skill_name ASC`,
    )
    .all(...args) as SkillObservationSummaryRow[];

  if (summaryRows.length === 0) return [];

  const clusterClauses = [...clauses, "outcome != 'success'"];
  const clusterWhereClause =
    clusterClauses.length > 0 ? `WHERE ${clusterClauses.join(' AND ')}` : '';
  const clusterRows = db
    .prepare(
      `SELECT
         skill_name,
         COALESCE(NULLIF(TRIM(error_category), ''), 'unknown') AS error_category,
         COUNT(*) AS count,
         MIN(error_detail) AS sample_detail
       FROM skill_observations
       ${clusterWhereClause}
       GROUP BY skill_name, COALESCE(NULLIF(TRIM(error_category), ''), 'unknown')
       ORDER BY skill_name ASC, count DESC`,
    )
    .all(...args) as SkillObservationErrorClusterRow[];

  return mapSkillObservationSummaries({
    summaryRows,
    clusterRows,
  });
}

export function attachFeedbackToObservation(input: {
  sessionId: string;
  feedback: string;
  sentiment: SkillFeedbackSentiment;
}): SkillObservation | null {
  const sessionId = input.sessionId.trim();
  if (!sessionId) return null;
  const target = db
    .prepare(
      `SELECT id
       FROM skill_observations
       WHERE session_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(sessionId) as { id: number } | undefined;
  if (!target) return null;

  db.prepare(
    `UPDATE skill_observations
     SET user_feedback = ?,
         feedback_sentiment = ?
     WHERE id = ?`,
  ).run(input.feedback.trim() || null, input.sentiment, target.id);

  const row = db
    .prepare('SELECT * FROM skill_observations WHERE id = ?')
    .get(target.id) as SkillObservationRow;
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
  guardVerdict: SkillCogneeGuardVerdict;
  guardFindingsCount?: number;
  metricsAtProposal?: SkillHealthMetrics | null;
  metricsPostApply?: SkillHealthMetrics | null;
  runsSinceApply?: number;
}): SkillAmendment {
  const skillName = input.skillName.trim();
  const latest = db
    .prepare(
      `SELECT version
       FROM skill_amendments
       WHERE skill_name = ?
       ORDER BY version DESC
       LIMIT 1`,
    )
    .get(skillName) as { version?: number } | undefined;
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

  const row = db
    .prepare('SELECT * FROM skill_amendments WHERE id = ?')
    .get(result.lastInsertRowid) as SkillAmendmentRow;
  return mapSkillAmendmentRow(row);
}

export function getSkillAmendmentById(amendmentId: number): SkillAmendment | null {
  const row = db
    .prepare('SELECT * FROM skill_amendments WHERE id = ?')
    .get(Math.floor(amendmentId)) as SkillAmendmentRow | undefined;
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
  const row = db
    .prepare(
      `SELECT *
       FROM skill_amendments
       WHERE ${clauses.join(' AND ')}
       ORDER BY version DESC, id DESC
       LIMIT 1`,
    )
    .get(...args) as SkillAmendmentRow | undefined;
  return row ? mapSkillAmendmentRow(row) : null;
}

export function getStagedAmendments(): SkillAmendment[] {
  return (
    db
      .prepare(
        `SELECT *
         FROM skill_amendments
         WHERE status = 'staged'
         ORDER BY created_at DESC, id DESC`,
      )
      .all() as SkillAmendmentRow[]
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
  return (
    db
      .prepare(
        `SELECT *
         FROM skill_amendments
         WHERE skill_name = ?
         ORDER BY version DESC, id DESC`,
      )
      .all(normalized) as SkillAmendmentRow[]
  ).map(mapSkillAmendmentRow);
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

export function listStructuredAuditEntries(params?: {
  sessionId?: string;
  eventType?: string;
  query?: string;
  limit?: number;
}): StructuredAuditEntry[] {
  const sessionId = String(params?.sessionId || '').trim();
  const eventType = String(params?.eventType || '').trim();
  const query = String(params?.query || '').trim();
  const bounded = Math.max(1, Math.min(params?.limit ?? 50, 200));

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
  const sql = `
    SELECT *
    FROM audit_events
    ${where}
    ORDER BY id DESC
    LIMIT ?
  `;

  return db.prepare(sql).all(...values, bounded) as StructuredAuditEntry[];
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
