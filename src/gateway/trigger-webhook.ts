/**
 * `POST /api/triggers/<token>` — the web address of a webhook trigger
 * (`event-triggers.ts`). The secret token in the path is the only credential,
 * so a form, Zapier, n8n, a Slack workflow or GitHub can call it without
 * other auth. The body reaches the trigger's run as outside data.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  readWebhookBody,
  sendWebhookJson,
  WebhookHttpError,
} from '../channels/webhook-http.js';

/** Where webhook triggers live; the token follows. */
export const TRIGGER_PATH_PREFIX = '/api/triggers/';

const MAX_BYTES = 65_536;
// Headers senders keep on a retry of the same delivery.
const DELIVERY_HEADERS = ['idempotency-key', 'webhook-id', 'x-github-delivery'];

export function isTriggerWebhookPath(pathname: string): boolean {
  return (
    pathname.startsWith(TRIGGER_PATH_PREFIX) &&
    !pathname.slice(TRIGGER_PATH_PREFIX.length).includes('/')
  );
}

function bodyText(raw: Buffer, contentType: string): string {
  const text = raw.toString('utf8');
  if (!text.trim()) return '';
  if (/json/i.test(contentType)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  return text.includes('�') ? `(binary body of ${raw.length} bytes)` : text;
}

function deliveryId(req: IncomingMessage): string | null {
  for (const name of DELIVERY_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string' && value.trim())
      return `${name}:${value.trim().slice(0, 200)}`;
  }
  return null;
}

export async function handleTriggerWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendWebhookJson(res, 405, { error: 'Use POST.' });
    return;
  }
  // Loaded on use, so the gateway's routing does not load the scheduler.
  const { findWebhookTrigger, queueWebhookCall } = await import(
    '../scheduler/event-triggers.js'
  );
  const task = findWebhookTrigger(pathname.slice(TRIGGER_PATH_PREFIX.length));
  if (!task) {
    sendWebhookJson(res, 404, { error: 'Unknown trigger.' });
    return;
  }
  let raw: Buffer;
  try {
    raw = await readWebhookBody(req, {
      maxBytes: MAX_BYTES,
      tooLargeMessage: 'The body is larger than 64 KB.',
    });
  } catch (error) {
    if (error instanceof WebhookHttpError) {
      sendWebhookJson(res, error.statusCode, { error: error.message });
      return;
    }
    throw error;
  }
  const result = queueWebhookCall(
    task,
    bodyText(raw, String(req.headers['content-type'] ?? '')),
    deliveryId(req),
  );
  if (result.status === 'limited') {
    res.setHeader('retry-after', '60');
    sendWebhookJson(res, 429, { error: 'Too many calls; try again later.' });
    return;
  }
  // A paused trigger accepts and drops calls, so senders do not retry.
  sendWebhookJson(res, 202, { status: result.status });
}
