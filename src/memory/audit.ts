import type Database from 'better-sqlite3';
import type { WireRecord } from '../audit/audit-trail.js';
import {
  type Actor,
  ActorValidationError,
  actorFromLegacyFields,
  createUserActor,
  normalizeActor,
} from '../identity/actor.js';
import { formatLocalOwnerUserId } from '../identity/agent-id.js';
import { logger } from '../logger.js';
import type {
  ApprovalAuditEntry,
  AuditEntry,
  StructuredAuditEntry,
} from '../types/audit.js';
import {
  withInitializedMemoryDatabase,
  withMemoryDatabase,
} from './database.js';
import { queryAll, queryOne } from './sqlite.js';

const STRUCTURED_AUDIT_SESSION_LIMIT = 10_000;
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

function getAuditDatabase(): Database.Database {
  return withMemoryDatabase((database) => database);
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

export function logAudit(
  event: string,
  sessionId?: string,
  detail?: Record<string, unknown>,
  durationMs?: number,
): void {
  getAuditDatabase()
    .prepare(
      'INSERT INTO audit_log (session_id, event, detail, duration_ms) VALUES (?, ?, ?, ?)',
    )
    .run(
      sessionId || null,
      event,
      detail ? JSON.stringify(detail) : null,
      durationMs || null,
    );
}

export function getRecentAudit(limit = 20): AuditEntry[] {
  return queryAll<AuditEntry, [number]>(
    getAuditDatabase(),
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

interface ReadPayloadActorOptions {
  warnInvalidLegacy?: boolean;
  context?: Record<string, unknown>;
}

function warnInvalidAuditActor(
  error: unknown,
  options?: ReadPayloadActorOptions,
): void {
  if (!(error instanceof ActorValidationError)) throw error;
  if (!options?.warnInvalidLegacy) return;
  logger.warn(
    { ...options.context, error: error.message },
    'Structured audit event has invalid actor fields',
  );
}

function readPayloadActor(
  payload: Record<string, unknown>,
  options?: ReadPayloadActorOptions,
): Actor | null {
  const actor = payload.actor;
  if (actor && typeof actor === 'object' && !Array.isArray(actor)) {
    const actorRecord = actor as Record<string, unknown>;
    if (!('type' in actorRecord) && !('id' in actorRecord)) return null;
    try {
      return normalizeActor(actor);
    } catch (error) {
      warnInvalidAuditActor(error, options);
      return null;
    }
  }

  try {
    return readPayloadActorFromLegacyFields(payload);
  } catch (error) {
    warnInvalidAuditActor(error, options);
    return null;
  }
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

export function hydrateStructuredAuditEntry(
  entry: StructuredAuditEntry,
): StructuredAuditEntry {
  if (entry.actor_type && entry.actor_id) return entry;

  const actor =
    entry.actor_type && entry.actor_id
      ? ({ type: entry.actor_type, id: entry.actor_id } as Actor)
      : readAuditActorFromPayloadText(entry.payload);
  if (!actor) return entry;

  return {
    ...entry,
    actor_type: actor.type,
    actor_id: actor.id,
  };
}

export function logStructuredAuditEvent(record: WireRecord): void {
  const eventType = record.event.type || 'unknown';
  const actor = readPayloadActor(record.event, {
    warnInvalidLegacy: true,
    context: { eventType, seq: record.seq, sessionId: record.sessionId },
  });
  const payloadText = JSON.stringify(record.event);

  withInitializedMemoryDatabase((database) => {
    database
      .prepare(
        `INSERT OR IGNORE INTO audit_events (
      session_id, seq, event_type, timestamp, run_id, parent_run_id, actor_type, actor_id, payload, wire_hash, wire_prev_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.sessionId,
        record.seq,
        eventType,
        record.timestamp,
        record.runId,
        record.parentRunId || null,
        actor?.type ?? null,
        actor?.id ?? null,
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

    database
      .prepare(
        `INSERT INTO approvals (
      session_id, tool_call_id, action, description, approved, approved_by, method, policy_name, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
  });
}

export function getRecentStructuredAudit(limit = 20): StructuredAuditEntry[] {
  const bounded = Math.max(1, Math.min(limit, 1_000));
  return queryHydratedAuditEntries<[number]>(
    getAuditDatabase(),
    `SELECT ${STRUCTURED_AUDIT_SELECT_COLUMNS}
     FROM audit_events
     ORDER BY id DESC
     LIMIT ?`,
    bounded,
  );
}

export interface AgentAnomalyRollup {
  actor: Actor;
  agent_id: string;
  flagged: number;
  confirmed_normal: number;
}

function readPayloadObject(payload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function startOfUtcWeek(date: Date): string {
  const value = Number.isNaN(date.getTime()) ? new Date() : date;
  const dayOffset = (value.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate() - dayOffset,
      0,
      0,
      0,
      0,
    ),
  ).toISOString();
}

export function getWeeklyAgentAnomalyRollups(
  now = new Date(),
): AgentAnomalyRollup[] {
  const cutoff = startOfUtcWeek(now);
  const rows = queryAll<{ agent_id: string | null; payload: string }, [string]>(
    getAuditDatabase(),
    `SELECT COALESCE(NULLIF(TRIM(s.agent_id), ''), 'default') AS agent_id,
            ae.payload AS payload
     FROM audit_events ae
     LEFT JOIN sessions s ON s.id = ae.session_id
     WHERE ae.event_type = 'autonomy.decision'
       AND ae.timestamp >= ?
     ORDER BY ae.id DESC`,
    cutoff,
  );
  const byAgent = new Map<string, AgentAnomalyRollup>();
  for (const row of rows) {
    const payload = readPayloadObject(row.payload);
    const anomaly =
      payload.anomaly &&
      typeof payload.anomaly === 'object' &&
      !Array.isArray(payload.anomaly)
        ? (payload.anomaly as Record<string, unknown>)
        : null;
    if (!anomaly) continue;
    const score = Number(anomaly.score);
    const threshold = Number(anomaly.threshold);
    if (!Number.isFinite(score) || !Number.isFinite(threshold)) continue;
    if (score <= threshold) continue;
    const agentId = row.agent_id || 'default';
    const rollup =
      byAgent.get(agentId) ||
      ({
        actor: { type: 'agent', id: agentId },
        agent_id: agentId,
        flagged: 0,
        confirmed_normal: 0,
      } satisfies AgentAnomalyRollup);
    rollup.flagged += 1;
    const decision = String(payload.approvalDecision || '').trim();
    if (decision !== 'required' && decision !== 'denied') {
      rollup.confirmed_normal += 1;
    }
    byAgent.set(agentId, rollup);
  }
  return [...byAgent.values()].sort((left, right) =>
    left.agent_id.localeCompare(right.agent_id),
  );
}

function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

// Shared WHERE-clause builder for the structured-audit filters (session,
// event type, free-text query, time range). Deliberately excludes the
// pagination cursor (`beforeId`) so the same predicates drive both the page
// query and the total-count query.
function buildStructuredAuditFilterClauses(params: {
  sessionId?: string;
  eventType?: string;
  eventTypeMatch?: 'exact' | 'prefix';
  query?: string;
  since?: string;
  until?: string;
}): { clauses: string[]; values: Array<string | number> } {
  const sessionId = String(params.sessionId || '').trim();
  const eventType = String(params.eventType || '').trim();
  const query = String(params.query || '').trim();
  const since = String(params.since || '').trim();
  const until = String(params.until || '').trim();
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (sessionId) {
    clauses.push('session_id = ?');
    values.push(sessionId);
  }
  if (eventType) {
    if (params.eventTypeMatch === 'prefix') {
      clauses.push("event_type LIKE ? ESCAPE '\\'");
      values.push(`${escapeSqlLikePattern(eventType)}%`);
    } else {
      clauses.push('event_type = ?');
      values.push(eventType);
    }
  }
  if (query) {
    const like = `%${query}%`;
    clauses.push(
      '(event_type LIKE ? OR payload LIKE ? OR session_id LIKE ? OR run_id LIKE ?)',
    );
    values.push(like, like, like, like);
  }
  if (since) {
    clauses.push('timestamp >= ?');
    values.push(since);
  }
  if (until) {
    clauses.push('timestamp <= ?');
    values.push(until);
  }
  return { clauses, values };
}

/**
 * Count audit events matching the given filters, ignoring pagination. Lets the
 * admin audit list report the true number of matching rows in the database
 * rather than how many the client has paged in so far.
 */
export function countStructuredAuditEntries(params?: {
  sessionId?: string;
  eventType?: string;
  eventTypeMatch?: 'exact' | 'prefix';
  query?: string;
  since?: string;
  until?: string;
}): number {
  const { clauses, values } = buildStructuredAuditFilterClauses(params ?? {});
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const row = queryOne<{ count: number }, Array<string | number>>(
    getAuditDatabase(),
    `SELECT COUNT(*) AS count FROM audit_events ${where}`,
    ...values,
  );
  return row?.count ?? 0;
}

function queryStructuredAuditEntries(params?: {
  sessionId?: string;
  eventType?: string;
  eventTypeMatch?: 'exact' | 'prefix';
  query?: string;
  since?: string;
  until?: string;
  beforeId?: number;
  limit?: number;
  maxLimit?: number;
  orderBy?: 'id' | 'seq';
  sortDirection?: 'ASC' | 'DESC';
}): StructuredAuditEntry[] {
  const sessionId = String(params?.sessionId || '').trim();
  const eventType = String(params?.eventType || '').trim();
  const query = String(params?.query || '').trim();
  const since = String(params?.since || '').trim();
  const until = String(params?.until || '').trim();
  const beforeId =
    typeof params?.beforeId === 'number' && Number.isFinite(params.beforeId)
      ? Math.max(0, Math.floor(params.beforeId))
      : 0;
  const orderBy = params?.orderBy === 'seq' ? 'seq' : 'id';
  const sortDirection = params?.sortDirection === 'ASC' ? 'ASC' : 'DESC';

  const { clauses, values } = buildStructuredAuditFilterClauses({
    sessionId,
    eventType,
    eventTypeMatch: params?.eventTypeMatch,
    query,
    since,
    until,
  });
  if (beforeId > 0) {
    clauses.push('id < ?');
    values.push(beforeId);
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
    return queryHydratedAuditEntries<Array<string | number>>(
      getAuditDatabase(),
      sql,
      ...values,
    );
  }

  return queryHydratedAuditEntries<Array<string | number>>(
    getAuditDatabase(),
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

export function getRecentStructuredAuditForSessions(
  sessionIds: readonly string[],
  perSessionLimit = 20,
): StructuredAuditEntry[] {
  const normalizedSessionIds = Array.from(
    new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)),
  ).sort((left, right) => left.localeCompare(right));
  if (normalizedSessionIds.length === 0) return [];
  const limit = Math.max(1, Math.min(200, Math.trunc(perSessionLimit || 20)));
  const placeholders = normalizedSessionIds.map(() => '?').join(', ');
  return queryHydratedAuditEntries<Array<string | number>>(
    getAuditDatabase(),
    `WITH ranked_events AS (
       SELECT
         ${STRUCTURED_AUDIT_SELECT_COLUMNS},
         ROW_NUMBER() OVER (
           PARTITION BY session_id
           ORDER BY seq DESC
         ) AS liveness_rank
       FROM audit_events
       WHERE session_id IN (${placeholders})
     )
     SELECT ${STRUCTURED_AUDIT_SELECT_COLUMNS}
     FROM ranked_events
     WHERE liveness_rank <= ?
    ORDER BY session_id ASC, seq DESC`,
    ...normalizedSessionIds,
    limit,
  );
}

export function listStructuredAuditSessionIdsByPrefix(
  prefix: string,
  limit = 64,
): string[] {
  const normalizedPrefix = String(prefix || '').trim();
  if (!normalizedPrefix) return [];
  const normalizedLimit = Math.max(1, Math.min(512, Math.trunc(limit || 64)));
  const rows = queryAll<{ sessionId: string }, [string, number]>(
    getAuditDatabase(),
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
  eventTypeMatch?: 'exact' | 'prefix';
  query?: string;
  since?: string;
  until?: string;
  beforeId?: number;
  limit?: number;
  maxLimit?: number;
}): StructuredAuditEntry[] {
  return queryStructuredAuditEntries({
    sessionId: params?.sessionId,
    eventType: params?.eventType,
    eventTypeMatch: params?.eventTypeMatch,
    query: params?.query,
    since: params?.since,
    until: params?.until,
    beforeId: params?.beforeId,
    limit: params?.limit ?? 50,
    maxLimit: params?.maxLimit,
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
  return queryHydratedAuditEntries<[number, number]>(
    getAuditDatabase(),
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
  const normalized = query.trim();
  if (!normalized) return [];
  const bounded = Math.max(1, Math.min(limit, 1_000));
  const like = `%${normalized}%`;
  return queryHydratedAuditEntries<[string, string, string, string, number]>(
    getAuditDatabase(),
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
      getAuditDatabase(),
      'SELECT * FROM approvals WHERE approved = 0 ORDER BY id DESC LIMIT ?',
      bounded,
    );
  }
  return queryAll<ApprovalAuditEntry, [number]>(
    getAuditDatabase(),
    'SELECT * FROM approvals ORDER BY id DESC LIMIT ?',
    bounded,
  );
}
