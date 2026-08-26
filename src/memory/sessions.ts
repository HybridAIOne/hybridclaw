import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import {
  getRuntimeConfig,
  resolveDefaultAgentId,
} from '../config/runtime-config.js';
import type { Actor } from '../identity/actor.js';
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
import type { StructuredAuditEntry } from '../types/audit.js';
import type { StructuredMemoryEntry } from '../types/memory.js';
import type {
  ForkSessionBranchParams,
  ForkSessionBranchResult,
  Session,
  SessionShowMode,
  SessionTitleSource,
} from '../types/session.js';
import { isApprovalHistoryMessage } from '../utils/approval-text.js';
import { normalizeNonNegativeInteger } from '../utils/number-normalization.js';
import { hydrateStructuredAuditEntry } from './audit.js';
import {
  withInitializedMemoryDatabase,
  withMemoryDatabase,
} from './database.js';
import {
  ensureSessionBranchesTable,
  hasSessionCurrentColumn,
  hasSessionKeyColumn,
  hasSessionLegacySessionIdColumn,
  hasSessionMainKeyColumn,
  tableExists,
} from './schema/migrations.js';
import { queryAll, queryOne } from './sqlite.js';

const RECENT_CHAT_MESSAGE_SEARCH_TABLE = 'recent_chat_message_search';
const STRUCTURED_AUDIT_SELECT_COLUMNS = [
  'id',
  'session_id',
  'seq',
  'event_type',
  'timestamp',
  'run_id',
  'parent_run_id',
  'actor_type',
  'actor_id',
  'payload',
  'wire_hash',
  'wire_prev_hash',
  'created_at',
].join(', ');

function getSessionDatabase(): Database.Database {
  return withMemoryDatabase((database) => database);
}

function normalizeUsageNumber(value: unknown): number {
  return normalizeNonNegativeInteger(value);
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

function queryHydratedAuditEntries<Bind extends unknown[] = []>(
  database: Database.Database,
  sql: string,
  ...params: Bind
): StructuredAuditEntry[] {
  return queryAll<StructuredAuditEntry, Bind>(database, sql, ...params).map(
    hydrateStructuredAuditEntry,
  );
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
    getSessionDatabase(),
    'SELECT * FROM sessions WHERE id = ?',
    sessionId,
  );
}

