import type Database from 'better-sqlite3';
import type {
  CanonicalSession,
  CanonicalSessionContext,
  CanonicalSessionMessage,
} from '../types/session.js';
import { withMemoryDatabase } from './database.js';
import { queryOne } from './sqlite.js';

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

function saveCanonicalSession(
  database: Database.Database,
  session: CanonicalSession,
): void {
  database
    .prepare(
      `INSERT INTO canonical_sessions
        (canonical_id, agent_id, user_id, messages, compaction_cursor, compacted_summary, message_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(canonical_id) DO UPDATE SET
         messages = excluded.messages,
         compaction_cursor = excluded.compaction_cursor,
         compacted_summary = excluded.compacted_summary,
         message_count = excluded.message_count,
         updated_at = excluded.updated_at`,
    )
    .run(
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

function load(
  database: Database.Database,
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
    database,
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

export function loadCanonicalSession(
  agentId: string,
  userId: string,
): CanonicalSession {
  return withMemoryDatabase((database) => load(database, agentId, userId));
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
  return withMemoryDatabase((database) => {
    const canonical = load(database, params.agentId, params.userId);
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
    saveCanonicalSession(database, canonical);
    return canonical;
  });
}

export function getCanonicalContext(params: {
  agentId: string;
  userId: string;
  windowSize?: number;
  excludeSessionId?: string | null;
}): CanonicalSessionContext {
  return withMemoryDatabase((database) => {
    const canonical = load(database, params.agentId, params.userId);
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
  });
}

export function clearCanonicalContext(params: {
  agentId: string;
  userId: string;
}): number {
  return withMemoryDatabase((database) => {
    const agentId = params.agentId.trim();
    const userId = params.userId.trim();
    if (!agentId || !userId) return 0;
    return database
      .prepare(
        `DELETE FROM canonical_sessions
         WHERE agent_id = ?
           AND user_id = ?`,
      )
      .run(agentId, userId).changes;
  });
}
