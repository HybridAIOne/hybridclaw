import type Database from 'better-sqlite3';
import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import {
  type Actor,
  actorFromLegacyFields,
  createUserActor,
  normalizeActor,
} from '../../identity/actor.js';
import {
  AGENT_IDENTITY_COMPONENT_MAX_LENGTH,
  deriveLocalAgentIdentity,
  formatAgentIdentity,
  formatLocalOwnerUserId,
  parseAgentIdentity,
} from '../../identity/agent-id.js';
import { parseUserId } from '../../identity/user-id.js';
import { logger } from '../../logger.js';
import {
  inspectSessionKeyMigration,
  isLegacySessionKey,
} from '../../session/session-key.js';
import type { CanonicalSessionMessage, Session } from '../../types/session.js';

export const DATABASE_SCHEMA_VERSION = 53;
const AGENT_CANONICAL_ID_COLLISION_LIMIT = 20;
const AUDIT_ACTOR_MIGRATION_BATCH_SIZE = 500;
const ACTOR_ID_MAX_LENGTH =
  AGENT_IDENTITY_COMPONENT_MAX_LENGTH * 3 + '@'.length * 2;
const RECENT_CHAT_MESSAGE_SEARCH_TABLE = 'recent_chat_message_search';
const RECENT_CHAT_MESSAGE_SEARCH_INSERT_TRIGGER =
  'messages_recent_chat_search_ai';
const RECENT_CHAT_MESSAGE_SEARCH_DELETE_TRIGGER =
  'messages_recent_chat_search_ad';
const RECENT_CHAT_MESSAGE_SEARCH_UPDATE_TRIGGER =
  'messages_recent_chat_search_au';

export interface InitDatabaseOptions {
  quiet?: boolean;
  dbPath?: string;
}

interface TableInfoRow {
  name: string;
}

interface ColumnInfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

type CanonicalSessionRow = {
  canonical_id: string;
  agent_id: string;
  user_id: string;
  messages: string;
  compaction_cursor: number;
  compacted_summary: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
};

type MemoryKvRow = {
  agent_id: string;
  key: string;
  value: Buffer | Uint8Array | string;
  version: number;
  updated_at: string;
};

interface AgentSkillScoreAggregate {
  agent_id: string;
  skill_id: string;
  success_count: number;
  partial_count: number;
  failure_count: number;
  avg_duration_ms: number;
  last_run_at: string | null;
  positive_feedback_count: number;
  negative_feedback_count: number;
  tool_calls_attempted: number;
  tool_calls_failed: number;
}

const CANONICAL_SUMMARY_MAX_CHARS = 4_000;
const AGENT_SKILL_SUCCESS_POINTS = 100;
const AGENT_SKILL_PARTIAL_POINTS = 75;
const AGENT_SKILL_FAILURE_POINTS = 10;
const AGENT_SKILL_FEEDBACK_POINT_STEP = 5;
const AGENT_SKILL_MAX_FEEDBACK_POINTS = 15;
const AGENT_SKILL_MAX_SCORE = 100;
const AGENT_SKILL_RELIABILITY_ERROR_WEIGHT = 70;
const AGENT_SKILL_RELIABILITY_RETRY_WEIGHT = 10;
const AGENT_SKILL_MAX_RETRY_PENALTY = 30;
const AGENT_SKILL_TIMING_BASELINE_MS = 30_000;
const AGENT_SKILL_TIMING_PENALTY_STEP = 20;
const AGENT_SKILL_QUALITY_WEIGHT = 0.6;
const AGENT_SKILL_RELIABILITY_WEIGHT = 0.25;
const AGENT_SKILL_TIMING_WEIGHT = 0.15;

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

function canonicalSessionId(agentId: string, userId: string): string {
  return `${agentId}:${userId}`;
}

function clampAgentSkillScore(value: number): number {
  return Math.max(0, Math.min(AGENT_SKILL_MAX_SCORE, Math.round(value)));
}

function scoreAgentSkillQuality(row: {
  total_executions: number;
  success_count: number;
  failure_count: number;
  partial_count: number;
  positive_feedback_count: number;
  negative_feedback_count: number;
}): number {
  const resultPoints =
    row.total_executions > 0
      ? (row.success_count * AGENT_SKILL_SUCCESS_POINTS +
          row.partial_count * AGENT_SKILL_PARTIAL_POINTS +
          row.failure_count * AGENT_SKILL_FAILURE_POINTS) /
        row.total_executions
      : 0;
  const feedbackBalance =
    row.positive_feedback_count - row.negative_feedback_count;
  const feedbackPoints = Math.max(
    -AGENT_SKILL_MAX_FEEDBACK_POINTS,
    Math.min(
      AGENT_SKILL_MAX_FEEDBACK_POINTS,
      feedbackBalance * AGENT_SKILL_FEEDBACK_POINT_STEP,
    ),
  );
  return clampAgentSkillScore(resultPoints + feedbackPoints);
}

function scoreAgentSkillReliability(row: {
  total_executions: number;
  tool_calls_attempted: number;
  tool_calls_failed: number;
}): number {
  const failureRate =
    row.tool_calls_attempted > 0
      ? row.tool_calls_failed / row.tool_calls_attempted
      : 0;
  const avgToolCalls =
    row.total_executions > 0
      ? row.tool_calls_attempted / row.total_executions
      : 0;
  const retryPenalty = Math.min(
    AGENT_SKILL_MAX_RETRY_PENALTY,
    Math.max(0, avgToolCalls - 1) * AGENT_SKILL_RELIABILITY_RETRY_WEIGHT,
  );
  return clampAgentSkillScore(
    AGENT_SKILL_MAX_SCORE -
      failureRate * AGENT_SKILL_RELIABILITY_ERROR_WEIGHT -
      retryPenalty,
  );
}

function scoreAgentSkillTiming(avgDurationMs: number): number {
  if (avgDurationMs <= 0) return AGENT_SKILL_MAX_SCORE;
  const penalty =
    Math.log2(avgDurationMs / AGENT_SKILL_TIMING_BASELINE_MS + 1) *
    AGENT_SKILL_TIMING_PENALTY_STEP;
  return clampAgentSkillScore(AGENT_SKILL_MAX_SCORE - penalty);
}

function scoreAgentSkillOverall(row: {
  quality_score: number;
  reliability_score: number;
  timing_score: number;
}): number {
  return clampAgentSkillScore(
    row.quality_score * AGENT_SKILL_QUALITY_WEIGHT +
      row.reliability_score * AGENT_SKILL_RELIABILITY_WEIGHT +
      row.timing_score * AGENT_SKILL_TIMING_WEIGHT,
  );
}

