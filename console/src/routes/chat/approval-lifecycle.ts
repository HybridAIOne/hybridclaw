/**
 * Derives per-message approval lifecycle state so stale approval cards stop
 * being clickable once they're acted on, expire, or get superseded by a
 * newer request.
 *
 * The gateway keeps at most one pending approval per session, so "only the
 * newest approval item is actionable" mirrors server semantics exactly.
 */

import type { ApprovalAction } from '../../lib/chat-helpers';
import { parseApprovalAnnouncement } from '../../lib/chat-helpers';
import type { ChatUiMessage } from './chat-ui-message';

export type ApprovalItemStatus =
  | 'active'
  | 'responded'
  | 'superseded'
  | 'expired';

export interface ApprovalItemState {
  approvalId: string;
  status: ApprovalItemStatus;
  respondedAction?: ApprovalAction;
  /** Only known for structured (streamed) approvals; text announcements don't carry it. */
  expiresAt?: number | null;
}

interface ApprovalItem {
  messageId: string;
  approvalId: string;
  expiresAt: number | null;
}

function extractApprovalItem(msg: ChatUiMessage): ApprovalItem | null {
  if (msg.role === 'approval' && msg.pendingApproval) {
    return {
      messageId: msg.id,
      approvalId: msg.pendingApproval.approvalId,
      expiresAt: msg.pendingApproval.expiresAt ?? null,
    };
  }
  if (
    msg.role === 'approval' ||
    msg.role === 'assistant' ||
    msg.role === 'command'
  ) {
    const parsed = parseApprovalAnnouncement(msg.content);
    if (parsed)
      return {
        messageId: msg.id,
        approvalId: parsed.approvalId,
        expiresAt: null,
      };
  }
  return null;
}

/**
 * Only the newest approval item can be actionable: each new request replaces
 * the previous pending one on the gateway, so an older item is gone even when
 * the newest expired unanswered. The newest item is active unless it was
 * responded to or is past its expiry; every older item is responded (acted
 * on) or superseded.
 */
export function deriveApprovalStates(
  messages: readonly ChatUiMessage[],
  resolvedApprovals: ReadonlyMap<string, ApprovalAction>,
  now: number,
): Map<string, ApprovalItemState> {
  const items: ApprovalItem[] = [];
  for (const msg of messages) {
    const item = extractApprovalItem(msg);
    if (item) items.push(item);
  }

  const result = new Map<string, ApprovalItemState>();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item) continue;
    const respondedAction = resolvedApprovals.get(item.approvalId);
    if (respondedAction !== undefined) {
      result.set(item.messageId, {
        approvalId: item.approvalId,
        status: 'responded',
        respondedAction,
      });
      continue;
    }

    const isNewest = i === items.length - 1;
    if (!isNewest) {
      result.set(item.messageId, {
        approvalId: item.approvalId,
        status: 'superseded',
      });
      continue;
    }

    const isExpired =
      item.expiresAt != null &&
      Number.isFinite(item.expiresAt) &&
      item.expiresAt < now;
    result.set(
      item.messageId,
      isExpired
        ? { approvalId: item.approvalId, status: 'expired' }
        : {
            approvalId: item.approvalId,
            status: 'active',
            expiresAt: item.expiresAt,
          },
    );
  }

  return result;
}
