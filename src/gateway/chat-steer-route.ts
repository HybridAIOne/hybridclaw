/**
 * `POST /api/chat/steer`: a message the user sends while a turn of theirs is
 * running, for that turn's model to see at its next step.
 *
 * `{ accepted: true }` means the running turn will show the note to the model
 * and store it in the chat as a user message, so the client must not send it
 * again. `{ accepted: false }` means nothing happened: no turn of this caller
 * is running there, the turn is finishing, or the text is a command; the
 * client sends it as an ordinary turn once the running one ends. A caller
 * steers only sessions bound to it (first to chat in them, as for
 * reactions); any other session answers `false`, so a running turn's
 * existence leaks to no one else.
 *
 * NOT `/stop` (interrupts the turn) and NOT an approval answer: `yes <id>`
 * goes through `/api/chat`, and a turn waiting for approval has no running
 * request to steer.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord } from '../utils/type-guards.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';
import { steerGatewaySession } from './gateway-request-runtime.js';
import { webNotificationSessionOperator } from './web-notification-store.js';

export const CHAT_STEER_PATH = '/api/chat/steer';

export async function handleChatSteerRoute(
  req: IncomingMessage,
  res: ServerResponse,
  operatorId: string | null,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const raw = await readJsonBody(req);
  const body = isRecord(raw) ? raw : {};
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!sessionId || !content) {
    sendJson(res, 400, { error: 'Expected `sessionId` and `content`.' });
    return;
  }
  const accepted =
    // Commands run as turns of their own.
    !content.startsWith('/') &&
    operatorId !== null &&
    webNotificationSessionOperator(sessionId) === operatorId &&
    steerGatewaySession(sessionId, content);
  sendJson(res, 200, { accepted });
}
