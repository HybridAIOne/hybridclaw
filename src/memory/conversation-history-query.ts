/**
 * History pages use an exclusive stored-message ID within one resolved session.
 * The cursor advances across raw rows, including messages hidden by the gateway;
 * unlike prompt history, this query never changes model context or retention.
 */
import { withMemoryDatabase } from './database.js';

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
  routing_trace_json: string | null;
  reaction: string | null;
  email_draft_json: string | null;
  approval_json: string | null;
  source: string | null;
  created_at: string | null;
}

export function readConversationHistoryRows(
  resolvedSessionId: string,
  limit: number,
  beforeMessageId?: number,
): { rows: ConversationHistoryPageRow[]; nextCursor: string | null } {
  const pageSize = Math.max(1, Math.floor(limit));
  const rows = withMemoryDatabase((db) => db)
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
         m.routing_trace_json,
         m.reaction,
         m.email_draft_json,
         m.approval_json,
         m.source,
         m.created_at
       FROM sessions s
       LEFT JOIN (
         SELECT *
         FROM messages
         WHERE session_id = @sessionId ${beforeMessageId === undefined ? '' : 'AND id < @before'}
         ORDER BY id DESC
         LIMIT @limit
       ) m ON m.session_id = s.id
       WHERE s.id = @sessionId
       ORDER BY m.id DESC`,
    )
    .all({
      sessionId: resolvedSessionId,
      limit: pageSize + 1,
      ...(beforeMessageId === undefined ? {} : { before: beforeMessageId }),
    }) as ConversationHistoryPageRow[];
  const page = rows.slice(0, pageSize);
  const oldestId = page.at(-1)?.id;
  return {
    rows: page,
    nextCursor:
      rows.length > pageSize && oldestId != null ? String(oldestId) : null,
  };
}
