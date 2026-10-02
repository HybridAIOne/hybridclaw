/**
 * A client reads back one reply the gateway stored in its chat without a turn
 * of its own, such as a reminder, by the message id its notification names.
 * Only the operator the session is bound to (first to chat in it) gets an
 * answer; any other caller sees the same 404 as a missing message.
 * NOT `/api/history`: no user turns, traces, session keys or paging.
 */
import type { ServerResponse } from 'node:http';
import { getSessionAssistantMessage } from '../memory/db.js';
import { sendJson } from './gateway-http-utils.js';
import { webNotificationSessionOperator } from './web-notification-store.js';

export const DEVICE_MESSAGE_PATH = '/api/chat/message';

export function handleDeviceMessageRoute(
  res: ServerResponse,
  url: URL,
  operatorId: string,
): void {
  res.setHeader('Cache-Control', 'no-store');
  const sessionId = url.searchParams.get('sessionId')?.trim() || '';
  const rawId = url.searchParams.get('id') || '';
  const messageId = /^[1-9]\d{0,15}$/.test(rawId) ? Number(rawId) : 0;
  if (!sessionId || sessionId.length > 256 || !messageId) {
    sendJson(res, 400, { error: 'Expected `sessionId` and a message `id`.' });
    return;
  }
  const message =
    webNotificationSessionOperator(sessionId) === operatorId
      ? getSessionAssistantMessage(sessionId, messageId)
      : null;
  if (!message) {
    sendJson(res, 404, { error: 'Message not found.' });
    return;
  }
  sendJson(res, 200, {
    id: message.id,
    sessionId: message.session_id,
    agentId: message.agent_id ?? null,
    content: message.content,
    artifacts: message.artifacts ?? [],
    // `schedule:<task id>` for a reply a task posted, so an app can tell its own.
    source: message.source ?? null,
    // SQLite stores UTC without a zone.
    createdAt: `${message.created_at.replace(' ', 'T')}Z`,
  });
}
