/* Push only: no application-shell, API, credential, or conversation caching. */
const BINDING_CACHE = 'hybridclaw-push-binding';
const BINDING_URL = '/__hybridclaw_push_operator';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'bind-operator') return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(BINDING_CACHE);
      if (event.data.operatorId) {
        await cache.put(BINDING_URL, new Response(event.data.operatorId));
      } else {
        await cache.delete(BINDING_URL);
        for (const notification of await self.registration.getNotifications())
          notification.close();
      }
      event.ports[0]?.postMessage('ok');
    })(),
  );
});

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const notification = event.data?.json();
      if (
        !notification ||
        typeof notification.sessionId !== 'string' ||
        typeof notification.title !== 'string'
      )
        return;
      const binding = await (await caches.open(BINDING_CACHE)).match(
        BINDING_URL,
      );
      if (!binding || (await binding.text()) !== notification.operatorId)
        return;
      const target = `/chat/${encodeURIComponent(notification.sessionId)}`;
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clients)
        client.postMessage({ type: 'web-notification', notification });
      if (
        clients.some(
          (client) =>
            client.visibilityState === 'visible' &&
            new URL(client.url).pathname === target,
        )
      )
        return;
      await self.registration.showNotification(notification.title, {
        body: 'Open the conversation to view it.',
        tag: notification.id,
        icon: '/icons/push-192.png',
        data: { target, operatorId: notification.operatorId },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const { target, operatorId } = event.notification.data ?? {};
      const binding = await (await caches.open(BINDING_CACHE)).match(
        BINDING_URL,
      );
      if (
        !binding ||
        (await binding.text()) !== operatorId ||
        typeof target !== 'string' ||
        !target.startsWith('/chat/')
      )
        return;
      const url = new URL(target, self.location.origin);
      if (url.origin !== self.location.origin) return;
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      const client =
        clients.find((item) => item.url === url.href) ??
        clients.find((item) => new URL(item.url).pathname.startsWith('/chat'));
      if (client) {
        await client.navigate(url.href);
        await client.focus();
      } else {
        await self.clients.openWindow(url.href);
      }
    })(),
  );
});
