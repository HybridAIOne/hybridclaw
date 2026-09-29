/**
 * Notification endpoints accept only an identity supplied by authenticated HTTP
 * dispatch. Bodies select a browser or event, never an operator. These routes
 * do not grant access to chat history or approve pending actions.
 */
import { ECDH } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { assertBrowserNavigationUrl } from '../../container/shared/browser-navigation.js';
import type {
  WebNotificationPreferences,
  WebPushSubscription,
} from '../../container/shared/web-notifications.js';
import { isRecord } from '../utils/type-guards.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';
import {
  acknowledgeWebNotifications,
  deleteWebPushSubscription,
  notificationOperatorId,
  readWebNotificationState,
  saveWebNotificationPreferences,
  saveWebPushSubscription,
} from './web-notification-store.js';
import {
  broadcastWebNotifications,
  streamWebNotifications,
  webPushKeys,
} from './web-notifications.js';

export function resolveWebNotificationOperator(
  kind: string,
  actor: string | null | undefined,
  tokenId?: string,
): string | null {
  switch (kind) {
    case 'master':
    case 'localSession':
      return notificationOperatorId('local-operator');
    case 'session':
      return actor ? notificationOperatorId(`session:${actor}`) : null;
    case 'apiToken':
      return tokenId ? notificationOperatorId(`apiToken:${tokenId}`) : null;
    default:
      return null;
  }
}

export async function validateWebPushSubscription(
  value: unknown,
): Promise<WebPushSubscription> {
  if (
    !isRecord(value) ||
    typeof value.endpoint !== 'string' ||
    value.endpoint.length > 4096 ||
    !isRecord(value.keys)
  )
    throw new Error('Invalid push subscription.');
  const url = new URL(value.endpoint);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443')
  )
    throw new Error('Push endpoints require public HTTPS on port 443.');
  const { p256dh, auth } = value.keys;
  if (
    typeof p256dh !== 'string' ||
    typeof auth !== 'string' ||
    !/^[\w-]{87}$/.test(p256dh) ||
    !/^[\w-]{22}$/.test(auth)
  )
    throw new Error('Invalid push encryption keys.');
  ECDH.convertKey(Buffer.from(p256dh, 'base64url'), 'prime256v1');
  await assertBrowserNavigationUrl(url.href, { allowPrivateNetwork: false });
  return { endpoint: url.href, keys: { p256dh, auth } };
}

export async function handleWebNotificationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  operatorId: string,
): Promise<void> {
  const method = req.method || 'GET';
  res.setHeader('Cache-Control', 'no-store');
  if (pathname === '/api/push/events' && method === 'GET') {
    streamWebNotifications(operatorId, res);
    return;
  }
  if (pathname === '/api/push/settings' && method === 'GET') {
    sendJson(res, 200, readWebNotificationState(operatorId));
    return;
  }
  if (pathname === '/api/push/key' && method === 'GET') {
    sendJson(res, 200, { publicKey: (await webPushKeys()).publicKey });
    return;
  }
  try {
    if (pathname === '/api/push/subscriptions' && method === 'POST') {
      const subscription = await validateWebPushSubscription(
        await readJsonBody(req),
      );
      saveWebPushSubscription(operatorId, subscription);
    } else if (pathname === '/api/push/subscriptions' && method === 'DELETE') {
      const body = await readJsonBody(req);
      if (!isRecord(body) || typeof body.endpoint !== 'string')
        throw new Error('Expected subscription endpoint.');
      deleteWebPushSubscription(operatorId, body.endpoint);
    } else if (pathname === '/api/push/settings' && method === 'PUT') {
      const body = await readJsonBody(req);
      if (
        !isRecord(body) ||
        typeof body.turn !== 'boolean' ||
        typeof body.reminder !== 'boolean' ||
        typeof body.approval !== 'boolean'
      )
        throw new Error('Expected notification preferences.');
      const preferences: WebNotificationPreferences = {
        turn: body.turn,
        reminder: body.reminder,
        approval: body.approval,
      };
      saveWebNotificationPreferences(operatorId, preferences);
      broadcastWebNotifications(operatorId);
    } else if (pathname === '/api/push/read' && method === 'POST') {
      const body = await readJsonBody(req);
      if (
        !isRecord(body) ||
        !Array.isArray(body.ids) ||
        body.ids.length > 100 ||
        !body.ids.every((id) => typeof id === 'string')
      )
        throw new Error('Expected notification ids.');
      acknowledgeWebNotifications(operatorId, body.ids);
      broadcastWebNotifications(operatorId);
    } else {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    sendJson(res, 200, { ok: true });
  } catch {
    // Never echo a subscription URL or key in an error response.
    sendJson(res, 400, {
      error:
        'Could not update notifications. Check the subscription or preferences and try again.',
    });
  }
}
