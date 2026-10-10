/**
 * Agent reset and adoption are admin-only routes that need the
 * `admin.agents.delete` action. Each caller repeats its confirmation phrase;
 * reset chooses history retention explicitly when keeping history.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgentAdoptError, adoptAgent } from '../agents/agent-adopt.js';
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

function readSessionPairs(
  value: unknown,
): Array<{ from: string; to: string }> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const pairs: Array<{ from: string; to: string }> = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.from !== 'string' ||
      typeof entry.to !== 'string'
    ) {
      return null;
    }
    pairs.push({ from: entry.from, to: entry.to });
  }
  return pairs;
}

export async function handleAgentAdoptRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = /^\/api\/admin\/agents\/([^/]+)\/adopt$/.exec(pathname);
  if (!match) return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return true;
  }
  const body = await readJsonBody(req);
  const sessions = isRecord(body) ? readSessionPairs(body.sessions) : null;
  if (
    !isRecord(body) ||
    body.confirmation !== 'ADOPT AGENT' ||
    (body.from !== undefined && typeof body.from !== 'string') ||
    !sessions
  ) {
    sendJson(res, 400, { error: 'confirmation_required' });
    return true;
  }
  try {
    sendJson(
      res,
      200,
      await adoptAgent({
        to: decodeURIComponent(match[1]),
        from: body.from as string | undefined,
        sessions,
      }),
    );
  } catch (error) {
    sendJson(res, error instanceof AgentAdoptError ? error.status : 500, {
      error: error instanceof Error ? error.message : 'Agent adopt failed.',
    });
  }
  return true;
}
