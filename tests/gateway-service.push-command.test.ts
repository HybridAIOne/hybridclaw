import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-push-',
});

const TOKEN = 'ab'.repeat(32);

test('/push registers a phone for the web chat operator through the gateway', async () => {
  setupHome();
  const db = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const store = await import('../src/gateway/web-notification-store.ts');
  db.initDatabase({ quiet: true });
  const operator = store.notificationOperatorId('local-operator');
  // What /api/chat does for a web chat before any command runs.
  store.bindWebNotificationSession('proactive-feed', operator);
  const request = {
    sessionId: 'proactive-feed',
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    username: 'web',
  };

  const registered = await handleGatewayCommand({
    ...request,
    args: ['push', 'register', TOKEN, 'production', 'proactive'],
  });
  expect(registered.kind).toBe('plain');
  expect(JSON.parse(registered.text)).toMatchObject({ registered: true });
  expect(store.readMobilePushDevices(operator)).toEqual([
    { token: TOKEN, environment: 'production', kinds: ['proactive'] },
  ]);

  const elsewhere = await handleGatewayCommand({
    ...request,
    sessionId: 'discord-thread',
    channelId: 'discord',
    args: ['push', 'status'],
  });
  expect(JSON.parse(elsewhere.text)).toHaveProperty('error');

  await handleGatewayCommand({ ...request, args: ['push', 'unregister', TOKEN] });
  expect(store.readMobilePushDevices(operator)).toEqual([]);
});

test('/push register answers a phone bound to another account with taken', async () => {
  setupHome();
  vi.stubEnv('HYBRIDAI_API_KEY', 'hai-test-key');
  const platform = vi.fn(async (url: string, init: RequestInit) =>
    init.method === 'DELETE'
      ? new Response('{"status":"removed"}')
      : new Response('{"status":"taken"}', { status: 409 }),
  );
  vi.stubGlobal('fetch', platform);
  const db = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const store = await import('../src/gateway/web-notification-store.ts');
  db.initDatabase({ quiet: true });
  const operator = store.notificationOperatorId('local-operator');
  store.bindWebNotificationSession('proactive-feed', operator);
  const request = {
    sessionId: 'proactive-feed',
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    username: 'web',
  };

  const taken = await handleGatewayCommand({
    ...request,
    args: ['push', 'register', TOKEN, 'production', 'proactive'],
  });
  expect(taken.kind).toBe('plain');
  expect(JSON.parse(taken.text)).toMatchObject({
    registered: false,
    reason: 'taken',
  });
  expect(store.readMobilePushDevices(operator)).toEqual([]);
  expect(platform).toHaveBeenCalledWith(
    expect.stringMatching(/\/v1\/push\/devices$/),
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ token: TOKEN, environment: 'production' }),
    }),
  );
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
