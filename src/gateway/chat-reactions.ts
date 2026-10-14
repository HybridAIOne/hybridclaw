/**
 * Emoji reactions in a one-to-one chat, stored with the message they are on.
 *
 * Clients choose Hy's reactions independently of chat execution and persist them
 * on user messages. All emoji are conversation reactions, never response
 * ratings or improvement feedback. The bound session operator owns both surfaces.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readSingleEmoji } from '../../container/shared/reactions.js';
import { setMessageReaction } from '../memory/db.js';
import { isRecord } from '../utils/type-guards.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';
import { webNotificationSessionOperator } from './web-notification-store.js';

export const CHAT_REACTION_PATH = '/api/chat/reaction';

export async function handleChatReactionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  operatorId: string,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const raw = await readJsonBody(req);
  const body = isRecord(raw) ? raw : {};
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const messageId =
    Number.isSafeInteger(body.messageId) && Number(body.messageId) > 0
      ? Number(body.messageId)
      : 0;
  const role = body.role === undefined ? 'assistant' : body.role;
  if (role !== 'user' && role !== 'assistant') {
    sendJson(res, 400, { error: 'Expected role user or assistant.' });
    return;
  }
  // null takes the reaction off.
  const emoji = body.emoji === null ? null : readSingleEmoji(body.emoji);
  if (!sessionId || sessionId.length > 256 || !messageId || emoji === '') {
    sendJson(res, 400, {
      error:
        'Expected `sessionId`, a `messageId` and one `emoji`, or null to remove it.',
    });
    return;
  }
  const stored =
    webNotificationSessionOperator(sessionId) === operatorId
      ? setMessageReaction({ sessionId, messageId, role, emoji })
      : null;
  if (!stored) {
    sendJson(res, 404, { error: 'Message not found.' });
    return;
  }
  sendJson(res, 200, { sessionId, messageId, reaction: emoji });
}
