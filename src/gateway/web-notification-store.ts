/**
 * Gateway-owned notification state survives worker and gateway restarts.
 * Unlike agent memory, subscription endpoints and operator bindings are never
 * exposed to tools; browser requests cannot choose another operator's identity.
 * Recording an alert reads and commits once, returning its delivery snapshot.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  MobilePushDevice,
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
  // Absent in stores written before phones could register.
  devices?: Record<string, MobilePushDevice>;
}
interface NotificationStore {
  operators: Record<string, OperatorState>;
  sessions: Record<string, string>;
  // The HybridAI app each session was last chatted in from, by session key.
  // Absent in stores written before phones were matched to their app.
  sessionApps?: Record<string, string>;
}

const storePath = path.join(DATA_DIR, 'web-notifications.json');
let directoryReady = false;

function readStore(): NotificationStore {
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8')) as NotificationStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { operators: {}, sessions: {} };
  }
}

function writeStore(store: NotificationStore): void {
  if (!directoryReady) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    directoryReady = true;
  }
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

/**
 * The operator that first chats in a session owns it. Each chat also records
 * the HybridAI app it came from (none for the browser or a script), so only
 * phones of that app ring for the session (issue #1781).
 */
export function bindWebNotificationSession(
  sessionId: string,
  operatorId: string,
  app?: string,
): void {
  const store = readStore();
  const key = notificationOperatorId(sessionId);
  const owner = store.sessions[key];
  if (owner && owner !== operatorId) return;
  if (owner && store.sessionApps?.[key] === app) return;
  store.sessions[key] = operatorId;
  store.sessionApps ??= {};
  if (app) store.sessionApps[key] = app;
  else delete store.sessionApps[key];
  writeStore(store);
}

/** The app a phone belongs to; one registered before phones named it is Hy's. */
export function mobilePushDeviceApp(
  device: Pick<MobilePushDevice, 'app'>,
): string {
  return device.app ?? 'hy';
}

// The phones that ring for a session: its owner's phones of the app the
// session was last chatted in from. None for a chat no phone app opened, such
// as one from the browser, a script or another HybridAI app.
function sessionDevices(
  store: NotificationStore,
  key: string,
  state: OperatorState,
): MobilePushDevice[] {
  const app = store.sessionApps?.[key];
  if (!app) return [];
  return Object.values(state.devices ?? {}).filter(
    (device) => mobilePushDeviceApp(device) === app,
  );
}

/** The phones that ring for `sessionId`; none for a session no one owns. */
export function readSessionMobilePushDevices(
  sessionId: string,
): MobilePushDevice[] {
  const store = readStore();
  const key = notificationOperatorId(sessionId);
  const operatorId = store.sessions[key];
  if (!operatorId) return [];
  return sessionDevices(store, key, operatorState(store, operatorId));
}

// The operator that first chatted in a session owns it, or null for other
// channels. Reading its replies back (device-messages.ts) and registering
// phones (mobile-push.ts) are limited to that operator.
export function webNotificationSessionOperator(
  sessionId: string,
): string | null {
  return readStore().sessions[notificationOperatorId(sessionId)] ?? null;
}

export function deleteWebNotificationSession(sessionId: string): void {
  const store = readStore();
  const key = notificationOperatorId(sessionId);
  const operatorId = store.sessions[key];
  if (!operatorId) return;
  delete store.sessions[key];
  delete store.sessionApps?.[key];
  const state = operatorState(store, operatorId);
  state.notifications = state.notifications.filter(
    (notification) => notification.sessionId !== sessionId,
  );
  writeStore(store);
}

/** Moves a session's owner, app and notifications to a new session id. */
export function renameWebNotificationSession(
  fromSessionId: string,
  toSessionId: string,
): void {
  const store = readStore();
  const fromKey = notificationOperatorId(fromSessionId);
  const operatorId = store.sessions[fromKey];
  if (!operatorId) return;
  const toKey = notificationOperatorId(toSessionId);
  store.sessions[toKey] = operatorId;
  delete store.sessions[fromKey];
  const app = store.sessionApps?.[fromKey];
  if (store.sessionApps) {
    delete store.sessionApps[fromKey];
    if (app) store.sessionApps[toKey] = app;
  }
  for (const notification of operatorState(store, operatorId).notifications) {
    if (notification.sessionId === fromSessionId) {
      notification.sessionId = toSessionId;
    }
  }
  writeStore(store);
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

export function readMobilePushDevices(operatorId: string): MobilePushDevice[] {
  return Object.values(operatorState(readStore(), operatorId).devices ?? {});
}

export function saveMobilePushDevice(
  operatorId: string,
  device: MobilePushDevice,
): void {
  const store = readStore();
  const id = notificationOperatorId(
    device.platform === 'android' ? `android:${device.token}` : device.token,
  );
  // One phone belongs to one operator, as a browser endpoint does.
  for (const state of Object.values(store.operators))
    delete state.devices?.[id];
  const state = operatorState(store, operatorId);
  state.devices ??= {};
  // Same bound as browsers (#1480).
  if (Object.keys(state.devices).length >= 16)
    throw new Error('Too many registered phones. Unregister an old one first.');
  state.devices[id] = device;
  writeStore(store);
}

/** Whether any operator still has this phone registered. */
export function mobilePushDeviceHeld(
  token: string,
  platform: MobilePushDevice['platform'] = 'ios',
): boolean {
  const id = notificationOperatorId(
    platform === 'android' ? `android:${token}` : token,
  );
  return Object.values(readStore().operators).some(
    (state) => state.devices?.[id] !== undefined,
  );
}

/** Forgets a phone. Without an operator, whoever holds it (APNs said it is gone). */
export function deleteMobilePushDevice(
  token: string,
  operatorId?: string,
  platform: MobilePushDevice['platform'] = 'ios',
): void {
  const store = readStore();
  const id = notificationOperatorId(
    platform === 'android' ? `android:${token}` : token,
  );
  const states = operatorId
    ? [operatorState(store, operatorId)]
    : Object.values(store.operators);
  for (const state of states) delete state.devices?.[id];
  writeStore(store);
}

export function recordWebNotification(
  notification: WebNotification,
  requestedOperatorId?: string,
): {
  state: WebNotificationState;
  subscriptions: WebPushSubscription[];
  devices: MobilePushDevice[];
} | null {
  const store = readStore();
  const key = notificationOperatorId(notification.sessionId);
  const operatorId = store.sessions[key] ?? requestedOperatorId;
  if (!operatorId) return null;
  store.sessions[key] = operatorId;
  const state = operatorState(store, operatorId);
  if (state.notifications.some((item) => item.id === notification.id))
    return null;
  // 2026-09-27 (#1480): retain the latest 100 unread events per operator.
  state.notifications = [...state.notifications, notification].slice(-100);
  writeStore(store);
  return {
    state: {
      operatorId,
      preferences: state.preferences,
      notifications: state.notifications,
    },
    subscriptions: Object.values(state.subscriptions),
    devices: sessionDevices(store, key, state),
  };
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
