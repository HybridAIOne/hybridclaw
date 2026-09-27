/**
 * Gateway-owned notification state survives worker and gateway restarts.
 * Unlike agent memory, subscription endpoints and operator bindings are never
 * exposed to tools; browser requests cannot choose another operator's identity.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  WebNotification,
  WebNotificationPreferences,
  WebNotificationState,
  WebPushSubscription,
} from '../../container/shared/web-notifications.js';
import { DATA_DIR } from '../config/config.js';

interface OperatorState {
  preferences: WebNotificationPreferences;
  notifications: WebNotification[];
  subscriptions: Record<string, WebPushSubscription>;
}
interface NotificationStore {
  operators: Record<string, OperatorState>;
  sessions: Record<string, string>;
}

const storePath = path.join(DATA_DIR, 'web-notifications.json');

function readStore(): NotificationStore {
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8')) as NotificationStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { operators: {}, sessions: {} };
  }
}

function writeStore(store: NotificationStore): void {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${storePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(store), {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, storePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function notificationOperatorId(actor: string): string {
  // lgtm[js/insufficient-password-hash] This is a stable lookup key for operator
  // identities, sessions and push endpoints, never a password/token verifier.
  return createHash('sha256').update(actor).digest('hex');
}

function operatorState(
  store: NotificationStore,
  operatorId: string,
): OperatorState {
  store.operators[operatorId] ??= {
    // 2026-09-27 (#1480): all three event classes default on after explicit
    // browser opt-in; richer routing rules are deferred to operator preferences.
    preferences: { turn: true, reminder: true, approval: true },
    notifications: [],
    subscriptions: {},
  };
  return store.operators[operatorId];
}

export function bindWebNotificationSession(
  sessionId: string,
  operatorId: string,
): void {
  const store = readStore();
  const key = notificationOperatorId(sessionId);
  if (store.sessions[key]) return;
  store.sessions[key] = operatorId;
  writeStore(store);
}

export function webSessionOperator(sessionId: string): string | undefined {
  return readStore().sessions[notificationOperatorId(sessionId)];
}

export function readWebNotificationState(
  operatorId: string,
): WebNotificationState {
  const state = operatorState(readStore(), operatorId);
  return {
    operatorId,
    preferences: state.preferences,
    notifications: state.notifications,
  };
}

export function saveWebNotificationPreferences(
  operatorId: string,
  preferences: WebNotificationPreferences,
): void {
  const store = readStore();
  operatorState(store, operatorId).preferences = preferences;
  writeStore(store);
}

export function saveWebPushSubscription(
  operatorId: string,
  subscription: WebPushSubscription,
): void {
  const store = readStore();
  const id = notificationOperatorId(subscription.endpoint);
  // One endpoint belongs to one signed-in operator, including account switches.
  for (const state of Object.values(store.operators))
    delete state.subscriptions[id];
  const subscriptions = operatorState(store, operatorId).subscriptions;
  // 2026-09-27 (#1480): bound per-operator fanout to 16 browsers.
  if (Object.keys(subscriptions).length >= 16)
    throw new Error(
      'Too many subscribed browsers. Disable an old browser first.',
    );
  subscriptions[id] = subscription;
  writeStore(store);
}

export function deleteWebPushSubscription(
  operatorId: string,
  endpoint: string,
): void {
  const store = readStore();
  delete operatorState(store, operatorId).subscriptions[
    notificationOperatorId(endpoint)
  ];
  writeStore(store);
}

export function webPushSubscriptions(
  operatorId: string,
): WebPushSubscription[] {
  return Object.values(operatorState(readStore(), operatorId).subscriptions);
}

export function appendWebNotification(
  operatorId: string,
  notification: WebNotification,
): boolean {
  const store = readStore();
  const state = operatorState(store, operatorId);
  if (state.notifications.some((item) => item.id === notification.id))
    return false;
  // 2026-09-27 (#1480): retain the latest 100 unread events per operator.
  state.notifications = [...state.notifications, notification].slice(-100);
  writeStore(store);
  return true;
}

export function acknowledgeWebNotifications(
  operatorId: string,
  ids: string[],
): void {
  const store = readStore();
  const state = operatorState(store, operatorId);
  const acknowledged = new Set(ids);
  state.notifications = state.notifications.filter(
    (item) => !acknowledged.has(item.id),
  );
  writeStore(store);
}
