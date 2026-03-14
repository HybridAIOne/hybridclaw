import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-bot-auth-',
  cleanup: () => {
    vi.doUnmock('../src/providers/hybridai-bots.ts');
  },
});

test('bot list returns an actionable message on HybridAI auth failure', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  vi.doMock('../src/providers/hybridai-bots.ts', () => ({
    fetchHybridAIBots: vi.fn(async () => {
      throw new Error('Failed to fetch bots: 401 UNAUTHORIZED');
    }),
  }));

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-bot-auth',
    guildId: null,
    channelId: 'channel-bot-auth',
    args: ['bot', 'list'],
  });

  expect(result).toMatchObject({
    kind: 'error',
    text: 'HybridAI bot commands require valid HybridAI API credentials. Run `hybridclaw hybridai login` and try again.',
  });
});

test('bot set fails fast on HybridAI auth failure without mutating session state', async () => {
  setupHome();

  const { getRecentStructuredAuditForSession, getSessionById, initDatabase } =
    await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  vi.doMock('../src/providers/hybridai-bots.ts', () => ({
    fetchHybridAIBots: vi.fn(async () => {
      throw new Error('Failed to fetch bots: 401 UNAUTHORIZED');
    }),
  }));

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-bot-set-auth',
    guildId: null,
    channelId: 'channel-bot-set-auth',
    args: ['bot', 'set', 'Research Bot'],
  });

  expect(result).toMatchObject({
    kind: 'error',
    text: 'HybridAI bot commands require valid HybridAI API credentials. Run `hybridclaw hybridai login` and try again.',
  });
  expect(getSessionById('session-bot-set-auth')?.chatbot_id).toBeNull();
  expect(
    getRecentStructuredAuditForSession('session-bot-set-auth', 10),
  ).toEqual([]);
});
test.each([
  {
    name: 'list',
    args: ['bot', 'list'],
  },
  {
    name: 'set',
    args: ['bot', 'set', 'Research Bot'],
  },
  {
    name: 'info',
    args: ['bot', 'info'],
  },
])('bot $name returns a provider-only message for non-HybridAI session models', async ({
  args,
  name,
}) => {
  setupHome();

  const fetchHybridAIBots = vi.fn(async () => [
    {
      id: 'bot-research',
      name: 'Research Bot',
    },
  ]);
  vi.doMock('../src/providers/hybridai-bots.ts', () => ({
    fetchHybridAIBots,
  }));

  const {
    getOrCreateSession,
    getRecentStructuredAuditForSession,
    getSessionById,
    initDatabase,
    updateSessionModel,
  } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const sessionId = `session-bot-provider-${name}`;
  getOrCreateSession(sessionId, null, `channel-bot-provider-${name}`);
  updateSessionModel(sessionId, 'openai-codex/gpt-5.4');

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId: `channel-bot-provider-${name}`,
    args,
  });

  expect(result).toEqual({
    kind: 'plain',
    text: 'Only for hybridai provider',
  });
  expect(fetchHybridAIBots).not.toHaveBeenCalled();
  expect(getRecentStructuredAuditForSession(sessionId, 10)).toEqual([]);
  expect(getSessionById(sessionId)?.chatbot_id).toBeNull();
});
