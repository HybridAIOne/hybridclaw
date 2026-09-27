/**
 * A browser subscribes only after a user gesture; gateway storage is bound to
 * the current operator. Unlike notification preferences, this browser's push
 * subscription is removed on logout and never contains an API token.
 */
import { requestJson } from '../api/client';

function messageWorker(worker: ServiceWorker, data: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error('Notification setup timed out.'));
    }, 10_000);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      channel.port1.close();
      resolve();
    };
    worker.postMessage(data, [channel.port2]);
  });
}

export async function enableWebPush(
  token: string,
  operatorId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window))
    throw new Error('This browser supports open-tab alerts only.');
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  const registration = await navigator.serviceWorker.ready;
  signal?.throwIfAborted();
  const { publicKey } = await requestJson<{ publicKey: string }>(
    '/api/push/key',
    { token, signal },
  );
  const key = Uint8Array.from(
    atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')),
    (char) => char.charCodeAt(0),
  );
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    }));
  signal?.throwIfAborted();
  await requestJson('/api/push/subscriptions', {
    token,
    signal,
    method: 'POST',
    body: subscription.toJSON(),
  });
  signal?.throwIfAborted();
  if (registration.active)
    await messageWorker(registration.active, {
      type: 'bind-operator',
      operatorId,
    });
}

export async function disableWebPush(token: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  if (!registration?.active?.scriptURL.endsWith('/sw.js')) return;
  await messageWorker(registration.active, {
    type: 'bind-operator',
    operatorId: null,
  });
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  try {
    await requestJson('/api/push/subscriptions', {
      token,
      method: 'DELETE',
      body: { endpoint: subscription.endpoint },
    });
  } finally {
    await subscription.unsubscribe();
  }
}
