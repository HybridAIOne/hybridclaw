/**
 * Destructive agent reset is an admin-only route. Its caller must repeat the
 * confirmation and choose history retention explicitly when keeping history.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resetAgent } from '../agents/agent-reset.js';
import { isRecord } from '../utils/type-guards.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';

export async function handleAgentResetRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/admin\/agents\/([^/]+)\/reset$/.exec(pathname);
  if (!match) return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return true;
  }
  const body = await readJsonBody(req);
  if (
    !isRecord(body) ||
    body.confirmation !== 'RESET AGENT' ||
    (body.deleteHistory !== undefined &&
      typeof body.deleteHistory !== 'boolean')
  ) {
    sendJson(res, 400, { error: 'confirmation_required' });
    return true;
  }
  try {
    sendJson(
      res,
      200,
      await resetAgent(
        decodeURIComponent(match[1]),
        body.deleteHistory !== false,
      ),
    );
  } catch (error) {
    sendJson(res, 409, {
      error: error instanceof Error ? error.message : 'Agent reset failed.',
    });
  }
  return true;
}
