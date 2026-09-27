import fs from 'node:fs';
import vm from 'node:vm';
import { expect, test, vi } from 'vitest';

function workerHarness() {
  const handlers = new Map<string, (event: unknown) => void>();
  const clients: Array<{ url: string; visibilityState: string; postMessage: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> }> = [];
  const showNotification = vi.fn(); const openWindow = vi.fn();
  const cache = { match: vi.fn(async () => ({ text: async () => 'operator-a' })), put: vi.fn(), delete: vi.fn() };
  vm.runInNewContext(fs.readFileSync(new URL('../console/public/sw.js', import.meta.url), 'utf8'), {
    URL, Response,
    caches: { open: async () => cache },
    self: {
      addEventListener: (name: string, callback: (event: unknown) => void) => handlers.set(name, callback),
      location: { origin: 'https://example.com' },
      clients: { matchAll: async () => clients, openWindow },
      registration: { showNotification },
    },
  });
  const dispatch = async (name: string, data: object) => {
    let pending: Promise<unknown> | undefined;
    handlers.get(name)?.({ ...data, waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
  };
  return { clients, showNotification, openWindow, cache, dispatch };
}

test('closed-tab push displays generic text and click opens the encoded session', async () => {
  const harness = workerHarness();
  await harness.dispatch('push', { data: { json: () => ({ operatorId: 'operator-a', sessionId: 'agent:a/web', title: 'Reminder', id: 'event-a' }) } });
  const [title, options] = harness.showNotification.mock.calls[0];
  expect(title).toBe('Reminder');
  expect(options.data.target).toBe('/chat/agent%3Aa%2Fweb');
  await harness.dispatch('notificationclick', { notification: { data: options.data, close: vi.fn() } });
  expect(harness.openWindow).toHaveBeenCalledWith('https://example.com/chat/agent%3Aa%2Fweb');
});

test('foreground session suppresses the alert, background session alerts and click focuses it', async () => {
  const harness = workerHarness();
  const client = { url: 'https://example.com/chat/session-a', visibilityState: 'visible', postMessage: vi.fn(), focus: vi.fn(), navigate: vi.fn() };
  harness.clients.push(client);
  const event = { data: { json: () => ({ operatorId: 'operator-a', sessionId: 'session-a', title: 'Finished', id: 'event-a' }) } };
  await harness.dispatch('push', event);
  expect(harness.showNotification).not.toHaveBeenCalled();
  client.visibilityState = 'hidden';
  await harness.dispatch('push', event);
  expect(harness.showNotification).toHaveBeenCalledOnce();
  await harness.dispatch('notificationclick', { notification: { data: harness.showNotification.mock.calls[0][1].data, close: vi.fn() } });
  expect(client.focus).toHaveBeenCalledOnce();
});

test('stale account notifications cannot display or open a conversation', async () => {
  const harness = workerHarness();
  await harness.dispatch('push', { data: { json: () => ({ operatorId: 'operator-b', sessionId: 'session-a', title: 'Secret' }) } });
  expect(harness.showNotification).not.toHaveBeenCalled();
  await harness.dispatch('notificationclick', { notification: { data: { operatorId: 'operator-b', target: '/chat/session-a' }, close: vi.fn() } });
  expect(harness.openWindow).not.toHaveBeenCalled();
});
