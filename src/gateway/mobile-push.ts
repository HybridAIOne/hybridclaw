/**
 * Phone alerts over APNs. The gateway keeps the registered phones and decides
 * what to send; Apple's signing key stays with HybridAI, which signs and
 * forwards each alert (`POST /v1/push`) for the account the gateway's
 * HybridAI key belongs to. Without that key, phones get nothing.
 *
 * HybridAI only forwards to phones bound to that account
 * (`POST /v1/push/devices`), so one account cannot ring another's phone. A
 * phone bound elsewhere is refused at `/push register`; one whose binding
 * failed is bound again on the next alert.
 *
 * Tokens are never logged or echoed: a token and the relay are enough to
 * ring that phone.
 */

import type {
  MobilePushDevice,
  WebNotification,
} from '../../container/shared/web-notifications.js';
import { isA2ALocalModeEnabled } from '../a2a/local-mode.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { readHybridAIApiKey } from '../auth/hybridai-auth.js';
import { getConfigSnapshot, HYBRIDAI_BASE_URL } from '../config/config.js';
import { logger } from '../logger.js';
import { recordWorkPush, skipWorkNotification } from '../work/work-delivery.js';
import {
  deleteMobilePushDevice,
  mobilePushDeviceApp,
  mobilePushDeviceHeld,
  readMobilePushDevices,
  readSessionMobilePushDevices,
  saveMobilePushDevice,
  webNotificationSessionOperator,
} from './web-notification-store.js';

