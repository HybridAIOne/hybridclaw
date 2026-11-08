/**
 * Pull delivery is leased, then deleted only after the client acknowledges it.
 * A response finishing on the socket is not proof of display. Authentication
 * remains in the gateway router; claims are bound to their channel and IDs.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  acknowledgeProactiveMessages,
  claimQueuedProactiveMessages,
} from '../memory/db.js';
import { isRecord } from '../utils/type-guards.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';
import {
  isLocalProactivePullChannelId,
  shouldSuppressProactiveMessage,
} from './proactive-delivery.js';
import { MAX_QUEUED_PROACTIVE_MESSAGES } from './proactive-dispatch.js';

export function handleApiProactivePull(res: ServerResponse, url: URL): void {
  const channelId = (url.searchParams.get('channelId') || '').trim();
  if (!channelId) {
    sendJson(res, 400, { error: 'Missing `channelId` query parameter.' });
    return;
  }
  if (!isLocalProactivePullChannelId(channelId)) {
    sendJson(res, 400, { error: 'This channel does not use pull delivery.' });
    return;
  }
  const parsed = parseInt(url.searchParams.get('limit') || '20', 10);
  const rows = claimQueuedProactiveMessages(
    channelId,
    Math.min(MAX_QUEUED_PROACTIVE_MESSAGES, Number.isNaN(parsed) ? 20 : parsed),
  );
  const claimToken = rows[0]?.claim_token ?? null;
  const messages = rows.filter(
    (message) => !shouldSuppressProactiveMessage(message),
  );
  if (claimToken)
    acknowledgeProactiveMessages(
      channelId,
      claimToken,
      rows.filter(shouldSuppressProactiveMessage).map((row) => row.id),
    );
  sendJson(res, 200, { channelId, claimToken, messages });
}

export async function handleApiProactiveAcknowledge(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  if (
    !isRecord(body) ||
    typeof body.channelId !== 'string' ||
    !isLocalProactivePullChannelId(body.channelId.trim()) ||
    typeof body.claimToken !== 'string' ||
    !body.claimToken ||
    !Array.isArray(body.ids) ||
    body.ids.length > MAX_QUEUED_PROACTIVE_MESSAGES ||
    !body.ids.every((id) => Number.isSafeInteger(id) && id > 0)
  ) {
    sendJson(res, 400, {
      error:
        'Expected channelId, claimToken, and positive integer message ids.',
    });
    return;
  }
  const acknowledged = acknowledgeProactiveMessages(
    body.channelId.trim(),
    body.claimToken,
    body.ids as number[],
  );
  sendJson(res, 200, { acknowledged });
}
