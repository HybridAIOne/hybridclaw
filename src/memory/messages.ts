import type Database from 'better-sqlite3';
import {
  type ActivityTrace,
  parseActivityTrace,
  serializeActivityTrace,
} from '../types/activity-trace.js';
import type { ArtifactMetadata } from '../types/execution.js';
import type {
  ConversationBranchFamily,
  ConversationHistoryPage,
  ResponseRatingRecord,
  ResponseRatingValue,
  StoredMessage,
} from '../types/session.js';
import { normalizeNonNegativeInteger } from '../utils/number-normalization.js';
import { withMemoryDatabase } from './database.js';
import { ensureSessionBranchesTable } from './schema/migrations.js';
import { resolveSessionIdCompat } from './sessions.js';
import { queryAll, queryOne } from './sqlite.js';

interface ConversationHistoryPageRow {
  session_agent_id: string | null;
  session_key: string | null;
  main_session_key: string | null;
  id: number | null;
  session_id: string | null;
  user_id: string | null;
  username: string | null;
  role: string | null;
  agent_id: string | null;
  content: string | null;
  artifacts_json: string | null;
  activity_trace_json: string | null;
  created_at: string | null;
}

interface ResponseRatingRow {
  session_id: string;
  message_id: number;
  operator_user_id: string;
  rating: string;
  comment: string | null;
  agent_id: string | null;
  model: string | null;
  provider: string | null;
  skill_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResponseRatingTarget {
  session_id: string;
  message_id: number;
  agent_id: string | null;
  role: string;
  model: string | null;
  provider: string | null;
  chatbot_id: string | null;
  user_content: string | null;
  assistant_content: string;
  skill_observation_id: number | null;
  skill_run_id: string | null;
  skill_name: string | null;
}

interface SessionBranchRow {
  session_id: string;
  parent_session_id: string;
  parent_message_id: number;
  copied_message_count: number;
}

function getMessageDatabase(): Database.Database {
  return withMemoryDatabase((database) => database);
}

function normalizeUsageNumber(value: unknown): number {
  return normalizeNonNegativeInteger(value);
}

function normalizeMessageArtifacts(
  artifacts?: ArtifactMetadata[] | null,
): ArtifactMetadata[] {
  if (!Array.isArray(artifacts)) return [];
  return artifacts
    .map((artifact) => ({
      path: String(artifact?.path || '').trim(),
      filename: String(artifact?.filename || '').trim(),
      mimeType: String(artifact?.mimeType || '').trim(),
    }))
    .filter(
      (artifact) =>
        artifact.path.length > 0 &&
        artifact.filename.length > 0 &&
        artifact.mimeType.length > 0,
    );
}

function serializeMessageArtifacts(
  artifacts?: ArtifactMetadata[] | null,
): string | null {
  const normalized = normalizeMessageArtifacts(artifacts);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

function parseMessageArtifacts(raw: string | null): ArtifactMetadata[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeMessageArtifacts(
      Array.isArray(parsed) ? (parsed as ArtifactMetadata[]) : null,
    );
  } catch {
    return [];
  }
}

function normalizeResponseRatingValue(
  value: string | null | undefined,
): ResponseRatingValue | null {
  return value === 'up' || value === 'down' ? value : null;
}

function mapResponseRatingRow(
  row: ResponseRatingRow,
): ResponseRatingRecord | null {
  const rating = normalizeResponseRatingValue(row.rating);
  if (!rating) return null;
  return {
    session_id: row.session_id,
    message_id: row.message_id,
    operator_user_id: row.operator_user_id,
    rating,
    comment: row.comment,
    agent_id: row.agent_id,
    model: row.model,
    provider: row.provider,
    skill_name: row.skill_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function storeMessage(
  sessionId: string,
  userId: string,
  username: string | null,
  role: string,
  content: string,
  agentId?: string | null,
  artifacts?: ArtifactMetadata[] | null,
): number {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const normalizedAgentId = agentId?.trim() || null;
  const artifactsJson = serializeMessageArtifacts(artifacts);
  const result = getMessageDatabase()
    .prepare(
      `INSERT INTO messages (
         session_id,
         user_id,
         username,
         role,
         agent_id,
         content,
         artifacts_json,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))`,
    )
    .run(
      resolvedSessionId,
      userId,
      username,
      role,
      normalizedAgentId,
      content,
      artifactsJson,
    );

  getMessageDatabase()
    .prepare(
      "UPDATE sessions SET message_count = message_count + 1, last_active = datetime('now') WHERE id = ?",
    )
    .run(resolvedSessionId);

  return result.lastInsertRowid as number;
}

/**
 * Attaches a web-chat activity trace to an already-persisted assistant message.
 * Written as a post-insert update because the trace is only fully known once
 * the streamed turn completes, after the message row exists.
 */
export function setMessageActivityTrace(
  messageId: number,
  trace: ActivityTrace,
): void {
  getMessageDatabase()
    .prepare('UPDATE messages SET activity_trace_json = ? WHERE id = ?')
    .run(serializeActivityTrace(trace), messageId);
}

export function getConversationHistory(
  sessionId: string,
  limit = 50,
): StoredMessage[] {
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  return queryAll<StoredMessage, [string, number]>(
    getMessageDatabase(),
    'SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    resolvedSessionId,
    limit,
  );
}

export function getLatestAssistantMessageId(sessionId: string): number | null {
  const row = queryOne<{ id: number }, [string]>(
    getMessageDatabase(),
    `SELECT id FROM messages
     WHERE session_id = ? AND role = 'assistant'
     ORDER BY id DESC LIMIT 1`,
    resolveSessionIdCompat(sessionId),
  );
  return row?.id ?? null;
}

function inferProviderFromModel(model: string | null): string | null {
  const trimmed = model?.trim() || '';
  if (!trimmed) return null;
  const slashIndex = trimmed.indexOf('/');
  return slashIndex > 0 ? trimmed.slice(0, slashIndex) : null;
}

export function getResponseRatingTarget(params: {
  sessionId: string;
  messageId: number;
}): ResponseRatingTarget | null {
  const sessionId = resolveSessionIdCompat(params.sessionId);
  const row = queryOne<
    {
      session_id: string;
      message_id: number;
      agent_id: string | null;
      role: string;
      model: string | null;
      chatbot_id: string | null;
      user_content: string | null;
      assistant_content: string;
      skill_observation_id: number | null;
      skill_run_id: string | null;
      skill_name: string | null;
    },
    [string, number]
  >(
    getMessageDatabase(),
    `WITH target_message AS (
       SELECT
         m.session_id,
         m.id AS message_id,
         m.agent_id,
         m.role,
         COALESCE(m.content, '') AS assistant_content,
         m.created_at,
         s.chatbot_id,
         s.model,
         (
           SELECT previous_user_message.content
           FROM messages previous_user_message
           WHERE previous_user_message.session_id = m.session_id
             AND previous_user_message.id < m.id
             AND previous_user_message.role = 'user'
           ORDER BY previous_user_message.id DESC
           LIMIT 1
         ) AS user_content,
         (
           SELECT julianday(MAX(previous_user_message.created_at))
           FROM messages previous_user_message
           WHERE previous_user_message.session_id = m.session_id
             AND previous_user_message.id < m.id
             AND previous_user_message.role = 'user'
         ) AS turn_started_at
       FROM messages m
       LEFT JOIN sessions s ON s.id = m.session_id
       WHERE m.session_id = ? AND m.id = ?
       LIMIT 1
     ),
     attributed_skill AS (
       SELECT
         skill_observation.id,
         skill_observation.run_id,
         skill_observation.skill_name
       FROM skill_observations skill_observation
       JOIN target_message ON target_message.session_id = skill_observation.session_id
       WHERE (
           target_message.agent_id IS NULL
           OR skill_observation.agent_id IS NULL
           OR skill_observation.agent_id = target_message.agent_id
         )
         AND julianday(skill_observation.created_at) <= julianday(target_message.created_at)
         AND julianday(skill_observation.created_at) >= COALESCE(target_message.turn_started_at, 0)
       ORDER BY julianday(skill_observation.created_at) DESC, skill_observation.id DESC
       LIMIT 1
     )
     SELECT
       target_message.session_id,
       target_message.message_id,
       target_message.agent_id,
       target_message.role,
       target_message.model,
       target_message.chatbot_id,
       target_message.user_content,
       target_message.assistant_content,
       attributed_skill.id AS skill_observation_id,
       attributed_skill.run_id AS skill_run_id,
       attributed_skill.skill_name
     FROM target_message
     LEFT JOIN attributed_skill`,
    sessionId,
    params.messageId,
  );
  if (!row) return null;
  return {
    ...row,
    provider: inferProviderFromModel(row.model),
  };
}

export function upsertResponseRating(input: {
  sessionId: string;
  messageId: number;
  operatorUserId: string;
  rating: ResponseRatingValue;
  comment?: string | null;
  agentId?: string | null;
  model?: string | null;
  provider?: string | null;
  skillName?: string | null;
}): ResponseRatingRecord {
  const sessionId = resolveSessionIdCompat(input.sessionId);
  const operatorUserId = input.operatorUserId.trim();
  const row = getMessageDatabase()
    .prepare(
      `INSERT INTO response_ratings (
       session_id,
       message_id,
       operator_user_id,
       rating,
       comment,
       agent_id,
       model,
       provider,
       skill_name
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, message_id, operator_user_id)
     DO UPDATE SET
       rating = excluded.rating,
       comment = excluded.comment,
       agent_id = excluded.agent_id,
       model = excluded.model,
       provider = excluded.provider,
       skill_name = excluded.skill_name,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     RETURNING *`,
    )
    .get(
      sessionId,
      input.messageId,
      operatorUserId,
      input.rating,
      input.comment?.trim() || null,
      input.agentId?.trim() || null,
      input.model?.trim() || null,
      input.provider?.trim() || null,
      input.skillName?.trim() || null,
    ) as ResponseRatingRow | undefined;
  const rating = row ? mapResponseRatingRow(row) : null;
  if (!rating) {
    throw new Error('Failed to read persisted response rating.');
  }
  return rating;
}

export function clearResponseRating(input: {
  sessionId: string;
  messageId: number;
  operatorUserId: string;
}): void {
  getMessageDatabase()
    .prepare(
      `DELETE FROM response_ratings
     WHERE session_id = ?
       AND message_id = ?
       AND operator_user_id = ?`,
    )
    .run(
      resolveSessionIdCompat(input.sessionId),
      input.messageId,
      input.operatorUserId.trim(),
    );
}

export function getResponseRatingsForMessages(input: {
  sessionId: string;
  messageIds: number[];
  operatorUserId: string;
}): Map<number, ResponseRatingValue> {
  const sessionId = resolveSessionIdCompat(input.sessionId);
  const messageIds = [
    ...new Set(
      input.messageIds
        .filter((id) => Number.isInteger(id) && id > 0)
        .map((id) => Math.floor(id)),
    ),
  ];
  const operatorUserId = input.operatorUserId.trim();
  if (messageIds.length === 0 || !operatorUserId) return new Map();
  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = queryAll<
    Pick<ResponseRatingRow, 'message_id' | 'rating'>,
    Array<string | number>
  >(
    getMessageDatabase(),
    `SELECT message_id, rating
     FROM response_ratings
     WHERE session_id = ?
       AND operator_user_id = ?
       AND message_id IN (${placeholders})`,
    sessionId,
    operatorUserId,
    ...messageIds,
  );
  const ratings = new Map<number, ResponseRatingValue>();
  for (const row of rows) {
    const rating = normalizeResponseRatingValue(row.rating);
    if (rating) ratings.set(row.message_id, rating);
  }
  return ratings;
}

function getBranchVariantMessageId(
  sessionId: string,
  copiedMessageCount: number,
): number | null {
  const row = getMessageDatabase()
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
  const childRows = getMessageDatabase()
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
  ensureSessionBranchesTable(getMessageDatabase());
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

  const currentBranch = getMessageDatabase()
    .prepare(
      `SELECT session_id, parent_session_id, parent_message_id, copied_message_count
       FROM session_branches
       WHERE session_id = ?`,
    )
    .get(resolvedSessionId) as SessionBranchRow | undefined;
  if (currentBranch) {
    addFamily(currentBranch.parent_session_id, currentBranch.parent_message_id);
  }

  const childAnchors = getMessageDatabase()
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
  const rows = getMessageDatabase()
    .prepare(
      `SELECT
         s.agent_id AS session_agent_id,
         s.session_key,
         s.main_session_key,
         m.id,
         m.session_id,
         m.user_id,
         m.username,
         m.role,
         m.agent_id,
         m.content,
         m.artifacts_json,
         m.activity_trace_json,
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
      sessionId: resolvedSessionId,
      agentId: null,
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
    const activityTrace = parseActivityTrace(row.activity_trace_json);
    history.push({
      id: row.id,
      session_id: row.session_id,
      user_id: row.user_id,
      username: row.username,
      role: row.role,
      agent_id: row.agent_id,
      content: row.content,
      artifacts: parseMessageArtifacts(row.artifacts_json),
      ...(activityTrace ? { activityTrace } : {}),
      created_at: row.created_at,
    });
  }

  return {
    sessionId: resolvedSessionId,
    agentId: rows[0]?.session_agent_id || null,
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
  const resolvedSessionId = resolveSessionIdCompat(sessionId);
  const boundedLimit =
    typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : null;

  if (boundedLimit == null) {
    return queryAll<StoredMessage, [string]>(
      getMessageDatabase(),
      'SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC',
      resolvedSessionId,
    );
  }

  const rows = queryAll<StoredMessage, [string, number]>(
    getMessageDatabase(),
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
    getMessageDatabase(),
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
    getMessageDatabase(),
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
