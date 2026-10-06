/**
 * Gateway boundaries for internal provenance tools and authorized chat history.
 * History callers must already have access to their session; this adds no access.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '../gateway/gateway-http-utils.js';
import { workForMessage } from './work-store.js';
import { runWorkTool } from './work-tool.js';

export async function handleWorkToolRoute(
  req: IncomingMessage,
  res: ServerResponse,
  authorized: boolean,
): Promise<void> {
  if (!authorized) {
    sendJson(res, 401, { error: 'Unauthorized.' });
    return;
  }
  sendJson(res, 200, runWorkTool(await readJsonBody(req)));
}
export function withWorkHistory<T extends { id: number; role: string }>(
  sessionId: string,
  messages: T[],
) {
  return messages.map((message) => ({
    ...message,
    work:
      message.role === 'assistant'
        ? workForMessage(sessionId, message.id)
        : null,
  }));
}
