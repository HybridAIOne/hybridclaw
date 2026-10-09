/**
 * A client reads back one reply the gateway stored in its chat without a turn
 * of its own, such as a reminder, by the message id its notification names.
 * Only the operator the session is bound to (first to chat in it) gets an
 * answer; any other caller sees the same 404 as a missing message.
 * NOT `/api/history`: no user turns or session keys. Execution traces are opt-in, paged, and redacted.
 */

import type { ServerResponse } from 'node:http';
import { getSessionAssistantMessage } from '../memory/db.js';
import { workForMessage } from '../work/work-store.js';
import { readDeviceActivity } from './device-activity.js';
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
  if (url.searchParams.has('activityOffset')) {
    const rawOffset = url.searchParams.get('activityOffset') ?? '';
    if (!/^(0|[1-9]\d{0,6})$/.test(rawOffset)) {
      sendJson(res, 400, { error: 'Invalid activity offset.' });
      return;
    }
    sendJson(res, 200, {
      id: message.id,
      sessionId,
      activity: readDeviceActivity(
        message.session_id,
        message.id,
        Number(rawOffset),
      ),
    });
    return;
  }
  sendJson(res, 200, {
    work: workForMessage(sessionId, message.id),
    id: message.id,
    sessionId: message.session_id,
    agentId: message.agent_id ?? null,
    content: message.content,
    artifacts: message.artifacts ?? [],
    // `schedule:<task id>` for a reply a task posted, so an app can tell its own.
    source: message.source ?? null,
    // The email the reply showed as a card; its text is in `content` too.
    ...(message.emailDraft ? { emailDraft: message.emailDraft } : {}),
    // SQLite stores UTC without a zone.
    createdAt: `${message.created_at.replace(' ', 'T')}Z`,
  });
}