function mapAgentSkillScoreRow(row: AgentSkillScoreAggregate) {
  const successCount = Math.max(0, Math.floor(row.success_count || 0));
  const failureCount = Math.max(0, Math.floor(row.failure_count || 0));
  const partialCount = Math.max(0, Math.floor(row.partial_count || 0));
  const totalExecutions = successCount + failureCount + partialCount;
  const toolCallsAttempted = Math.max(
    0,
    Math.floor(row.tool_calls_attempted || 0),
  );
  const toolCallsFailed = Math.max(0, Math.floor(row.tool_calls_failed || 0));
  const normalized = {
    agent_id: row.agent_id,
    skill_id: row.skill_id,
    skill_name: row.skill_id,
    total_executions: totalExecutions,
    success_count: successCount,
    failure_count: failureCount,
    partial_count: partialCount,
    success_rate: totalExecutions > 0 ? successCount / totalExecutions : 0,
    avg_duration_ms: Math.max(0, Number(row.avg_duration_ms || 0)),
    tool_breakage_rate:
      toolCallsAttempted > 0 ? toolCallsFailed / toolCallsAttempted : 0,
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
  const qualityScore = scoreAgentSkillQuality({
    total_executions: normalized.total_executions,
    success_count: normalized.success_count,
    failure_count: normalized.failure_count,
    partial_count: normalized.partial_count,
    positive_feedback_count: normalized.positive_feedback_count,
    negative_feedback_count: normalized.negative_feedback_count,
  });
  const reliabilityScore = scoreAgentSkillReliability({
    total_executions: normalized.total_executions,
    tool_calls_attempted: toolCallsAttempted,
    tool_calls_failed: toolCallsFailed,
  });
  const timingScore = scoreAgentSkillTiming(normalized.avg_duration_ms);
  const score = scoreAgentSkillOverall({
    quality_score: qualityScore,
    reliability_score: reliabilityScore,
    timing_score: timingScore,
  });
  return {
    ...normalized,
    actor: { type: 'agent' as const, id: normalized.agent_id },
    quality_score: qualityScore,
    reliability_score: reliabilityScore,
    timing_score: timingScore,
    score,
  };
}

function queryOne<Row, Bind extends unknown[] = []>(
  database: Database.Database,
  sql: string,
  ...params: Bind
): Row | undefined {
  return database.prepare<unknown[], Row>(sql).get(...params);
}

function queryAll<Row, Bind extends unknown[] = []>(
  database: Database.Database,
  sql: string,
  ...params: Bind
): Row[] {
  return database.prepare<unknown[], Row>(sql).all(...params);
}

function normalizeStoredIdentityField(
  value: string | null,
  parseIdentity: (normalized: string) => { id: string },
  params: {
    agentId: string;
    lengthKey: string;
    warning: string;
  },
): string {
  const normalized = value?.trim() || '';
  if (!normalized) return '';
  try {
    return parseIdentity(normalized).id;
  } catch {
    logger.warn(
      { agentId: params.agentId, [params.lengthKey]: normalized.length },
      params.warning,
    );
    return '';
  }
}

function normalizeStoredCanonicalAgentId(
  value: string | null,
  agentId: string,
): string {
  return normalizeStoredIdentityField(value, parseAgentIdentity, {
    agentId,
    lengthKey: 'canonicalIdLength',
    warning: 'Ignoring invalid persisted canonical agent identity',
  });
}

function normalizeStoredOwnerUserId(
  value: string | null,
  agentId: string,
): string {
  return normalizeStoredIdentityField(value, parseUserId, {
    agentId,
    lengthKey: 'ownerUserIdLength',
    warning: 'Ignoring invalid persisted agent owner user id',
  });
}

function prepareCanonicalAgentIdentityConflictStatement(
  database: Database.Database,
): Database.Statement | null {
  if (!tableExists(database, 'agents')) return null;
  if (!columnExists(database, 'agents', 'canonical_id')) return null;
  return database.prepare(
    `SELECT id
     FROM agents
     WHERE canonical_id = ? AND id != ?
     LIMIT 1`,
  );
}

function canonicalAgentIdentityExists(
  statement: Database.Statement,
  canonicalId: string,
  agentId: string,
): boolean {
  const row = statement.get(canonicalId, agentId) as { id: string } | undefined;
  return Boolean(row);
}

function addCollisionSuffixToAgentSlug(slug: string, index: number): string {
  const suffix = `-${index}`;
  return `${slug.slice(0, AGENT_IDENTITY_COMPONENT_MAX_LENGTH - suffix.length)}${suffix}`;
}

function allocateCanonicalAgentIdentity(params: {
  database: Database.Database;
  conflictStatement?: Database.Statement | null;
  agentId: string;
  owner?: string | null;
  ownerUserId?: string | null;
}): { canonicalId: string; ownerUserId: string } {
  const identity = deriveLocalAgentIdentity({
    agentId: params.agentId,
    owner: params.owner ?? undefined,
    ownerUserId: params.ownerUserId ?? undefined,
  });
  const conflictStatement =
    params.conflictStatement ??
    prepareCanonicalAgentIdentityConflictStatement(params.database);
  if (!conflictStatement) return identity;
  if (
    !canonicalAgentIdentityExists(
      conflictStatement,
      identity.canonicalId,
      params.agentId,
    )
  ) {
    return identity;
  }

  const parsed = parseAgentIdentity(identity.canonicalId);
  for (let index = 2; index <= AGENT_CANONICAL_ID_COLLISION_LIMIT; index += 1) {
    const canonicalId = formatAgentIdentity(
      addCollisionSuffixToAgentSlug(parsed.agentSlug, index),
      parsed.userSlug,
      parsed.instanceId,
    );
    if (
      !canonicalAgentIdentityExists(
        conflictStatement,
        canonicalId,
        params.agentId,
      )
    ) {
      return {
        canonicalId,
        ownerUserId: identity.ownerUserId,
      };
    }
  }

  throw new Error(
    `Could not allocate a unique canonical agent identity for ${params.agentId}.`,
  );
}

function readPayloadStringValue(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function readPayloadActorFromLegacyFields(
  payload: Record<string, unknown>,
): Actor | null {
  const userId = readPayloadStringValue(payload, 'userId')?.trim() || '';
  const agentId = readPayloadStringValue(payload, 'agentId')?.trim() || '';
  if (userId && agentId) {
    return actorFromLegacyFields({ userId, agentId });
  }
  if (userId) {
    return createUserActor(formatLocalOwnerUserId(userId));
  }
  if (agentId) {
    return actorFromLegacyFields({ agentId });
  }
  return null;
}

function readPayloadActor(payload: Record<string, unknown>): Actor | null {
  const actor = payload.actor;
  if (actor && typeof actor === 'object' && !Array.isArray(actor)) {
    const actorRecord = actor as Record<string, unknown>;
    if (!('type' in actorRecord) && !('id' in actorRecord)) return null;
    try {
      return normalizeActor(actor);
    } catch {
      return null;
    }
  }

  try {
    return readPayloadActorFromLegacyFields(payload);
  } catch {
    return null;
  }
}

function readAuditActorFromPayloadText(payloadText: string): Actor | null {
  try {
    const parsed = JSON.parse(payloadText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return readPayloadActor(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
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

export function tableExists(
  database: Database.Database,
  table: string,
): boolean {
  const row = queryOne<{ name: string }, [string]>(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    table,
  );
  return Boolean(row?.name);
}

function indexExists(database: Database.Database, index: string): boolean {
  const row = queryOne<{ name: string }, [string]>(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
    index,
  );
  return Boolean(row?.name);
}

export function ensureSessionBranchesTable(database: Database.Database): void {
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

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function columnExists(
  database: Database.Database,
  table: string,
  column: string,
): boolean {
  const cols = queryAll<TableInfoRow>(database, `PRAGMA table_info(${table})`);
  return cols.some((entry) => entry.name === column);
}

export function hasSessionLegacySessionIdColumn(
  database: Database.Database,
): boolean {
  return (
    tableExists(database, 'sessions') &&
    columnExists(database, 'sessions', 'legacy_session_id')
  );
}

export function hasSessionKeyColumn(database: Database.Database): boolean {
  return (
    tableExists(database, 'sessions') &&
    columnExists(database, 'sessions', 'session_key')
  );
}

export function hasSessionCurrentColumn(database: Database.Database): boolean {
  return (
    tableExists(database, 'sessions') &&
    columnExists(database, 'sessions', 'is_current')
  );
}

export function hasSessionMainKeyColumn(database: Database.Database): boolean {
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

function skillObservationsNeedAgentMigration(
  database: Database.Database,
): boolean {
  return (
    tableExists(database, 'skill_observations') &&
    !columnExists(database, 'skill_observations', 'agent_id')
  );
}

function agentSkillScoresNeedMigration(database: Database.Database): boolean {
  return !tableExists(database, 'agent_skill_scores');
}

function agentA2ANeedMigration(database: Database.Database): boolean {
  return (
    tableExists(database, 'agents') && !columnExists(database, 'agents', 'a2a')
  );
}

function agentProxyNeedMigration(database: Database.Database): boolean {
  return (
    tableExists(database, 'agents') &&
    !columnExists(database, 'agents', 'proxy')
  );
}

function agentEmptyChatHeaderNeedMigration(
  database: Database.Database,
): boolean {
  return (
    tableExists(database, 'agents') &&
    !columnExists(database, 'agents', 'empty_chat_header')
  );
}

function boardCardsNeedMigration(database: Database.Database): boolean {
  return !tableExists(database, 'board_cards');
}

function boardCardEdgesNeedMigration(database: Database.Database): boolean {
  return (
    !tableExists(database, 'board_card_edges') ||
    !indexExists(database, 'idx_board_card_edges_logical_unique')
  );
}

function threadGoalsNeedMigration(database: Database.Database): boolean {
  return !tableExists(database, 'thread_goals');
}

function budgetSoftWarnEventsNeedMigration(
  database: Database.Database,
): boolean {
  return !tableExists(database, 'budget_soft_warn_events');
}

function budgetSoftWarnEventUnitsNeedMigration(
  database: Database.Database,
): boolean {
  return (
    tableExists(database, 'budget_soft_warn_events') &&
    !columnExists(database, 'budget_soft_warn_events', 'unit')
  );
}

function budgetSoftWarnEventUnitKeyNeedMigration(
  database: Database.Database,
): boolean {
  if (!tableExists(database, 'budget_soft_warn_events')) return false;
  const definition = getTableSql(database, 'budget_soft_warn_events')
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return !definition.includes('primary key (agent_id, billing_window, unit)');
}

function messageAgentIdentityNeedMigration(
  database: Database.Database,
): boolean {
  return (
    tableExists(database, 'messages') &&
    !columnExists(database, 'messages', 'agent_id')
  );
}

function adminStatisticsIndexesNeedMigration(
  database: Database.Database,
): boolean {
  const messagesHasCreatedAt =
    tableExists(database, 'messages') &&
    columnExists(database, 'messages', 'created_at');
  if (
    messagesHasCreatedAt &&
    !indexExists(database, 'idx_messages_created_at')
  ) {
    return true;
  }
  if (
    messagesHasCreatedAt &&
    columnExists(database, 'messages', 'session_id') &&
    !indexExists(database, 'idx_messages_session_created_at')
  ) {
    return true;
  }

  const sessionsExists = tableExists(database, 'sessions');
  if (
    sessionsExists &&
    columnExists(database, 'sessions', 'created_at') &&
    !indexExists(database, 'idx_sessions_created_at')
  ) {
    return true;
  }
  if (
    sessionsExists &&
    columnExists(database, 'sessions', 'last_active') &&
    !indexExists(database, 'idx_sessions_last_active')
  ) {
    return true;
  }
  if (
    sessionsExists &&
    columnExists(database, 'sessions', 'channel_id') &&
    columnExists(database, 'sessions', 'last_active') &&
    !indexExists(database, 'idx_sessions_channel_last_active')
  ) {
    return true;
  }

  return false;
}

function messageArtifactsNeedMigration(database: Database.Database): boolean {
  return (
    tableExists(database, 'messages') &&
    !columnExists(database, 'messages', 'artifacts_json')
  );
}

function sessionTitleSourceConstraintNeedMigration(
  database: Database.Database,
): boolean {
  if (!tableExists(database, 'sessions')) return false;
  if (!columnExists(database, 'sessions', 'title_source')) return false;
  const definition = getTableSql(database, 'sessions').toLowerCase();
  return (
    !definition.includes('check') ||
    !definition.includes('title_source') ||
    !definition.includes("'auto'")
  );
}

function backfillAgentSkillScoreQuality(database: Database.Database): void {
  if (!tableExists(database, 'skill_observations')) return;
  if (!tableExists(database, 'agent_skill_scores')) return;

  const aggregates = queryAll<AgentSkillScoreAggregate>(
    database,
    `SELECT
       agent_id,
       skill_name AS skill_id,
       SUM(CASE WHEN outcome = 'success' AND COALESCE(tool_calls_failed, 0) = 0 THEN 1 ELSE 0 END) AS success_count,
       SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failure_count,
       SUM(CASE WHEN outcome = 'partial' OR (outcome = 'success' AND COALESCE(tool_calls_failed, 0) > 0) THEN 1 ELSE 0 END) AS partial_count,
       COALESCE(AVG(duration_ms), 0) AS avg_duration_ms,
       MAX(created_at) AS last_run_at,
       SUM(CASE WHEN feedback_sentiment = 'positive' THEN 1 ELSE 0 END) AS positive_feedback_count,
       SUM(CASE WHEN feedback_sentiment = 'negative' THEN 1 ELSE 0 END) AS negative_feedback_count,
       COALESCE(SUM(tool_calls_attempted), 0) AS tool_calls_attempted,
       COALESCE(SUM(tool_calls_failed), 0) AS tool_calls_failed
     FROM skill_observations
     WHERE agent_id IS NOT NULL AND TRIM(agent_id) != ''
     GROUP BY agent_id, skill_name`,
  );
  const updateScore = database.prepare(
    `UPDATE agent_skill_scores
     SET quality_score = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE agent_id = ? AND skill_id = ?`,
  );
  const updateScores = database.transaction(
    (rows: AgentSkillScoreAggregate[]) => {
      for (const row of rows) {
        const score = mapAgentSkillScoreRow(row);
        updateScore.run(score.quality_score, score.agent_id, score.skill_id);
      }
    },
  );
  updateScores(aggregates);
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

function createDelegationJobsSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS delegation_jobs (
      public_id TEXT PRIMARY KEY,
      internal_id TEXT NOT NULL,
      parent_session_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      model TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued','in_progress','completed','failed','cancelled')),
      task_count INTEGER NOT NULL DEFAULT 0,
      ack_text TEXT,
      result_text TEXT,
      result_digest TEXT,
      artifacts_json TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_delegation_jobs_status
      ON delegation_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_delegation_jobs_created
      ON delegation_jobs(created_at);
  `);
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
      artifacts_json TEXT,
      activity_trace_json TEXT,
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
      actor_type TEXT CHECK (actor_type IN ('user', 'agent')),
      actor_id TEXT CHECK (actor_id IS NULL OR length(actor_id) <= ${ACTOR_ID_MAX_LENGTH}),
      payload TEXT NOT NULL,
      wire_hash TEXT NOT NULL,
      wire_prev_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_events_type_timestamp ON audit_events(event_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_events_session_seq ON audit_events(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_audit_events_run_seq ON audit_events(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_audit_events_actor_timestamp ON audit_events(actor_type, actor_id, timestamp);

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
  createDelegationJobsSchema(database);
  createResponseRatingsSchema(database);
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
      tool_calls INTEGER NOT NULL DEFAULT 0,
      billable_unit TEXT,
      billable_quantity REAL NOT NULL DEFAULT 0.0,
      batch_id TEXT,
      batch_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_agent_time ON usage_events(agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_events_time ON usage_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_events_model_time ON usage_events(model, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_events_session_time ON usage_events(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_events_batch ON usage_events(batch_id);
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
        empty_chat_header TEXT,
        model TEXT,
        skills TEXT,
        chatbot_id TEXT,
        enable_rag INTEGER DEFAULT 1,
        workspace TEXT,
        a2a TEXT,
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
      proposal_metadata TEXT,
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
    'Persist agent owner, role, and CV profile for stable agent identity',
  );
}

function migrateV22(database: Database.Database): void {
  // Some legacy databases — and a couple of migration tests — start partway
  // through the schema with only the tables (and columns) they care about.
  // Guard each CREATE INDEX behind table+column existence so this migration
  // is safe to run regardless of which earlier tables/columns are present;
  // earlier migrations are responsible for creating the targeted columns
  // when they're missing on legacy DBs.
  const messagesHasCreatedAt =
    tableExists(database, 'messages') &&
    columnExists(database, 'messages', 'created_at');
  if (messagesHasCreatedAt) {
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_messages_created_at
         ON messages(created_at);`,
    );
    if (columnExists(database, 'messages', 'session_id')) {
      database.exec(
        `CREATE INDEX IF NOT EXISTS idx_messages_session_created_at
           ON messages(session_id, created_at);`,
      );
    }
  }
  if (tableExists(database, 'sessions')) {
    if (columnExists(database, 'sessions', 'created_at')) {
      database.exec(
        `CREATE INDEX IF NOT EXISTS idx_sessions_created_at
           ON sessions(created_at);`,
      );
    }
    if (columnExists(database, 'sessions', 'last_active')) {
      database.exec(
        `CREATE INDEX IF NOT EXISTS idx_sessions_last_active
           ON sessions(last_active);`,
      );
      if (columnExists(database, 'sessions', 'channel_id')) {
        database.exec(
          `CREATE INDEX IF NOT EXISTS idx_sessions_channel_last_active
             ON sessions(channel_id, last_active);`,
        );
      }
    }
  }
  recordMigration(
    database,
    22,
    'Index timestamp columns for admin statistics aggregations',
  );
}

function migrateV23(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'skill_observations',
    column: 'agent_id',
    ddl: 'agent_id TEXT',
    quiet,
  });
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_skill_scores (
      agent_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      partial_count INTEGER NOT NULL DEFAULT 0,
      avg_duration_ms REAL NOT NULL DEFAULT 0,
      last_run_at TEXT,
      quality_score REAL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (agent_id, skill_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_skill_scores_skill_quality
      ON agent_skill_scores(skill_id, quality_score DESC, last_run_at DESC);
  `);

  if (!tableExists(database, 'skill_observations')) {
    recordMigration(
      database,
      23,
      'Persist agent identity and per-skill score aggregates',
    );
    return;
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_skill_observations_agent_skill_created
      ON skill_observations(agent_id, skill_name, created_at);
  `);
  database.exec(`
    INSERT INTO agent_skill_scores (
      agent_id,
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
      agent_id,
      skill_name,
      SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END),
      SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END),
      SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END),
      COALESCE(AVG(duration_ms), 0),
      MAX(created_at),
      0,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM skill_observations
    WHERE agent_id IS NOT NULL AND TRIM(agent_id) != ''
    GROUP BY agent_id, skill_name
    ON CONFLICT(agent_id, skill_id) DO UPDATE SET
      success_count = excluded.success_count,
      failure_count = excluded.failure_count,
      partial_count = excluded.partial_count,
      avg_duration_ms = excluded.avg_duration_ms,
      last_run_at = excluded.last_run_at,
      quality_score = excluded.quality_score,
      updated_at = excluded.updated_at;
  `);
  backfillAgentSkillScoreQuality(database);
  recordMigration(
    database,
    23,
    'Persist agent identity and per-skill score aggregates',
  );
}

function migrateV24(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  addColumnIfMissing({
    database,
    table: 'messages',
    column: 'artifacts_json',
    ddl: 'artifacts_json TEXT',
    quiet: opts?.quiet === true,
  });
  recordMigration(database, 24, 'Persist assistant message artifacts');
}

function migrateV25(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'escalation_target',
    ddl: 'escalation_target TEXT',
    quiet: opts?.quiet === true,
  });
  recordMigration(
    database,
    25,
    'Persist per-agent escalation targets for approval routing',
  );
}

function migrateV26(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'reports_to',
    ddl: 'reports_to TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'delegates_to',
    ddl: 'delegates_to TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'peers',
    ddl: 'peers TEXT',
    quiet,
  });
  recordMigration(database, 26, 'Persist agent org-chart relationships');
}

function migrateV27(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'usage_events',
    column: 'batch_id',
    ddl: 'batch_id TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'usage_events',
    column: 'batch_hash',
    ddl: 'batch_hash TEXT',
    quiet,
  });
  if (
    tableExists(database, 'usage_events') &&
    columnExists(database, 'usage_events', 'batch_id')
  ) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_events_batch ON usage_events(batch_id);
    `);
  }

  recordMigration(
    database,
    27,
    'Persist token usage batch identifiers and hashes',
  );
}

function migrateV28(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'title',
    ddl: 'title TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'sessions',
    column: 'title_source',
    ddl: "title_source TEXT CHECK (title_source IS NULL OR title_source = 'auto')",
    quiet,
  });
  recordMigration(database, 28, 'Persist per-session AI-generated titles');
}

function buildSessionColumnDefinition(column: ColumnInfoRow): string {
  if (column.name === 'title_source') {
    const quotedName = quoteSqlIdentifier(column.name);
    return `${quotedName} TEXT CHECK (${quotedName} IS NULL OR ${quotedName} = 'auto')`;
  }

  const parts = [quoteSqlIdentifier(column.name)];
  const type = column.type.trim();
  if (type) parts.push(type);
  if (column.pk > 0) parts.push('PRIMARY KEY');
  if (column.notnull !== 0) parts.push('NOT NULL');
  if (column.dflt_value !== null) {
    parts.push(`DEFAULT ${normalizeSqlColumnDefault(column.dflt_value)}`);
  }
  return parts.join(' ');
}

function normalizeSqlColumnDefault(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (trimmed.startsWith('(')) return trimmed;
  if (/^CURRENT_(TIME|DATE|TIMESTAMP)$/i.test(trimmed)) return trimmed;
  return `(${trimmed})`;
}

function recreateSessionIndexes(database: Database.Database): void {
  if (columnExists(database, 'sessions', 'agent_id')) {
    database.exec(
      'CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id)',
    );
  }
  if (columnExists(database, 'sessions', 'legacy_session_id')) {
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_legacy_session_id
        ON sessions(legacy_session_id)
        WHERE legacy_session_id IS NOT NULL;
    `);
  }
  if (columnExists(database, 'sessions', 'session_key')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_key ON sessions(session_key);
    `);
    if (columnExists(database, 'sessions', 'is_current')) {
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_current_key
          ON sessions(session_key)
          WHERE is_current = 1;
      `);
    }
  }
  if (columnExists(database, 'sessions', 'main_session_key')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_main_key
        ON sessions(main_session_key);
    `);
  }
  migrateV22(database);
}

function migrateV29(database: Database.Database): void {
  if (!sessionTitleSourceConstraintNeedMigration(database)) {
    recordMigration(
      database,
      29,
      'Constrain session title sources to automatic titles',
    );
    return;
  }

  const backupTable = 'sessions_v29_backup';
  if (!tableExists(database, backupTable)) {
    database.exec(`
      DROP INDEX IF EXISTS idx_sessions_agent;
      DROP INDEX IF EXISTS idx_sessions_legacy_session_id;
      DROP INDEX IF EXISTS idx_sessions_key;
      DROP INDEX IF EXISTS idx_sessions_current_key;
      DROP INDEX IF EXISTS idx_sessions_main_key;
      DROP INDEX IF EXISTS idx_sessions_created_at;
      DROP INDEX IF EXISTS idx_sessions_last_active;
      DROP INDEX IF EXISTS idx_sessions_channel_last_active;
      ALTER TABLE sessions RENAME TO ${backupTable};
    `);
  }

  const columns = queryAll<ColumnInfoRow>(
    database,
    `PRAGMA table_info(${backupTable})`,
  );
  if (columns.length === 0) {
    throw new Error('Unable to migrate sessions title source constraint.');
  }

  const columnNames = columns.map((column) => quoteSqlIdentifier(column.name));
  const selectColumns = columns.map((column) =>
    column.name === 'title_source'
      ? `CASE WHEN ${quoteSqlIdentifier(column.name)} = 'auto' THEN ${quoteSqlIdentifier(column.name)} ELSE NULL END`
      : quoteSqlIdentifier(column.name),
  );

  database.exec(`
    DROP TABLE IF EXISTS sessions;

    CREATE TABLE sessions (
      ${columns.map(buildSessionColumnDefinition).join(',\n      ')}
    );

    INSERT INTO sessions (${columnNames.join(', ')})
    SELECT ${selectColumns.join(', ')}
    FROM ${backupTable};

    DROP TABLE ${backupTable};
  `);
  recreateSessionIndexes(database);
  recordMigration(
    database,
    29,
    'Constrain session title sources to automatic titles',
  );
}

function migrateV30(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'a2a',
    ddl: 'a2a TEXT',
    quiet: opts?.quiet === true,
  });
  recordMigration(database, 30, 'Persist per-agent A2A visibility metadata');
}

function migrateV31(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS board_cards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      owner TEXT NOT NULL,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'agent')),
      owner_id TEXT NOT NULL,
      "column" TEXT NOT NULL CHECK ("column" IN ('triage', 'todo', 'in_progress', 'in_review', 'done')),
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      parent TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_board_cards_column_deleted
      ON board_cards("column", deleted_at);
    CREATE INDEX IF NOT EXISTS idx_board_cards_owner_deleted
      ON board_cards(owner_type, owner_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_board_cards_source_deleted
      ON board_cards(source, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_board_cards_parent
      ON board_cards(parent);
  `);
  recordMigration(
    database,
    31,
    'Persist board card data model for admin work board',
  );
}

