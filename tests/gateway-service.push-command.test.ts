import { expect, test } from 'vitest';

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
