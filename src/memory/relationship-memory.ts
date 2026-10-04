/**
 * Relationship inspection groups stored sessions by their persisted audience,
 * including retired instances. Unlike recall, inspection never touches access
 * counters, links identities, or exposes workspace files as private memories.
 */
import { parseSessionKey } from '../session/session-key.js';
import type {
  MemoryRelationship,
  MemoryRelationshipDetail,
  MemoryRelationshipPage,
} from '../types/relationship-memory.js';
import { getCanonicalContext } from './canonical-sessions.js';
import { withMemoryDatabase } from './database.js';
import { queryAll, queryOne } from './sqlite.js';

// Implementation choice (2026-10-04): paginate inspection at 50 rows;
// bulk memory exports and synthesized relationship profiles are deferred.
export const RELATIONSHIP_MEMORY_PAGE_SIZE = 50;
const AUDIENCE = `COALESCE(NULLIF(s.main_session_key, ''), NULLIF(s.session_key, ''), s.id)`;
const RELATIONSHIPS = `SELECT s.agent_id AS agentId, ${AUDIENCE} AS audienceKey,
  COUNT(DISTINCT s.id) AS sessionCount, COUNT(m.id) AS memoryCount,
  MAX(s.last_active) AS lastActive
  FROM sessions s LEFT JOIN semantic_memories m ON m.session_id = s.id AND m.deleted = 0
  GROUP BY s.agent_id, ${AUDIENCE}`;

type RelationshipRow = Omit<MemoryRelationship, 'kind' | 'peerId' | 'channel'>;

function describeRelationship(row: RelationshipRow): MemoryRelationship {
  const parsed = parseSessionKey(row.audienceKey);
  // A malformed or opaque key is never presented as a known private audience.
  const valid = parsed?.agentId === row.agentId ? parsed : null;
  return {
    ...row,
    kind:
      valid?.chatType === 'dm'
        ? 'person'
        : valid?.chatType === 'group' || valid?.chatType === 'channel'
          ? 'group'
          : 'session',
    peerId: valid?.peerId ?? null,
    channel: valid?.channelKind ?? null,
  };
}

export function listMemoryRelationships(offset = 0): MemoryRelationshipPage {
  return withMemoryDatabase((db) => {
    const rows = queryAll<RelationshipRow>(
      db,
      `${RELATIONSHIPS} ORDER BY lastActive DESC, agentId, audienceKey LIMIT ? OFFSET ?`,
      RELATIONSHIP_MEMORY_PAGE_SIZE + 1,
      offset,
    );
    return {
      relationships: rows
        .slice(0, RELATIONSHIP_MEMORY_PAGE_SIZE)
        .map(describeRelationship),
      nextOffset:
        rows.length > RELATIONSHIP_MEMORY_PAGE_SIZE
          ? offset + RELATIONSHIP_MEMORY_PAGE_SIZE
          : null,
    };
  });
}

export function inspectMemoryRelationship(params: {
  agentId: string;
  audienceKey: string;
  sessionOffset?: number;
  memoryOffset?: number;
}): MemoryRelationshipDetail | null {
  return withMemoryDatabase((db) => {
    const relationship = queryOne<RelationshipRow>(
      db,
      `SELECT * FROM (${RELATIONSHIPS}) WHERE agentId = ? AND audienceKey = ?`,
      params.agentId,
      params.audienceKey,
    );
    if (!relationship) return null;
    const sessionOffset = params.sessionOffset ?? 0;
    const memoryOffset = params.memoryOffset ?? 0;
    const sessions = queryAll<MemoryRelationshipDetail['sessions'][number]>(
      db,
      `SELECT s.id, s.session_key AS sessionKey, s.title, s.is_current AS current,
       s.session_summary AS summary, s.summary_updated_at AS summaryUpdatedAt
       FROM sessions s WHERE s.agent_id = ? AND ${AUDIENCE} = ?
       ORDER BY s.last_active DESC, s.id LIMIT ? OFFSET ?`,
      params.agentId,
      params.audienceKey,
      RELATIONSHIP_MEMORY_PAGE_SIZE + 1,
      sessionOffset,
    );
    const memories = queryAll<MemoryRelationshipDetail['memories'][number]>(
      db,
      `SELECT m.id, m.session_id, m.role, m.source, m.scope, m.content, m.confidence,
       m.source_message_id, m.created_at, m.accessed_at, m.access_count
       FROM semantic_memories m JOIN sessions s ON s.id = m.session_id
       WHERE s.agent_id = ? AND ${AUDIENCE} = ? AND m.deleted = 0
       ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
      params.agentId,
      params.audienceKey,
      RELATIONSHIP_MEMORY_PAGE_SIZE + 1,
      memoryOffset,
    );
    return {
      relationship: describeRelationship(relationship),
      sessions: sessions
        .slice(0, RELATIONSHIP_MEMORY_PAGE_SIZE)
        .map((s) => ({ ...s, current: Boolean(s.current) })),
      nextSessionOffset:
        sessions.length > RELATIONSHIP_MEMORY_PAGE_SIZE
          ? sessionOffset + RELATIONSHIP_MEMORY_PAGE_SIZE
          : null,
      memories: memories.slice(0, RELATIONSHIP_MEMORY_PAGE_SIZE),
      nextMemoryOffset:
        memories.length > RELATIONSHIP_MEMORY_PAGE_SIZE
          ? memoryOffset + RELATIONSHIP_MEMORY_PAGE_SIZE
          : null,
      continuity: getCanonicalContext({
        agentId: params.agentId,
        userId: params.audienceKey,
      }),
    };
  });
}
