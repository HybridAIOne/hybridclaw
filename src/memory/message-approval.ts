/**
 * A stored approval is a review snapshot, never permission to execute a tool.
 * The pending registry and worker policy remain the authorities for decisions.
 */
import type { PendingApproval } from '../types/execution.js';
import { withMemoryDatabase } from './database.js';

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
      .run(JSON.stringify(approval), sessionId, messageId),
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
      .run(decision, Date.now(), sessionId, approvalId),
  );
}

export function parseMessageApproval(
  json: string | null,
): MessageApproval | undefined {
  return json ? (JSON.parse(json) as MessageApproval) : undefined;
}