function migrateV32(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS thread_goals (
      thread_id TEXT PRIMARY KEY,
      goal_text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'done', 'cleared')),
      turns_used INTEGER NOT NULL DEFAULT 0,
      max_turns INTEGER NOT NULL DEFAULT 20,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_turn_at TEXT,
      last_verdict TEXT,
      last_reason TEXT,
      paused_reason TEXT,
      consecutive_parse_failures INTEGER NOT NULL DEFAULT 0,
      setter_actor TEXT,
      target_agent_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_thread_goals_status
      ON thread_goals(status);
    CREATE INDEX IF NOT EXISTS idx_thread_goals_target_agent
      ON thread_goals(target_agent_id, status);
  `);
  recordMigration(database, 32, 'Persist per-thread standing goal state');
}

function migrateV33(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS budget_soft_warn_events (
      agent_id TEXT NOT NULL,
      billing_window TEXT NOT NULL,
      emitted_at TEXT NOT NULL,
      used REAL NOT NULL,
      cap REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'USD' CHECK (unit IN ('USD', 'EUR', 'tokens')),
      currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR')),
      percent REAL NOT NULL,
      PRIMARY KEY (agent_id, billing_window, unit)
    );
    CREATE INDEX IF NOT EXISTS idx_budget_soft_warn_events_window
      ON budget_soft_warn_events(billing_window);
  `);
  recordMigration(
    database,
    33,
    'Persist monthly budget soft-warning event markers',
  );
}

