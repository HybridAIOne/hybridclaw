/**
 * Persists operator-scoped alerts before broadcasting to open pages or push.
 * Unlike chat delivery, notification failures never fail an already stored
 * reply. Push payloads contain routing metadata, never conversation content;
 * only a phone reminder carries its text (web-scheduled-delivery.ts).
 */
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type {
  MobilePushDevice,
  WebNotification,
  WebNotificationKind,
  WebNotificationState,
  WebPushSubscription,
} from '../../container/shared/web-notifications.js';
import { isA2ALocalModeEnabled } from '../a2a/local-mode.js';
import { getConfigSnapshot } from '../config/config.js';
import { logger } from '../logger.js';
import { memoryService } from '../memory/memory-service.js';
import { fetchPublicHttpsBuffer } from '../security/public-https-fetch.js';
import {
  readStoredRuntimeSecrets,
  saveNamedRuntimeSecrets,
} from '../security/runtime-secrets.js';
import type { GatewayChatRequest, GatewayChatResult } from './gateway-types.js';
import { replyAlert, sendMobilePush } from './mobile-push.js';
import {
  bindWebNotificationSession,
  deleteWebPushSubscription,
  readWebNotificationState,
  recordWebNotification,
} from './web-notification-store.js';

const listeners = new Map<string, Set<ServerResponse>>();
const titles: Record<WebNotificationKind, string> = {
  turn: 'HybridClaw finished your request',
  reminder: 'HybridClaw reminder',
  approval: 'HybridClaw needs your approval',
};

export function trackWebNotificationSession(
  sessionId: string,
  operatorId: string,
): boolean {
  try {
    bindWebNotificationSession(sessionId, operatorId);
    return true;
  } catch {
    logger.warn('Could not bind web notifications to the conversation');
    return false;
  }
}

export async function webPushKeys(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const webpush = (await import('web-push')).default;
  // Read after the await: concurrent first subscriptions must share one keypair.
  const secrets = readStoredRuntimeSecrets();
  if (secrets.WEB_PUSH_VAPID_KEYS)
    return JSON.parse(secrets.WEB_PUSH_VAPID_KEYS);
  const keys = webpush.generateVAPIDKeys();
  saveNamedRuntimeSecrets({ WEB_PUSH_VAPID_KEYS: JSON.stringify(keys) });
  return keys;
}

export function closeWebNotificationStreams(): void {
  for (const subscribers of listeners.values()) {
    for (const response of subscribers) response.end();
  }
  listeners.clear();
}

export function broadcastWebNotifications(
  operatorId: string,
  state: WebNotificationState = readWebNotificationState(operatorId),
): void {
  const payload = `event: notifications\ndata: ${JSON.stringify(state)}\n\n`;
  for (const response of listeners.get(operatorId) ?? []) {
    if (!response.destroyed && !response.writableEnded) response.write(payload);
  }
}

export function streamWebNotifications(
  operatorId: string,
  response: ServerResponse,
): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  const subscribers = listeners.get(operatorId) ?? new Set<ServerResponse>();
  listeners.set(operatorId, subscribers);
  subscribers.add(response);
  broadcastWebNotifications(operatorId);
  const timer = setInterval(() => response.write(': keepalive\n\n'), 25_000);
  response.on('close', () => {
    clearInterval(timer);
    subscribers.delete(response);
    if (!subscribers.size) listeners.delete(operatorId);
  });
}

async function sendWebPush(
  state: WebNotificationState,
  subscriptions: WebPushSubscription[],
  notification: WebNotification,
): Promise<void> {
  const { operatorId } = state;
  if (isA2ALocalModeEnabled(getConfigSnapshot())) return;
  if (!state.preferences[notification.kind]) return;
  if (!subscriptions.length) return;
  const webpush = (await import('web-push')).default;
  const keys = await webPushKeys();
  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        const request = webpush.generateRequestDetails(
          subscription,
          JSON.stringify({ ...notification, operatorId }),
          {
            vapidDetails: {
              ...keys,
              subject: 'https://github.com/HybridAIOne/hybridclaw',
            },
            TTL: 86400,
          },
        );
        await fetchPublicHttpsBuffer(request.endpoint, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
          timeoutMs: 10_000,
          maxBytes: 4096,
        });
      } catch (error) {
        if (error instanceof Error && /^http_(404|410)$/.test(error.message)) {
          deleteWebPushSubscription(operatorId, subscription.endpoint);
        } else {
          // Push errors may contain endpoint credentials; never log the error.
          logger.warn('Web push delivery failed; notification remains in chat');
        }
      }
    }),
  );
}

/** A phone names the assistant, as it does for a reminder. */
async function phoneAlert(notification: WebNotification) {
  const { getAgentById } = await import('../agents/agent-registry.js');
  const agent = notification.agentId
    ? getAgentById(notification.agentId)
    : null;
  return replyAlert({
    notification,
    assistant: agent?.displayName || agent?.name || 'HybridClaw',
  });
}

export interface WebNotificationDelivery {
  notification: WebNotification;
  state: WebNotificationState;
  devices: MobilePushDevice[];
}

/**
 * Records and broadcasts an alert. `phone: false` leaves the phone alert to
 * the caller, which gets the recorded notice back (null if none was new).
 */
export function notifyWebSession(
  sessionId: string,
  kind: WebNotificationKind,
  eventId: string = randomUUID(),
  operatorId?: string,
  { phone = true }: { phone?: boolean } = {},
): WebNotificationDelivery | null {
  try {
    const notification: WebNotification = {
      id: `${sessionId}:${kind}:${eventId}`,
      sessionId,
      kind,
      agentId: memoryService.getSessionById(sessionId)?.agent_id ?? null,
      title: titles[kind],
      createdAt: Date.now(),
    };
    const delivery = recordWebNotification(notification, operatorId);
    if (!delivery) return null;
    broadcastWebNotifications(delivery.state.operatorId, delivery.state);
    void sendWebPush(
      delivery.state,
      delivery.subscriptions,
      notification,
    ).catch(() =>
      logger.warn('Web push unavailable; notification remains in chat'),
    );
    if (phone && delivery.state.preferences[kind] && delivery.devices.length)
      void phoneAlert(notification)
        .then((message) => sendMobilePush(delivery.devices, message))
        .catch(() =>
          logger.warn('Phone push unavailable; notification remains in chat'),
        );
    return {
      notification,
      state: delivery.state,
      devices: delivery.devices,
    };
  } catch {
    logger.warn('Could not record web notification');
    return null;
  }
}

export function notifyWebChatResult(
  operatorId: string | null,
  request: GatewayChatRequest,
  result: GatewayChatResult,
  notifiedApprovalId?: string | null,
): void {
  if (!operatorId || request.channelId !== 'web' || result.status !== 'success')
    return;
  const sessionId = result.sessionId || request.sessionId;
  if (result.pendingApproval) {
    if (result.pendingApproval.approvalId === notifiedApprovalId) return;
    notifyWebSession(
      sessionId,
      'approval',
      result.pendingApproval.approvalId,
      operatorId,
    );
  } else if (
    result.messageRole === 'assistant' &&
    result.outputPresentation?.visible !== false
  ) {
    notifyWebSession(
      sessionId,
      'turn',
      String(result.assistantMessageId ?? randomUUID()),
      operatorId,
    );
  }
}