function selectCurrentSessionBySessionKey(
  sessionKey: string,
): Session | undefined {
  if (
    !hasSessionKeyColumn(getSessionDatabase()) ||
    !hasSessionCurrentColumn(getSessionDatabase())
  )
    return undefined;
  return queryOne<Session, [string]>(
    getSessionDatabase(),
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
  if (
    !hasSessionMainKeyColumn(getSessionDatabase()) ||
    !hasSessionCurrentColumn(getSessionDatabase())
  ) {
    return undefined;
  }
  return queryOne<Session, [string]>(
    getSessionDatabase(),
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
  if (
    !hasSessionLegacySessionIdColumn(getSessionDatabase()) ||
    !hasSessionCurrentColumn(getSessionDatabase())
  ) {
    return undefined;
  }
  return queryOne<Session, [string]>(
    getSessionDatabase(),
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
  withInitializedMemoryDatabase(() => undefined);
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
    touch?: boolean;
  },
): Session {
  const requestedSessionId = String(sessionId || '').trim();
  const requestedAgentId = agentId?.trim() || '';
  const defaultAgentId = resolveDefaultAgentId(getRuntimeConfig());
  const forceNewCurrent = options?.forceNewCurrent === true;
  const touch = options?.touch !== false;
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
    getSessionDatabase()
      .prepare(
        `UPDATE sessions
       SET agent_id = ?,
           guild_id = ?,
           channel_id = ?,
           session_key = ?,
           main_session_key = ?,
           last_active = CASE WHEN ? THEN datetime('now') ELSE last_active END
       WHERE id = ?`,
      )
      .run(
        nextAgentId,
        guildId,
        channelId,
        canonicalSessionKey || exactSession.id,
        mainSessionKey || canonicalSessionKey || exactSession.id,
        touch ? 1 : 0,
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
    getSessionDatabase()
      .prepare(
        `UPDATE sessions
       SET agent_id = ?,
           guild_id = ?,
           channel_id = ?,
           session_key = ?,
           main_session_key = ?,
           last_active = CASE WHEN ? THEN datetime('now') ELSE last_active END,
           legacy_session_id = CASE
             WHEN ? THEN ?
             ELSE legacy_session_id
           END
       WHERE id = ?`,
      )
      .run(
        nextAgentId,
        guildId,
        channelId,
        canonicalSessionKey || existing.id,
        mainSessionKey || canonicalSessionKey || existing.id,
        touch ? 1 : 0,
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
  getSessionDatabase()
    .prepare(
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
    )
    .run(
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
  const normalized = String(sessionId || '').trim();
  if (!normalized) return undefined;
  return (
    selectSessionById(normalized) ||
    selectCurrentSessionBySessionKey(normalized) ||
    selectCurrentSessionByMainSessionKey(normalized) ||
    selectCurrentSessionByLegacySessionId(normalized)
  );
}

export function sessionHasUserMessages(sessionId: string): boolean {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  if (!resolvedSessionId) return false;
  const row = queryOne<{ count: number }, [string]>(
    getSessionDatabase(),
    `SELECT COUNT(*) AS count
     FROM messages
     WHERE session_id = ?
       AND role = 'user'`,
    resolvedSessionId,
  );
  return normalizeUsageNumber(row?.count) > 0;
}

export function getSessionsByChannelId(channelId: string): Session[] {
  const normalized = String(channelId || '').trim();
  if (!normalized) return [];
  return queryAll<Session, [string]>(
    getSessionDatabase(),
    `SELECT *
     FROM sessions
     WHERE channel_id = ?
     ORDER BY created_at DESC, last_active DESC, id DESC`,
    normalized,
  );
}

function countSessionMessages(sessionId: string): number {
  const row = queryOne<{ count: number }, [string]>(
    getSessionDatabase(),
    'SELECT COUNT(*) AS count FROM messages WHERE session_id = ?',
    sessionId,
  );
  return row?.count ?? 0;
}

type SessionMemoryKvRow = Omit<StructuredMemoryEntry, 'value'> & {
  value: Buffer | Uint8Array | string;
};

function copySessionKvStore(
  previousSessionId: string,
  nextSessionId: string,
): void {
  if (!tableExists(getSessionDatabase(), 'kv_store')) return;
  const rows = queryAll<SessionMemoryKvRow, [string]>(
    getSessionDatabase(),
    `SELECT key, value, version, updated_at
     FROM kv_store
     WHERE agent_id = ?`,
    previousSessionId,
  );
  if (rows.length === 0) return;
  const insert = getSessionDatabase().prepare(
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
  const branchTarget = getSessionDatabase()
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

  const fork = getSessionDatabase().transaction(() => {
    ensureSessionBranchesTable(getSessionDatabase());
    const copiedMessageCount =
      (
        getSessionDatabase()
          .prepare(
            `SELECT COUNT(*) AS count
             FROM messages
             WHERE session_id = ?
               AND id < ?`,
          )
          .get(sourceSession.id, beforeMessageId) as { count: number }
      ).count || 0;
    getSessionDatabase()
      .prepare(
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
      )
      .run(
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
    getSessionDatabase()
      .prepare(
        `INSERT INTO session_branches (
         session_id,
         parent_session_id,
         parent_message_id,
         copied_message_count
       ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        nextSessionId,
        sourceSession.id,
        beforeMessageId,
        copiedMessageCount,
      );
    copySessionKvStore(sourceSession.id, nextSessionId);
    getSessionDatabase()
      .prepare(
        `INSERT INTO messages (session_id, user_id, username, role, agent_id, content, artifacts_json, activity_trace_json, created_at)
       SELECT ?, user_id, username, role, agent_id, content, artifacts_json, activity_trace_json, created_at
       FROM messages
       WHERE session_id = ?
         AND id < ?
       ORDER BY id ASC`,
      )
      .run(nextSessionId, sourceSession.id, beforeMessageId);
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

  const rotate = getSessionDatabase().transaction(() => {
    if (hasSessionLegacySessionIdColumn(getSessionDatabase())) {
      getSessionDatabase()
        .prepare('UPDATE sessions SET legacy_session_id = NULL WHERE id = ?')
        .run(previousSession.id);
    }
    if (hasSessionCurrentColumn(getSessionDatabase())) {
      getSessionDatabase()
        .prepare('UPDATE sessions SET is_current = 0 WHERE session_key = ?')
        .run(nextSessionKey);
    }
    getSessionDatabase()
      .prepare(
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
      )
      .run(
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
    getSessionDatabase()
      .prepare('UPDATE tasks SET session_id = ? WHERE session_id = ?')
      .run(nextSessionId, previousSession.id);
    getSessionDatabase()
      .prepare(
        "UPDATE jobs SET session_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE kind = 'scheduled_task' AND session_id = ?",
      )
      .run(nextSessionId, previousSession.id);
    copySessionKvStore(previousSession.id, nextSessionId);
  });
  rotate();

  return {
    previousSession,
    session: requireSessionById(nextSessionId),
    deletedMessages,
  };
}

export function listSessionInstancesForKey(
  sessionKey: string,
  options?: { limit?: number },
): Session[] {
  const normalizedKey = String(sessionKey || '').trim();
  if (!normalizedKey) return [];
  const limit = Math.max(1, Math.floor(options?.limit ?? 10));
  return queryAll<Session, [string, number]>(
    getSessionDatabase(),
    `SELECT *
     FROM sessions
     WHERE session_key = ?
     ORDER BY is_current DESC, last_active DESC
     LIMIT ?`,
    normalizedKey,
    limit,
  );
}

export function switchCurrentSessionInstance(params: {
  sessionKey: string;
  targetSessionId: string;
}): { previousSession: Session | null; session: Session } {
  const normalizedKey = String(params.sessionKey || '').trim();
  const target = getSessionById(String(params.targetSessionId || '').trim());
  if (!target) {
    throw new Error(`Session ${params.targetSessionId} was not found.`);
  }
  if (!normalizedKey || target.session_key !== normalizedKey) {
    throw new Error(
      `Session ${target.id} does not belong to this conversation.`,
    );
  }
  const previousSession =
    selectCurrentSessionBySessionKey(normalizedKey) || null;
  if (previousSession?.id === target.id) {
    return { previousSession, session: target };
  }

  const nowIso = new Date().toISOString();
  const switchTx = getSessionDatabase().transaction(() => {
    getSessionDatabase()
      .prepare('UPDATE sessions SET is_current = 0 WHERE session_key = ?')
      .run(normalizedKey);
    getSessionDatabase()
      .prepare(
        'UPDATE sessions SET is_current = 1, last_active = ? WHERE id = ?',
      )
      .run(nowIso, target.id);
  });
  switchTx();

  return { previousSession, session: requireSessionById(target.id) };
}

export function getAnyChatbotId(): string | null {
  const row = queryOne<Pick<Session, 'chatbot_id'>>(
    getSessionDatabase(),
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
  getSessionDatabase()
    .prepare('UPDATE sessions SET chatbot_id = ? WHERE id = ?')
    .run(chatbotId, resolvedSessionId);
}

export function updateSessionAgent(sessionId: string, agentId: string): void {
  const normalizedAgentId =
    agentId.trim() || resolveDefaultAgentId(getRuntimeConfig());
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  getSessionDatabase()
    .prepare('UPDATE sessions SET agent_id = ? WHERE id = ?')
    .run(normalizedAgentId, resolvedSessionId);
}

export function updateSessionModel(
  sessionId: string,
  model: string | null,
): void {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  getSessionDatabase()
    .prepare('UPDATE sessions SET model = ? WHERE id = ?')
    .run(model, resolvedSessionId);
}

export function updateSessionRag(sessionId: string, enableRag: boolean): void {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  getSessionDatabase()
    .prepare('UPDATE sessions SET enable_rag = ? WHERE id = ?')
    .run(enableRag ? 1 : 0, resolvedSessionId);
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
  getSessionDatabase()
    .prepare(
      `UPDATE sessions
     SET full_auto_enabled = ?,
         full_auto_prompt = ?,
         full_auto_started_at = ?
     WHERE id = ?`,
    )
    .run(
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
  getSessionDatabase()
    .prepare('UPDATE sessions SET show_mode = ? WHERE id = ?')
    .run(showMode, resolvedSessionId);
}

export function getSessionTitle(sessionId: string): {
  title: string | null;
  source: SessionTitleSource | null;
} {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const row = queryOne<{ title: string | null; title_source: string | null }>(
    getSessionDatabase(),
    'SELECT title, title_source FROM sessions WHERE id = ?',
    resolvedSessionId,
  );
  if (!row) return { title: null, source: null };
  const source = row.title_source === 'auto' ? row.title_source : null;
  return { title: row.title, source };
}

function normalizeSessionTitleForStorage(title: string): string | null {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) return null;
  return normalizedTitle.slice(0, RECENT_CHAT_SESSION_TITLE_MAX_LENGTH);
}

export function setSessionTitle(sessionId: string, title: string): void {
  const normalizedTitle = normalizeSessionTitleForStorage(title);
  if (!normalizedTitle) return;
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  getSessionDatabase()
    .prepare(
      'UPDATE sessions SET title = ?, title_source = ? WHERE id = ? AND title IS NULL',
    )
    .run(normalizedTitle, 'auto', resolvedSessionId);
}

export function getAllSessions(options?: {
  limit?: number;
  warnLabel?: string;
}): Session[] {
  const limit =
    options?.limit == null ? null : Math.max(1, Math.floor(options.limit));
  const warnLabel = options?.warnLabel || null;
  const sql = hasSessionCurrentColumn(getSessionDatabase())
    ? `SELECT * FROM sessions WHERE is_current = 1 ORDER BY last_active DESC${limit == null ? '' : ' LIMIT ?'}`
    : `SELECT * FROM sessions ORDER BY last_active DESC${limit == null ? '' : ' LIMIT ?'}`;
  const rows =
    limit == null
      ? queryAll<Session>(getSessionDatabase(), sql)
      : queryAll<Session, [number]>(getSessionDatabase(), sql, limit + 1);
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

export function getRecentSessionsForAgents(
  agentIds: readonly string[],
  perAgentLimit = 8,
): Session[] {
  const normalizedAgentIds = Array.from(
    new Set(
      agentIds
        .map((agentId) => (agentId || DEFAULT_AGENT_ID).trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
  if (normalizedAgentIds.length === 0) return [];
  const limit = Math.max(1, Math.min(64, Math.trunc(perAgentLimit || 8)));
  const placeholders = normalizedAgentIds.map(() => '?').join(', ');
  const currentWhere = hasSessionCurrentColumn(getSessionDatabase())
    ? 'is_current = 1 AND '
    : '';
  return queryAll<Session, Array<string | number>>(
    getSessionDatabase(),
    `WITH ranked_sessions AS (
       SELECT
         *,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(NULLIF(TRIM(agent_id), ''), ?)
           ORDER BY last_active DESC, id DESC
         ) AS liveness_rank
       FROM sessions
       WHERE ${currentWhere}COALESCE(NULLIF(TRIM(agent_id), ''), ?) IN (${placeholders})
     )
     SELECT *
     FROM ranked_sessions
     WHERE liveness_rank <= ?
     ORDER BY last_active DESC, id DESC`,
    DEFAULT_AGENT_ID,
    DEFAULT_AGENT_ID,
    ...normalizedAgentIds,
    limit,
  );
}

export interface RecentUserSessionSummary {
  sessionId: string;
  lastActive: string;
  messageCount: number;
  title: string | null;
  searchSnippet?: string | null;
}

interface RecentUserSessionRow {
  id: string;
  last_active: string;
  last_message_at: string | null;
  message_count: number;
  title: string | null;
}

const NON_SCHEDULED_RECENT_SESSION_SQL =
  "s.id NOT LIKE 'cron:%' AND s.id NOT LIKE '%:chat:cron:%'";

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
      getSessionDatabase(),
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
      getSessionDatabase(),
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

function normalizeRecentSessionTimestamp(raw: string): string {
  const timestamp = parseTimestamp(raw);
  return timestamp > 0 ? new Date(timestamp).toISOString() : raw;
}

function buildRecentSessionSummaries(params: {
  rows: RecentUserSessionRow[];
  boundaryUserId: string | null;
  searchQuery: string;
  limit: number;
}): RecentUserSessionSummary[] {
  const sortedRows = [...params.rows].sort((left, right) => {
    const rightTimestamp = parseTimestamp(
      right.last_message_at || right.last_active,
    );
    const leftTimestamp = parseTimestamp(
      left.last_message_at || left.last_active,
    );
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
    const storedTitle = (row.title || '').trim();
    const title =
      storedTitle ||
      buildSessionBoundaryPreview({
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
      lastActive: normalizeRecentSessionTimestamp(
        row.last_message_at || row.last_active,
      ),
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
  includeScheduled?: boolean;
}): RecentUserSessionSummary[] {
  const userId = params.userId.trim();
  if (!userId) return [];
  const channelId = String(params.channelId || '').trim();
  const searchQuery = normalizeRecentChatSearchQuery(
    params.query,
  ).toLowerCase();
  const limit = normalizeRecentChatSessionLimit(params.limit);
  const scheduledWhere =
    params.includeScheduled === false
      ? ` AND ${NON_SCHEDULED_RECENT_SESSION_SQL}`
      : '';

  const rows = channelId
    ? queryAll<RecentUserSessionRow, [string, string]>(
        getSessionDatabase(),
        `SELECT
           s.id,
           s.last_active,
           s.message_count,
           s.title,
           (
             SELECT MAX(all_messages.created_at)
               FROM messages all_messages
              WHERE all_messages.session_id = s.id
           ) AS last_message_at
           FROM sessions s
           INNER JOIN messages m
             ON m.session_id = s.id
           WHERE m.user_id = ?
             AND s.channel_id = ?
             ${scheduledWhere}
           GROUP BY s.id`,
        userId,
        channelId,
      )
    : queryAll<RecentUserSessionRow, [string]>(
        getSessionDatabase(),
        `SELECT
           s.id,
           s.last_active,
           s.message_count,
           s.title,
           (
             SELECT MAX(all_messages.created_at)
               FROM messages all_messages
              WHERE all_messages.session_id = s.id
           ) AS last_message_at
           FROM sessions s
           INNER JOIN messages m
             ON m.session_id = s.id
           WHERE m.user_id = ?
             ${scheduledWhere}
           GROUP BY s.id`,
        userId,
      );

  return buildRecentSessionSummaries({
    rows,
    boundaryUserId: userId,
    searchQuery,
    limit,
  });
}

export function getRecentSessionsForActor(params: {
  actor: Actor;
  channelId?: string | null;
  limit?: number;
  query?: string | null;
  includeScheduled?: boolean;
}): RecentUserSessionSummary[] {
  if (params.actor.type === 'user') {
    return getRecentSessionsForUser({
      userId: params.actor.id,
      channelId: params.channelId,
      limit: params.limit,
      query: params.query,
      includeScheduled: params.includeScheduled,
    });
  }

  const agentId = params.actor.id.trim();
  if (!agentId) return [];
  const channelId = String(params.channelId || '').trim();
  const searchQuery = normalizeRecentChatSearchQuery(
    params.query,
  ).toLowerCase();
  const limit = normalizeRecentChatSessionLimit(params.limit);
  const sqlLimit = searchQuery ? MAX_RECENT_CHAT_SESSION_LIMIT : limit;
  const scheduledWhere =
    params.includeScheduled === false
      ? ` AND ${NON_SCHEDULED_RECENT_SESSION_SQL}`
      : '';

  const rows = channelId
    ? queryAll<RecentUserSessionRow, [string, string, number]>(
        getSessionDatabase(),
        `SELECT
           s.id,
           s.last_active,
           s.message_count,
           s.title,
           (
             SELECT MAX(all_messages.created_at)
               FROM messages all_messages
              WHERE all_messages.session_id = s.id
           ) AS last_message_at
           FROM sessions s
           WHERE s.agent_id = ?
             AND s.channel_id = ?
             ${scheduledWhere}
           ORDER BY COALESCE(last_message_at, s.last_active) DESC
           LIMIT ?`,
        agentId,
        channelId,
        sqlLimit,
      )
    : queryAll<RecentUserSessionRow, [string, number]>(
        getSessionDatabase(),
        `SELECT
           s.id,
           s.last_active,
           s.message_count,
           s.title,
           (
             SELECT MAX(all_messages.created_at)
               FROM messages all_messages
              WHERE all_messages.session_id = s.id
           ) AS last_message_at
           FROM sessions s
           WHERE s.agent_id = ?
             ${scheduledWhere}
           ORDER BY COALESCE(last_message_at, s.last_active) DESC
           LIMIT ?`,
        agentId,
        sqlLimit,
      );

  return buildRecentSessionSummaries({
    rows,
    boundaryUserId: null,
    searchQuery,
    limit,
  });
}

export interface ActorDataDiscoveryResult {
  actor: Actor;
  sessions: RecentUserSessionSummary[];
  auditEvents: StructuredAuditEntry[];
}

export function discoverActorData(params: {
  actor: Actor;
  channelId?: string | null;
  limit?: number;
  query?: string | null;
  includeScheduled?: boolean;
  auditLimit?: number;
}): ActorDataDiscoveryResult {
  const sessions = getRecentSessionsForActor({
    actor: params.actor,
    channelId: params.channelId,
    limit: params.limit,
    query: params.query,
    includeScheduled: params.includeScheduled,
  });
  const auditLimit = Math.max(
    1,
    Math.min(Math.trunc(params.auditLimit ?? 200), 1_000),
  );
  const auditEvents = queryHydratedAuditEntries<[string, string, number]>(
    getSessionDatabase(),
    `SELECT ${STRUCTURED_AUDIT_SELECT_COLUMNS}
     FROM audit_events
     WHERE actor_type = ?
       AND actor_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    params.actor.type,
    params.actor.id,
    auditLimit,
  );

  return {
    actor: params.actor,
    sessions,
    auditEvents,
  };
}

export function getRecentSessionsForChannel(params: {
  channelId: string;
  limit?: number;
  query?: string | null;
  includeScheduled?: boolean;
}): RecentUserSessionSummary[] {
  const channelId = params.channelId.trim();
  if (!channelId) return [];
  const searchQuery = normalizeRecentChatSearchQuery(
    params.query,
  ).toLowerCase();
  const limit = normalizeRecentChatSessionLimit(params.limit);
  const sqlLimit = searchQuery ? MAX_RECENT_CHAT_SESSION_LIMIT : limit;
  const scheduledWhere =
    params.includeScheduled === false
      ? ` AND ${NON_SCHEDULED_RECENT_SESSION_SQL}`
      : '';

  const rows = queryAll<RecentUserSessionRow, [string, number]>(
    getSessionDatabase(),
    `SELECT
       s.id,
       s.last_active,
       s.message_count,
       s.title,
       MAX(m.created_at) AS last_message_at
       FROM sessions s
       INNER JOIN messages m
          ON m.session_id = s.id
      WHERE s.channel_id = ?
        ${scheduledWhere}
      GROUP BY s.id
      ORDER BY last_message_at DESC
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
    getSessionDatabase(),
    hasSessionCurrentColumn(getSessionDatabase())
      ? 'SELECT COUNT(*) as count FROM sessions WHERE is_current = 1 AND full_auto_enabled = 1'
      : 'SELECT COUNT(*) as count FROM sessions WHERE full_auto_enabled = 1',
  ) || { count: 0 };
  return row.count;
}

export function getEnabledFullAutoSessions(): Session[] {
  const sql = hasSessionCurrentColumn(getSessionDatabase())
    ? 'SELECT * FROM sessions WHERE is_current = 1 AND full_auto_enabled = 1 ORDER BY last_active DESC'
    : 'SELECT * FROM sessions WHERE full_auto_enabled = 1 ORDER BY last_active DESC';
  return queryAll<Session>(getSessionDatabase(), sql);
}

export function getSessionCount(): number {
  const sql = hasSessionCurrentColumn(getSessionDatabase())
    ? 'SELECT COUNT(*) as count FROM sessions WHERE is_current = 1'
    : 'SELECT COUNT(*) as count FROM sessions';
  const row = queryOne<{ count: number }>(getSessionDatabase(), sql) || {
    count: 0,
  };
  return row.count;
}

export function getMostRecentSessionChannelId(): string | null {
  const row = queryOne<Pick<Session, 'channel_id'>>(
    getSessionDatabase(),
    hasSessionCurrentColumn(getSessionDatabase())
      ? 'SELECT channel_id FROM sessions WHERE is_current = 1 ORDER BY last_active DESC LIMIT 1'
      : 'SELECT channel_id FROM sessions ORDER BY last_active DESC LIMIT 1',
  );
  if (!row || typeof row.channel_id !== 'string') return null;
  const channelId = row.channel_id.trim();
  return channelId || null;
}

export function clearSessionHistory(sessionId: string): number {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const result = getSessionDatabase()
    .prepare('DELETE FROM messages WHERE session_id = ?')
    .run(resolvedSessionId);
  getSessionDatabase()
    .prepare('DELETE FROM semantic_memories WHERE session_id = ?')
    .run(resolvedSessionId);
  getSessionDatabase()
    .prepare(
      'UPDATE sessions SET message_count = 0, session_summary = NULL, summary_updated_at = NULL, compaction_count = 0, memory_flush_at = NULL WHERE id = ?',
    )
    .run(resolvedSessionId);
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
  const transaction = getSessionDatabase().transaction((value: string) => {
    const deletedMessages = getSessionDatabase()
      .prepare('DELETE FROM messages WHERE session_id = ?')
      .run(value).changes;
    const deletedSemanticMemories = getSessionDatabase()
      .prepare('DELETE FROM semantic_memories WHERE session_id = ?')
      .run(value).changes;
    const deletedLegacyTasks = getSessionDatabase()
      .prepare('DELETE FROM tasks WHERE session_id = ?')
      .run(value).changes;
    const deletedScheduledTaskJobs = getSessionDatabase()
      .prepare(
        "DELETE FROM jobs WHERE kind = 'scheduled_task' AND session_id = ?",
      )
      .run(value).changes;
    const deletedTasks = deletedLegacyTasks + deletedScheduledTaskJobs;
    const deletedAuditEntries = getSessionDatabase()
      .prepare('DELETE FROM audit_log WHERE session_id = ?')
      .run(value).changes;
    const deletedStructuredAuditEntries = getSessionDatabase()
      .prepare('DELETE FROM audit_events WHERE session_id = ?')
      .run(value).changes;
    const deletedApprovalEntries = getSessionDatabase()
      .prepare('DELETE FROM approvals WHERE session_id = ?')
      .run(value).changes;
    const deletedUsageEvents = getSessionDatabase()
      .prepare('DELETE FROM usage_events WHERE session_id = ?')
      .run(value).changes;
    const deletedSession = getSessionDatabase()
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