function migrateV34(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('scheduler_job', 'scheduled_task')),
      legacy_task_id INTEGER UNIQUE,
      session_id TEXT,
      channel_id TEXT,
      name TEXT,
      description TEXT,
      agent_id TEXT,
      board_status TEXT CHECK (board_status IS NULL OR board_status IN ('backlog', 'in_progress', 'review', 'done', 'cancelled')),
      max_retries INTEGER,
      schedule TEXT NOT NULL,
      action TEXT NOT NULL,
      delivery TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run TEXT,
      last_status TEXT CHECK (last_status IS NULL OR last_status IN ('success', 'error')),
      consecutive_errors INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_kind_sort
      ON jobs(kind, sort_order, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_legacy_task
      ON jobs(legacy_task_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_agent
      ON jobs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_board_status
      ON jobs(board_status);
  `);
  recordMigration(database, 34, 'Persist scheduler jobs in SQLite');
}

function migrateV35(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'usage_events',
    column: 'billable_unit',
    ddl: 'billable_unit TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'usage_events',
    column: 'billable_quantity',
    ddl: 'billable_quantity REAL NOT NULL DEFAULT 0.0',
    quiet,
  });
  if (tableExists(database, 'usage_events')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_events_billable_unit_time
        ON usage_events(billable_unit, timestamp);
    `);
  }
  recordMigration(database, 35, 'Persist non-token billable usage units');
}

