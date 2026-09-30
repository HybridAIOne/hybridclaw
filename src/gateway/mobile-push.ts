/**
 * Phone alerts over APNs. The gateway keeps the registered phones and decides
 * what to send; Apple's signing key stays with HybridAI, which signs and
 * forwards each alert (`POST /v1/push`) for the account the gateway's
 * HybridAI key belongs to. Without that key, phones get nothing.
 *
 * Tokens are never logged or echoed: a token and the relay are enough to
 * ring that phone.
 */
import type { MobilePushDevice } from '../../container/shared/web-notifications.js';
import { isA2ALocalModeEnabled } from '../a2a/local-mode.js';
import { readHybridAIApiKey } from '../auth/hybridai-auth.js';
import { getConfigSnapshot, HYBRIDAI_BASE_URL } from '../config/config.js';
import { logger } from '../logger.js';
import {
  deleteMobilePushDevice,
  readMobilePushDevices,
  saveMobilePushDevice,
  webNotificationSessionOperator,
} from './web-notification-store.js';

export interface MobilePushMessage {
  kind: string;
  title: string;
  body?: string;
  badge?: number;
  /** Groups alerts on the lock screen, e.g. per conversation. */
  threadId?: string;
  /** Flat keys delivered next to `aps` for the app to route by. */
  data?: Record<string, string | number | boolean>;
}

export interface MobilePushResult {
  /** Phones of the operator that accept this kind. */
  devices: number;
  /** Phones APNs accepted the alert for. */
  sent: number;
}

const TOKEN_PATTERN = /^[0-9a-f]{64,200}$/;
const KIND_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const DEFAULT_KINDS = ['turn', 'reminder', 'approval'];
// APNs refuses larger payloads.
const MAX_PAYLOAD_BYTES = 4096;
const RELAY_TIMEOUT_MS = 10_000;

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

export function buildApnsPayload(
  message: MobilePushMessage,
): Record<string, unknown> {
  const data = message.data ?? {};
  if ('aps' in data || 'kind' in data)
    throw new Error('Push data may not set aps or kind.');
  const alert: Record<string, string> = { title: clip(message.title, 120) };
  if (message.body) alert.body = clip(message.body, 240);
  const payload = {
    aps: {
      alert,
      sound: 'default',
      ...(message.badge !== undefined ? { badge: message.badge } : {}),
      ...(message.threadId ? { 'thread-id': message.threadId } : {}),
    },
    kind: message.kind,
    ...data,
  };
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES)
    throw new Error('Push payload exceeds 4 KB.');
  return payload;
}

async function relay(
  apiKey: string,
  device: MobilePushDevice,
  payload: Record<string, unknown>,
): Promise<'sent' | 'unregistered' | 'failed'> {
  const response = await fetch(
    `${(HYBRIDAI_BASE_URL || 'https://hybridai.one').replace(/\/+$/g, '')}/v1/push`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token: device.token,
        environment: device.environment,
        payload,
      }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    },
  );
  const answer = (await response.json().catch(() => null)) as {
    status?: unknown;
  } | null;
  if (answer?.status === 'sent' || answer?.status === 'unregistered')
    return answer.status;
  return 'failed';
}

/** Sends one alert to the given phones; failures only reduce `sent`. */
export async function sendMobilePush(
  devices: MobilePushDevice[],
  message: MobilePushMessage,
): Promise<MobilePushResult> {
  const targets = devices.filter((device) =>
    device.kinds.includes(message.kind),
  );
  const result = { devices: targets.length, sent: 0 };
  if (!targets.length || isA2ALocalModeEnabled(getConfigSnapshot()))
    return result;
  const apiKey = readHybridAIApiKey();
  if (!apiKey) return result;
  const payload = buildApnsPayload(message);
  await Promise.all(
    targets.map(async (device) => {
      try {
        const outcome = await relay(apiKey, device, payload);
        if (outcome === 'sent') result.sent += 1;
        else if (outcome === 'unregistered')
          deleteMobilePushDevice(device.token);
        else logger.warn('Phone push was refused by the relay');
      } catch {
        logger.warn('Phone push delivery failed');
      }
    }),
  );
  return result;
}

