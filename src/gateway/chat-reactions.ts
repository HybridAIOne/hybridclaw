/**
 * Emoji reactions in a one-to-one chat, stored with the message they are on.
 *
 * The agent reacts to the user's message with its `react` tool; the turn's
 * reaction is read from its tool executions and stored once the turn is. The
 * user reacts to the agent's replies through `POST /api/chat/reaction`, which
 * runs no turn: the agent learns of it in its next turn's context. Only the
 * operator the session is bound to (first to chat in it) may react; any other
 * caller sees the same 404 as a missing message. A 👍 or 👎 is the reply's
 * rating too, as Teams reactions are.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  REACT_TOOL_NAME,
  readSingleEmoji,
} from '../../container/shared/reactions.js';
import { logger } from '../logger.js';
import { setMessageReaction } from '../memory/db.js';
import type { ToolExecution } from '../types/execution.js';
import type { ResponseRatingValue } from '../types/session.js';
import { parseJsonObject } from '../utils/json-object.js';
import { isRecord } from '../utils/type-guards.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';
import { webNotificationSessionOperator } from './web-notification-store.js';

export const CHAT_REACTION_PATH = '/api/chat/reaction';

// What a lone emoji is made of: pictographs, skin tones, flags, joiners and
// keycaps. The longest single emoji (a kiss with two skin tones) is 15 units.
const EMOJI_PARTS =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|\u20e3)*$/u;
const LONE_EMOJI_MAX_LENGTH = 16;

/**
 * Holds a streamed reply back while it could still be one emoji alone, which
 * the turn makes a reaction instead of a reply, so it never shows as a reply
 * first. Any other reply passes once its first characters are in. `flush`
 * hands back what is held and holds again, as text after a tool call is a new
 * reply.
 */
export function createLoneEmojiHold(): {
  push: (delta: string) => string;
  flush: () => string;
} {
  let held = '';
  let passing = false;
  const flush = (): string => {
    const text = held;
    held = '';
    passing = false;
    return text;
  };
  return {
    push(delta: string): string {
      if (passing || !delta) return delta;
      held += delta;
      const text = held.trim();
      if (text.length <= LONE_EMOJI_MAX_LENGTH && EMOJI_PARTS.test(text)) {
        return '';
      }
      const passed = flush();
      passing = true;
      return passed;
    },
    flush,
  };
}

/** The emoji of the turn's last reaction that went through, if any. */
export function turnReaction(
  executions: readonly ToolExecution[] | undefined,
): string | null {
  for (const execution of [...(executions ?? [])].reverse()) {
    if (execution.name !== REACT_TOOL_NAME || execution.isError) continue;
    const emoji = readSingleEmoji(parseJsonObject(execution.arguments)?.emoji);
    if (emoji) return emoji;
  }
  return null;
}

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
      ? setMessageReaction({ sessionId, messageId, role: 'assistant', emoji })
      : null;
  if (!stored) {
    sendJson(res, 404, { error: 'Message not found.' });
    return;
  }
  // A withdrawn 👍 clears only a rating it made, never a later explicit one.
  const added = ratingOf(emoji);
  const removed = ratingOf(stored.previous);
  if (added || removed) {
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