function backfillAgentCanonicalIdentities(database: Database.Database): void {
  if (!tableExists(database, 'agents')) return;
  if (!columnExists(database, 'agents', 'canonical_id')) return;
  if (!columnExists(database, 'agents', 'owner_user_id')) return;

  const ownerSelect = columnExists(database, 'agents', 'owner')
    ? 'owner'
    : 'NULL AS owner';
  const rows = database
    .prepare(
      `SELECT id, ${ownerSelect}, canonical_id, owner_user_id
       FROM agents
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id ASC`,
    )
    .all(DEFAULT_AGENT_ID) as Array<{
    id: string;
    owner: string | null;
    canonical_id: string | null;
    owner_user_id: string | null;
  }>;

  const update = database.prepare(
    `UPDATE agents
     SET canonical_id = ?, owner_user_id = ?, updated_at = datetime('now')
     WHERE id = ?`,
  );
  const conflictStatement =
    prepareCanonicalAgentIdentityConflictStatement(database);
  for (const row of rows) {
    const existingCanonicalId = normalizeStoredCanonicalAgentId(
      row.canonical_id,
      row.id,
    );
    const existingOwnerUserId = normalizeStoredOwnerUserId(
      row.owner_user_id,
      row.id,
    );
    if (existingCanonicalId && existingOwnerUserId) continue;

    const identity = allocateCanonicalAgentIdentity({
      database,
      conflictStatement,
      agentId: row.id,
      owner: row.owner,
      ownerUserId: existingOwnerUserId || undefined,
    });
    update.run(
      existingCanonicalId || identity.canonicalId,
      existingOwnerUserId || identity.ownerUserId,
      row.id,
    );
  }
}

