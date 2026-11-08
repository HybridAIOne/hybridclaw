/**
 * A stored approval is a review snapshot, never permission to execute a tool.
 * The pending registry and worker policy remain the authorities for decisions.
 */
import type { PendingApproval } from '../types/execution.js';
import { withMemoryDatabase } from './database.js';
import { resolveSessionIdCompat } from './sessions.js';
import { queryOne } from './sqlite.js';

export interface MessageApproval extends PendingApproval {
  decision?: 'allowed' | 'denied';
  decidedAt?: number;
}

export function setMessageApproval(
  sessionId: string,
  messageId: number,
  approval: PendingApproval,
): void {
  withMemoryDatabase((db) =>
    db
      .prepare(
        "UPDATE messages SET approval_json = ? WHERE session_id = ? AND id = ? AND role = 'assistant'",
      )
      .run(
        JSON.stringify(approval),
        resolveSessionIdCompat(sessionId),
        messageId,
      ),
  );
}

export function decideMessageApproval(
  sessionId: string,
  approvalId: string,
  decision: 'allowed' | 'denied',
): void {
  withMemoryDatabase((db) =>
    db
      .prepare(
        `UPDATE messages SET approval_json = json_set(approval_json, '$.decision', ?, '$.decidedAt', ?)
     WHERE session_id = ? AND json_extract(approval_json, '$.approvalId') = ?
       AND json_extract(approval_json, '$.decision') IS NULL`,
      )
      .run(decision, Date.now(), resolveSessionIdCompat(sessionId), approvalId),
  );
}

/** The newest reply in this chat that showed this approval. */
export function findMessageApproval(
  sessionId: string,
  approvalId: string,
): { id: number; source: string | null } | null {
  return withMemoryDatabase(
    (db) =>
      queryOne<{ id: number; source: string | null }>(
        db,
        "SELECT id, source FROM messages WHERE session_id = ? AND role = 'assistant' AND json_extract(approval_json, '$.approvalId') = ? ORDER BY id DESC LIMIT 1",
        resolveSessionIdCompat(sessionId),
        approvalId,
      ) ?? null,
  );
}

export function parseMessageApproval(
  json: string | null,
): MessageApproval | undefined {
  return json ? (JSON.parse(json) as MessageApproval) : undefined;
}