export interface MobilePushMessage {
  kind: string;
  title: string;
  body?: string;
  /**
   * A key the app translates the body by (APNs `loc-key`), so the alert is in
   * the phone's language; where the app has no such key, the key is shown.
   */
  bodyKey?: string;
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

/**
 * The HybridAI app a web chat request came from: its `appId`, else Hy (`hy`)
 * for the phone app's `client: "mobile"`. Undefined for the browser, a script
 * or anything else, whose chats ring no phone.
 */
export function chatPushApp(body: {
  appId?: unknown;
  client?: unknown;
}): string | undefined {
  if (typeof body.appId === 'string' && KIND_PATTERN.test(body.appId))
    return body.appId;
  return body.client === 'mobile' ? 'hy' : undefined;
}

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
  if (message.bodyKey) alert['loc-key'] = clip(message.bodyKey, 240);
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

type RelayAnswer = 'sent' | 'unregistered' | 'not_registered' | 'failed';
type BindAnswer = 'registered' | 'taken' | 'unknown_app' | 'failed';

async function platform(
  apiKey: string,
  method: 'POST' | 'DELETE',
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(
    `${(HYBRIDAI_BASE_URL || 'https://hybridai.one').replace(/\/+$/g, '')}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    },
  );
  // Refusals (409 taken) carry their status in the body too.
  const answer = (await response.json().catch(() => null)) as {
    status?: unknown;
  } | null;
  return answer?.status;
}

/**
 * The app HybridAI signs the phone's alerts for. Left out for Hy, its
 * default, so relays that predate other apps still take Hy's alerts.
 */
function relayApp(device: Pick<MobilePushDevice, 'app'>): { app?: string } {
  const app = mobilePushDeviceApp(device);
  return app === 'hy' ? {} : { app };
}

async function relay(
  apiKey: string,
  device: MobilePushDevice,
  payload: Record<string, unknown>,
): Promise<RelayAnswer> {
  const workId =
    typeof payload.workId === 'string' ? payload.workId : undefined;
  const status = await recordWorkPush(workId, () =>
    platform(apiKey, 'POST', '/v1/push', {
      token: device.token,
      environment: device.environment,
      ...relayApp(device),
      payload,
    }),
  );
  return status === 'sent' ||
    status === 'unregistered' ||
    status === 'not_registered'
    ? status
    : 'failed';
}

/** Binds a phone to the account of the gateway's HybridAI key. */
async function bind(
  apiKey: string,
  device: Pick<MobilePushDevice, 'token' | 'environment' | 'app'>,
): Promise<BindAnswer> {
  try {
    const status = await platform(apiKey, 'POST', '/v1/push/devices', {
      token: device.token,
      environment: device.environment,
      ...relayApp(device),
    });
    return status === 'registered' ||
      status === 'taken' ||
      status === 'unknown_app'
      ? status
      : 'failed';
  } catch {
    return 'failed';
  }
}

/** The HybridAI key alerts go out with, or null where nothing may leave. */
function relayKey(): string | null {
  if (isA2ALocalModeEnabled(getConfigSnapshot())) return null;
  return readHybridAIApiKey();
}

async function deliver(
  apiKey: string,
  device: MobilePushDevice,
  payload: Record<string, unknown>,
): Promise<boolean> {
  let outcome = await relay(apiKey, device, payload);
  if (outcome === 'not_registered') {
    // Registered while HybridAI was unreachable: bind now and retry once.
    const bound = await bind(apiKey, device);
    if (bound === 'registered') outcome = await relay(apiKey, device, payload);
    else if (bound === 'taken' || bound === 'unknown_app')
      outcome = 'unregistered';
  }
  if (outcome === 'unregistered') deleteMobilePushDevice(device.token);
  else if (outcome !== 'sent')
    logger.warn('Phone push was refused by the relay');
  return outcome === 'sent';
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
  const workId =
    typeof message.data?.workId === 'string' ? message.data.workId : undefined;
  if (!targets.length) {
    skipWorkNotification(workId, 'no_devices');
    return result;
  }
  const apiKey = relayKey();
  if (!apiKey) {
    skipWorkNotification(workId, 'relay_disabled');
    return result;
  }
  const payload = buildApnsPayload(message);
  await Promise.all(
    targets.map(async (device) => {
      try {
        if (await deliver(apiKey, device, payload)) result.sent += 1;
      } catch {
        logger.warn('Phone push delivery failed');
      }
    }),
  );
  return result;
}

/**
 * Alerts the phones of whoever opened `sessionId` in web chat that belong to
 * the app the chat was last used from.
 */
export async function notifySessionPhones(
  sessionId: string,
  message: MobilePushMessage,
): Promise<MobilePushResult> {
  if (!KIND_PATTERN.test(message.kind))
    throw new Error('Push kind must be a short lowercase identifier.');
  return sendMobilePush(readSessionMobilePushDevices(sessionId), message);
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
 * lists none. The item's title is on the lock screen: the task's creator
 * asked for that.
 */
export async function alertListedItems(options: {
  sessionId: string;
  kind: string;
  assistant: string;
  text: string;
  messageId: number;
  workId?: string;
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
      ...(options.workId ? { workId: options.workId } : {}),
      count: titles.length,
    },
  });
}

/**
 * A delivered reminder: the assistant's name over the reminder itself; the
 * badge counts the reminders not yet read (`/api/push/read`). `messageId` is
 * the stored reply, the last part of the notice id, which the app reads back
 * whole with `GET /api/chat/message`.
 */
export function reminderAlert(options: {
  notification: WebNotification;
  assistant: string;
  text: string;
  unread: number;
  messageId: number;
  workId?: string;
}): MobilePushMessage {
  const { notification } = options;
  const body = options.text.trim();
  return {
    kind: 'reminder',
    title: options.assistant,
    ...(body ? { body } : {}),
    badge: options.unread,
    threadId: notification.sessionId,
    data: {
      id: notification.id,
      sessionId: notification.sessionId,
      ...(notification.agentId ? { agentId: notification.agentId } : {}),
      messageId: options.messageId,
      ...(options.workId ? { workId: options.workId } : {}),
    },
  };
}

/**
 * What a phone calls the assistant in an alert's title. The phone app knows
 * the default agent as Hy, whatever it is called here; any other agent goes by
 * its display name or name, and is Hy too without either, never the runtime.
 */
export function phoneAssistantName(
  agentId: string | null | undefined,
  agent: { name?: string; displayName?: string } | null,
): string {
  if (!agentId || agentId === DEFAULT_AGENT_ID) return 'Hy';
  return agent?.displayName || agent?.name || 'Hy';
}

// What a finished reply and a waiting approval say under the assistant's name.
// Each is also the app's key for it, so a phone shows it in its own language.
const REPLY_BODIES: Partial<Record<string, string>> = {
  turn: 'Done. Your reply is ready.',
  approval: 'Needs your approval to go on.',
};

/**
 * "Done" or "needs you": the assistant's name over what happened, never what
 * the reply or the request says. Other kinds show the name alone: a notice's
 * own title is for browsers and names the runtime, not the assistant.
 */
export function replyAlert(options: {
  notification: WebNotification;
  assistant: string;
}): MobilePushMessage {
  const { notification } = options;
  const body = REPLY_BODIES[notification.kind];
  return {
    kind: notification.kind,
    title: options.assistant,
    ...(body ? { body, bodyKey: body } : {}),
    threadId: notification.sessionId,
    data: {
      id: notification.id,
      sessionId: notification.sessionId,
      ...(notification.agentId ? { agentId: notification.agentId } : {}),
    },
  };
}

function reply(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/**
 * `/push register <token> <sandbox|production> [kind,kind] [app]`,
 * `/push unregister <token>`, `/push status`. Answers one line of JSON for
 * the app that sends it. Phones belong to the operator the web session was
 * opened by, so the command works from web chat only. `app` is the HybridAI
 * app the phone belongs to, as its chats name it in `appId`: only that app's
 * chats ring the phone, and HybridAI signs the alerts for that app. It
 * defaults to Hy, `hy`.
 */
export async function runPushCommand(
  args: string[],
  sessionId: string,
): Promise<string> {
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
    // Best effort, and only once no operator here holds the phone any more.
    const apiKey = relayKey();
    if (apiKey && !mobilePushDeviceHeld(token))
      await platform(apiKey, 'DELETE', '/v1/push/devices', { token }).catch(
        () => logger.warn('Could not release the phone at HybridAI'),
      );
    return reply({ registered: false });
  }
  if (sub === 'register') {
    const environment = args[3];
    if (environment !== 'sandbox' && environment !== 'production')
      return reply({ error: 'Environment must be sandbox or production.' });
    const kinds = args[4] ? args[4].split(',') : DEFAULT_KINDS;
    if (kinds.length > 8 || !kinds.every((kind) => KIND_PATTERN.test(kind)))
      return reply({ error: 'Expected up to 8 comma-separated kinds.' });
    const app = (args[5] || 'hy').toLowerCase();
    if (!KIND_PATTERN.test(app))
      return reply({ error: 'Expected the app as one lowercase word.' });
    // Unreachable or unconfigured: kept anyway, bound on its first alert.
    const apiKey = relayKey();
    const bound = apiKey
      ? await bind(apiKey, { token, environment, app })
      : null;
    if (bound === 'taken' || bound === 'unknown_app') {
      // No alert could reach it from here.
      deleteMobilePushDevice(token);
      return reply({
        registered: false,
        reason: bound,
        error:
          bound === 'taken'
            ? 'This phone gets alerts from another HybridAI account.'
            : 'HybridAI does not send alerts for this app.',
      });
    }
    try {
      saveMobilePushDevice(operatorId, {
        token,
        environment,
        kinds: [...new Set(kinds)],
        app,
      });
    } catch (error) {
      return reply({ error: (error as Error).message });
    }
    // `app` tells an app that this runtime keeps phones per app; an older one
    // would ring it for every app's chats.
    return reply({
      registered: true,
      relay: readHybridAIApiKey() !== null,
      app,
    });
  }
  return reply({
    error:
      'Usage: /push register <token> <sandbox|production> [kinds] [app] | unregister <token> | status',
  });
}