function agentCanonicalIdentityNeedMigration(
  database: Database.Database,
): boolean {
  return (
    tableExists(database, 'agents') &&
    (!columnExists(database, 'agents', 'canonical_id') ||
      !columnExists(database, 'agents', 'owner_user_id') ||
      !indexExists(database, 'idx_agents_canonical_id') ||
      !indexExists(database, 'idx_agents_owner_user_id'))
  );
}

function migrateV36(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'canonical_id',
    ddl: 'canonical_id TEXT',
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'owner_user_id',
    ddl: 'owner_user_id TEXT',
    quiet,
  });
  backfillAgentCanonicalIdentities(database);
  if (tableExists(database, 'agents')) {
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_canonical_id
        ON agents(canonical_id)
        WHERE canonical_id IS NOT NULL AND TRIM(canonical_id) != '';
      CREATE INDEX IF NOT EXISTS idx_agents_owner_user_id
        ON agents(owner_user_id);
    `);
  }
  recordMigration(
    database,
    36,
    'Persist canonical local agent and owner user identities',
  );
}

function migrateV37(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS board_card_edges (
      id TEXT PRIMARY KEY,
      from_card_id TEXT NOT NULL REFERENCES board_cards(id),
      to_card_id TEXT NOT NULL REFERENCES board_cards(id),
      kind TEXT NOT NULL CHECK (kind IN ('blocks', 'related')),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      CHECK (from_card_id <> to_card_id),
      UNIQUE (from_card_id, to_card_id, kind)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_board_card_edges_logical_unique
      ON board_card_edges(
        CASE
          WHEN kind = 'related' AND from_card_id > to_card_id THEN to_card_id
          ELSE from_card_id
        END,
        CASE
          WHEN kind = 'related' AND from_card_id > to_card_id THEN from_card_id
          ELSE to_card_id
        END,
        kind
      );
    CREATE INDEX IF NOT EXISTS idx_board_card_edges_from
      ON board_card_edges(from_card_id, kind);
    CREATE INDEX IF NOT EXISTS idx_board_card_edges_to
      ON board_card_edges(to_card_id, kind);
  `);
  recordMigration(database, 37, 'Persist typed board card dependency edges');
}

function migrateV38(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  addColumnIfMissing({
    database,
    table: 'skill_amendments',
    column: 'proposal_metadata',
    ddl: 'proposal_metadata TEXT',
    quiet: opts?.quiet === true,
  });
  recordMigration(
    database,
    38,
    'Persist adaptive skill amendment proposal metadata',
  );
}

