import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-chat-cleanup-',
});

test('cleanupGatewayNoUserChatSessions preserves onboarding sessions awaiting a reply', async () => {
  setupHome();

  const { initDatabase, getOrCreateSession, getSessionById, storeMessage } =
    await import('../src/memory/db.ts');
  const { cleanupGatewayNoUserChatSessions } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');

  initDatabase({ quiet: true });
  ensureBootstrapFiles('onboarding-agent');

  const keepSession = getOrCreateSession('cleanup-keep', null, 'web', 'main');
  const emptySession = getOrCreateSession('cleanup-empty', null, 'web', 'main');
  const assistantOnlySession = getOrCreateSession(
    'cleanup-assistant-only',
    null,
    'web',
    'main',
  );
  const userSession = getOrCreateSession('cleanup-user', null, 'web', 'main');
  const onboardingSession = getOrCreateSession(
    'cleanup-onboarding',
    null,
    'web',
    'onboarding-agent',
  );
  const schedulerSession = getOrCreateSession(
    'cron:cleanup-daily',
    null,
    'web',
    'main',
  );

  storeMessage(
    assistantOnlySession.id,
    'assistant',
    null,
    'assistant',
    'Opening message',
    'main',
  );
  storeMessage(
    onboardingSession.id,
    'assistant',
    null,
    'assistant',
    'What should I call you?',
    'onboarding-agent',
  );
  storeMessage(userSession.id, 'web-user', 'User', 'user', 'Hello', 'main');

  const result = cleanupGatewayNoUserChatSessions({
    channelId: 'web',
    keepSessionId: keepSession.id,
  });

  expect(result.deletedCount).toBe(2);
  expect([...result.deletedSessionIds].sort()).toEqual(
    [assistantOnlySession.id, emptySession.id].sort(),
  );
  expect(result.keptSessionId).toBe(keepSession.id);
  expect(getSessionById(assistantOnlySession.id)).toBeUndefined();
  expect(getSessionById(emptySession.id)).toBeUndefined();
  expect(getSessionById(keepSession.id)).toBeTruthy();
  expect(getSessionById(onboardingSession.id)).toBeTruthy();
  expect(getSessionById(userSession.id)).toBeTruthy();
  expect(getSessionById(schedulerSession.id)).toBeTruthy();
});
