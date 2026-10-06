/**
 * Emoji reactions in a one-to-one chat, stored with the message they are on.
 *
 * Clients choose Hy's reactions independently of chat execution and persist them
 * on user messages. Reactions on assistant replies are user feedback; only those
 * can become response ratings. The bound session operator owns both surfaces.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readSingleEmoji } from '../../container/shared/reactions.js';
import { logger } from '../logger.js';
import { setMessageReaction } from '../memory/db.js';
import type { ResponseRatingValue } from '../types/session.js';
import { isRecord } from '../utils/type-guards.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';
import { webNotificationSessionOperator } from './web-notification-store.js';

export const CHAT_REACTION_PATH = '/api/chat/reaction';

// 👍 and 👎 in any skin tone.
function ratingOf(emoji: string | null): ResponseRatingValue | null {
  const bare = emoji?.replace(/[\u{1F3FB}-\u{1F3FF}\uFE0F]/gu, '');
  return bare === '👍' ? 'up' : bare === '👎' ? 'down' : null;
}

/**
 * `rater` names who a rating is from, from the `userId` the client sends with
 * its chat turns, the way `/api/chat/rating` does.
 */
export async function handleChatReactionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  operatorId: string,
  rater: (requestedUserId: string | undefined) => string,
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
  // A withdrawn 👍 clears only a rating it made, never a later explicit one.
  const added = ratingOf(emoji);
  const removed = ratingOf(stored.previous);
  if (role === 'assistant' && (added || removed)) {
    try {
      // Loaded here, as for Teams, so chat turns do not pull in rating forwarding.
      const { applyReactionRatingChanges } = await import(
        './response-ratings.js'
      );
      applyReactionRatingChanges({
        sessionId,
        messageId,
        operatorUserId: rater(
          typeof body.userId === 'string' ? body.userId : undefined,
        ),
        addedRatings: added ? [added] : [],
        removedRatings: removed ? [removed] : [],
        sourceSurface: 'mobile',
      });
    } catch (error) {
      // The reaction stands either way.
      logger.warn(
        { sessionId, messageId, error },
        'Failed to record a reaction as a response rating',
      );
    }
  }
  sendJson(res, 200, { sessionId, messageId, reaction: emoji });
}