function migrateV39(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS skillopt_rejected_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL,
      edit_hash TEXT NOT NULL,
      op TEXT NOT NULL,
      target TEXT NOT NULL,
      content_preview TEXT NOT NULL,
      rationale TEXT NOT NULL,
      source_type TEXT NOT NULL,
      support_count INTEGER NOT NULL DEFAULT 1,
      reason TEXT NOT NULL,
      evidence_source TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(skill_name, edit_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_skillopt_rejected_edits_skill_created
      ON skillopt_rejected_edits(skill_name, created_at DESC, id DESC);
  `);
  recordMigration(database, 39, 'Persist rejected SkillOpt-lite edit memory');
}

function auditTimestampIndexNeedMigration(
  database: Database.Database,
): boolean {
  return (
    tableExists(database, 'audit_events') &&
    !indexExists(database, 'idx_audit_events_timestamp')
  );
}

function migrateV40(database: Database.Database): void {
  // Lets the admin audit list seek by timestamp (range pills) and id
  // (cursor paging) when there's no event_type/session predicate to lean
  // on; without it the query table-scans audit_events. Added as its own
  // migration (not folded into migrateV1) so existing databases — which
  // never re-run migrateV1 — actually pick the index up.
  if (tableExists(database, 'audit_events')) {
    database.exec(
      'CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp)',
    );
  }
  recordMigration(
    database,
    40,
    'Index audit_events(timestamp) for admin audit range + cursor paging',
  );
}

function migrateV41(database: Database.Database): void {
  if (!tableExists(database, 'budget_soft_warn_events')) {
    recordMigration(
      database,
      41,
      'Persist budget soft-warning unit and include it in marker dedupe key',
    );
    return;
  }

  addColumnIfMissing({
    database,
    table: 'budget_soft_warn_events',
    column: 'unit',
    ddl: "unit TEXT NOT NULL DEFAULT 'USD' CHECK (unit IN ('USD', 'EUR', 'tokens'))",
    quiet: true,
  });
  database.exec(`
    UPDATE budget_soft_warn_events
    SET unit = currency
    WHERE unit != currency;

    CREATE TABLE budget_soft_warn_events_v41 (
      agent_id TEXT NOT NULL,
      billing_window TEXT NOT NULL,
      emitted_at TEXT NOT NULL,
      used REAL NOT NULL,
      cap REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'USD' CHECK (unit IN ('USD', 'EUR', 'tokens')),
      currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR')),
      percent REAL NOT NULL,
      PRIMARY KEY (agent_id, billing_window, unit)
    );
    INSERT OR IGNORE INTO budget_soft_warn_events_v41
      (agent_id, billing_window, emitted_at, used, cap, unit, currency, percent)
    SELECT
      agent_id,
      billing_window,
      emitted_at,
      used,
      cap,
      unit,
      currency,
      percent
    FROM budget_soft_warn_events;
    DROP TABLE budget_soft_warn_events;
    ALTER TABLE budget_soft_warn_events_v41 RENAME TO budget_soft_warn_events;
    CREATE INDEX IF NOT EXISTS idx_budget_soft_warn_events_window
      ON budget_soft_warn_events(billing_window);
  `);
  recordMigration(
    database,
    41,
    'Persist budget soft-warning unit and include it in marker dedupe key',
  );
}

function createResponseRatingsSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS response_ratings (
      session_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      operator_user_id TEXT NOT NULL,
      rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
      agent_id TEXT,
      model TEXT,
      provider TEXT,
      skill_name TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (session_id, message_id, operator_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_response_ratings_message
      ON response_ratings(session_id, message_id);
  `);
}

function responseRatingsNeedMigration(database: Database.Database): boolean {
  if (!tableExists(database, 'response_ratings')) return false;
  const columns = queryAll<ColumnInfoRow>(
    database,
    'PRAGMA table_info(response_ratings)',
  );
  if (columns.some((column) => column.name === 'source_surface')) return true;
  const primaryKeyColumns = columns
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
  return (
    primaryKeyColumns.join(',') !== 'session_id,message_id,operator_user_id'
  );
}

function migrateResponseRatingsSchema(database: Database.Database): void {
  if (!responseRatingsNeedMigration(database)) {
    createResponseRatingsSchema(database);
    return;
  }

  database.transaction(() => {
    database.exec(`
        ALTER TABLE response_ratings RENAME TO response_ratings_v42_legacy;
        DROP INDEX IF EXISTS idx_response_ratings_message;
        DROP INDEX IF EXISTS idx_response_ratings_updated;
      `);
    createResponseRatingsSchema(database);
    database.exec(`
        INSERT INTO response_ratings (
          session_id,
          message_id,
          operator_user_id,
          rating,
          agent_id,
          model,
          provider,
          skill_name,
          created_at,
          updated_at
        )
        SELECT
          legacy.session_id,
          legacy.message_id,
          legacy.operator_user_id,
          legacy.rating,
          legacy.agent_id,
          legacy.model,
          legacy.provider,
          legacy.skill_name,
          legacy.created_at,
          legacy.updated_at
        FROM response_ratings_v42_legacy AS legacy
        WHERE NOT EXISTS (
          SELECT 1
          FROM response_ratings_v42_legacy AS newer
          WHERE newer.session_id = legacy.session_id
            AND newer.message_id = legacy.message_id
            AND newer.operator_user_id = legacy.operator_user_id
            AND (
              newer.updated_at > legacy.updated_at
              OR (
                newer.updated_at = legacy.updated_at
                AND newer.rowid > legacy.rowid
              )
            )
        );
        DROP TABLE response_ratings_v42_legacy;
      `);
  })();
}

function migrateV42(database: Database.Database): void {
  migrateResponseRatingsSchema(database);
  recordMigration(database, 42, 'Persist per-response operator ratings');
}

function auditEventsNeedActorMigration(database: Database.Database): boolean {
  return (
    tableExists(database, 'audit_events') &&
    (!columnExists(database, 'audit_events', 'actor_type') ||
      !columnExists(database, 'audit_events', 'actor_id') ||
      !indexExists(database, 'idx_audit_events_actor_timestamp'))
  );
}

function migrateV43(database: Database.Database): void {
  if (!tableExists(database, 'audit_events')) {
    recordMigration(database, 43, 'Index structured audit events by Actor');
    return;
  }

  addColumnIfMissing({
    database,
    table: 'audit_events',
    column: 'actor_type',
    ddl: "actor_type TEXT CHECK (actor_type IN ('user', 'agent'))",
    quiet: true,
  });
  addColumnIfMissing({
    database,
    table: 'audit_events',
    column: 'actor_id',
    ddl: `actor_id TEXT CHECK (actor_id IS NULL OR length(actor_id) <= ${ACTOR_ID_MAX_LENGTH})`,
    quiet: true,
  });

  const selectBatch = database.prepare(
    `SELECT id, payload
     FROM audit_events
     WHERE (actor_type IS NULL OR actor_id IS NULL)
       AND id > ?
     ORDER BY id ASC
     LIMIT ?`,
  );
  const update = database.prepare(
    `UPDATE audit_events
     SET actor_type = ?, actor_id = ?
     WHERE id = ?`,
  );
  let lastId = 0;
  let skippedRows = 0;
  while (true) {
    const rows = selectBatch.all(
      lastId,
      AUDIT_ACTOR_MIGRATION_BATCH_SIZE,
    ) as Array<{ id: number; payload: string }>;
    if (rows.length === 0) break;

    database.transaction(() => {
      for (const row of rows) {
        lastId = row.id;
        const actor = readAuditActorFromPayloadText(row.payload);
        if (!actor) {
          skippedRows += 1;
          continue;
        }
        update.run(actor.type, actor.id, row.id);
      }
    })();
  }

  if (skippedRows > 0) {
    logger.warn(
      { skippedRows },
      'Structured audit actor migration skipped rows without a recoverable actor',
    );
  }

  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_audit_events_actor_timestamp ON audit_events(actor_type, actor_id, timestamp)',
  );
  recordMigration(database, 43, 'Index structured audit events by Actor');
}