/** Alerts the phones of whoever opened `sessionId` in web chat. */
export async function notifySessionPhones(
  sessionId: string,
  message: MobilePushMessage,
): Promise<MobilePushResult> {
  if (!KIND_PATTERN.test(message.kind))
    throw new Error('Push kind must be a short lowercase identifier.');
  const operatorId = webNotificationSessionOperator(sessionId);
  if (!operatorId) return { devices: 0, sent: 0 };
  return sendMobilePush(readMobilePushDevices(operatorId), message);
}

/**
 * The items of a reply that is a JSON array of objects with a `title`, read
 * from its first `[` to its last `]` so a sentence or fence around it does
 * not matter. Anything else lists nothing.
 */
export function listedTitles(text: string): string[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) =>
    item && typeof item.title === 'string' && item.title.trim()
      ? [item.title.trim()]
      : [],
  );
}

/**
 * A scheduled reply with `--alert <kind>`: rings the phones of whoever opened
 * the chat with the first listed item, and says nothing for a reply that
 * lists none. Unlike the generic reminder, the item's title is on the lock
 * screen: the task's creator asked for that.
 */
export async function alertListedItems(options: {
  sessionId: string;
  kind: string;
  assistant: string;
  text: string;
  messageId: number;
}): Promise<MobilePushResult> {
  const titles = listedTitles(options.text);
  if (!titles.length) return { devices: 0, sent: 0 };
  return notifySessionPhones(options.sessionId, {
    kind: options.kind,
    title: options.assistant,
    body:
      titles.length > 1
        ? `${titles[0]} (+${titles.length - 1} more)`
        : titles[0],
    threadId: options.sessionId,
    data: {
      sessionId: options.sessionId,
      messageId: options.messageId,
      count: titles.length,
    },
  });
}

function reply(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/**
 * `/push register <token> <sandbox|production> [kind,kind]`,
 * `/push unregister <token>`, `/push status`. Answers one line of JSON for
 * the app that sends it. Phones belong to the operator the web session was
 * opened by, so the command works from web chat only.
 */
export function runPushCommand(args: string[], sessionId: string): string {
  const operatorId = webNotificationSessionOperator(sessionId);
  if (!operatorId)
    return reply({ error: 'Phones can be registered from web chat only.' });
  const sub = (args[1] || '').toLowerCase();
  const token = (args[2] || '').toLowerCase();
  if (sub === 'status')
    return reply({
      devices: readMobilePushDevices(operatorId).length,
      relay: readHybridAIApiKey() !== null,
    });
  if (
    (sub === 'register' || sub === 'unregister') &&
    !TOKEN_PATTERN.test(token)
  )
    return reply({ error: 'Expected an APNs device token in hex.' });
  if (sub === 'unregister') {
    deleteMobilePushDevice(token, operatorId);
    return reply({ registered: false });
  }
  if (sub === 'register') {
    const environment = args[3];
    if (environment !== 'sandbox' && environment !== 'production')
      return reply({ error: 'Environment must be sandbox or production.' });
    const kinds = args[4] ? args[4].split(',') : DEFAULT_KINDS;
    if (kinds.length > 8 || !kinds.every((kind) => KIND_PATTERN.test(kind)))
      return reply({ error: 'Expected up to 8 comma-separated kinds.' });
    try {
      saveMobilePushDevice(operatorId, {
        token,
        environment,
        kinds: [...new Set(kinds)],
      });
    } catch (error) {
      return reply({ error: (error as Error).message });
    }
    return reply({ registered: true, relay: readHybridAIApiKey() !== null });
  }
  return reply({
    error:
      'Usage: /push register <token> <sandbox|production> [kinds] | unregister <token> | status',
  });
}
