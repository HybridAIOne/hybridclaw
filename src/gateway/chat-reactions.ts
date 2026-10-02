/**
 * Emoji reactions in a one-to-one chat, stored with the message they are on.
 *
 * The agent reacts to the user's message with its `react` tool; the turn's
 * reaction is read from its tool executions and stored once the turn is. The
 * user reacts to the agent's replies through `POST /api/chat/reaction`, which
 * runs no turn: the agent learns of it in its next turn's context. Only the
 * operator the session is bound to (first to chat in it) may react; any other
 * caller sees the same 404 as a missing message.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  REACT_TOOL_NAME,
  readSingleEmoji,
} from '../../container/shared/reactions.js';
import { setMessageReaction } from '../memory/db.js';
import type { ToolExecution } from '../types/execution.js';
import { parseJsonObject } from '../utils/json-object.js';
import { isRecord } from '../utils/type-guards.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';
import { webNotificationSessionOperator } from './web-notification-store.js';

export const CHAT_REACTION_PATH = '/api/chat/reaction';

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
    webNotificationSessionOperator(sessionId) === operatorId &&
    setMessageReaction({ sessionId, messageId, role: 'assistant', emoji });
  if (!stored) {
    sendJson(res, 404, { error: 'Message not found.' });
    return;
  }
  sendJson(res, 200, { sessionId, messageId, reaction: emoji });
}