function migrateV44(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'proxy',
    ddl: 'proxy TEXT',
    quiet: opts?.quiet === true,
  });
  recordMigration(database, 44, 'Persist per-agent proxy backend metadata');
}

function migrateV45(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'empty_chat_header',
    ddl: 'empty_chat_header TEXT',
    quiet: opts?.quiet === true,
  });
  recordMigration(database, 45, 'Persist per-agent empty chat header');
}

function migrateV46(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'apps',
      html TEXT NOT NULL,
      prompt TEXT,
      agent_id TEXT,
      session_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_apps_created_at ON apps(created_at);
    CREATE INDEX IF NOT EXISTS idx_apps_category ON apps(category);
  `);
  recordMigration(database, 46, 'Persist generated apps (artifacts gallery)');
}

function appsKindNeedMigration(database: Database.Database): boolean {
  return (
    tableExists(database, 'apps') && !columnExists(database, 'apps', 'kind')
  );
}

function migrateV47(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  const quiet = opts?.quiet === true;
  addColumnIfMissing({
    database,
    table: 'apps',
    column: 'kind',
    ddl: "kind TEXT NOT NULL DEFAULT 'web'",
    quiet,
  });
  addColumnIfMissing({
    database,
    table: 'apps',
    column: 'source_key',
    ddl: 'source_key TEXT',
    quiet,
  });
  if (tableExists(database, 'apps')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_apps_session_source
        ON apps(session_id, source_key);
    `);
  }
  recordMigration(database, 47, 'Add app kind (web/live) and source key');
}

function migrateV48(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  addColumnIfMissing({
    database,
    table: 'messages',
    column: 'activity_trace_json',
    ddl: 'activity_trace_json TEXT',
    quiet: opts?.quiet === true,
  });
  recordMigration(database, 48, 'Persist web-chat activity traces per message');
}

function migrateV49(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      claims TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      created_by TEXT,
      expires_at TEXT,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_token_hash
      ON api_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_created_at
      ON api_tokens(created_at);
  `);
  recordMigration(database, 49, 'Persist scoped API token registry');
}

function migrateV50(database: Database.Database): void {
  createDelegationJobsSchema(database);
  recordMigration(database, 50, 'Persist delegated job status and results');
}

function migrateV51(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_publications (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      policy TEXT NOT NULL,
      embed_hosts TEXT NOT NULL DEFAULT '[]',
      allow_bridge INTEGER NOT NULL DEFAULT 0,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      created_by TEXT,
      expires_at TEXT,
      revoked_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_app_publications_token_hash
      ON app_publications(token_hash);
    CREATE INDEX IF NOT EXISTS idx_app_publications_app
      ON app_publications(app_id);
  `);
  recordMigration(database, 51, 'Persist app publication records');
}

// Version 52 was already assigned to agent sharing in a parallel migration.
function agentArchivedNeedMigration(database: Database.Database): boolean {
  return (
    tableExists(database, 'agents') &&
    !columnExists(database, 'agents', 'archived')
  );
}

function migrateV53(
  database: Database.Database,
  opts?: InitDatabaseOptions,
): void {
  addColumnIfMissing({
    database,
    table: 'agents',
    column: 'archived',
    ddl: 'archived INTEGER NOT NULL DEFAULT 0',
    quiet: opts?.quiet === true,
  });
  recordMigration(database, 53, 'Persist archived agent state');
}

export function runMigrations(
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
  if (currentVersion < 20 || messageAgentIdentityNeedMigration(database)) {
    migrateV20(database, opts);
  }
  if (currentVersion < 21) migrateV21(database, opts);
  if (currentVersion < 22 || adminStatisticsIndexesNeedMigration(database)) {
    migrateV22(database);
  }
  if (
    currentVersion < 23 ||
    skillObservationsNeedAgentMigration(database) ||
    agentSkillScoresNeedMigration(database)
  ) {
    migrateV23(database, opts);
  }
  if (currentVersion < 24 || messageArtifactsNeedMigration(database)) {
    migrateV24(database, opts);
  }
  if (currentVersion < 25) migrateV25(database, opts);
  if (currentVersion < 26) migrateV26(database, opts);
  if (currentVersion < 27) migrateV27(database, opts);
  if (currentVersion < 28) migrateV28(database, opts);
  if (
    currentVersion < 29 ||
    sessionTitleSourceConstraintNeedMigration(database)
  ) {
    migrateV29(database);
  }
  if (currentVersion < 30 || agentA2ANeedMigration(database)) {
    migrateV30(database, opts);
  }
  if (currentVersion < 31 || boardCardsNeedMigration(database)) {
    migrateV31(database);
  }
  if (currentVersion < 32 || threadGoalsNeedMigration(database)) {
    migrateV32(database);
  }
  if (currentVersion < 33 || budgetSoftWarnEventsNeedMigration(database)) {
    migrateV33(database);
  }
  if (currentVersion < 34) migrateV34(database);
  if (currentVersion < 35) migrateV35(database, opts);
  if (currentVersion < 36 || agentCanonicalIdentityNeedMigration(database)) {
    migrateV36(database, opts);
  }
  if (currentVersion < 37 || boardCardEdgesNeedMigration(database)) {
    migrateV37(database);
  }
  if (currentVersion < 38) {
    migrateV38(database, opts);
  }
  if (currentVersion < 39) {
    migrateV39(database);
  }
  if (currentVersion < 40 || auditTimestampIndexNeedMigration(database)) {
    migrateV40(database);
  }
  if (
    currentVersion < 41 ||
    budgetSoftWarnEventUnitsNeedMigration(database) ||
    budgetSoftWarnEventUnitKeyNeedMigration(database)
  ) {
    migrateV41(database);
  }
  if (currentVersion < 42 || responseRatingsNeedMigration(database)) {
    migrateV42(database);
  }
  if (currentVersion < 43 || auditEventsNeedActorMigration(database)) {
    migrateV43(database);
  }
  if (currentVersion < 44 || agentProxyNeedMigration(database)) {
    migrateV44(database, opts);
  }
  if (currentVersion < 45 || agentEmptyChatHeaderNeedMigration(database)) {
    migrateV45(database, opts);
  }
  if (currentVersion < 46) migrateV46(database);
  if (currentVersion < 47 || appsKindNeedMigration(database)) {
    migrateV47(database, opts);
  }
  if (currentVersion < 48) migrateV48(database, opts);
  if (currentVersion < 49) migrateV49(database);
  if (currentVersion < 50) migrateV50(database);
  if (currentVersion < 51) migrateV51(database);
  if (currentVersion < 53 || agentArchivedNeedMigration(database)) {
    migrateV53(database, opts);
  }

  setSchemaVersion(database, DATABASE_SCHEMA_VERSION);
  if (!quiet && currentVersion < DATABASE_SCHEMA_VERSION) {
    logger.info(
      { fromVersion: currentVersion, toVersion: DATABASE_SCHEMA_VERSION },
      'Database schema migrated',
    );
  }
}
