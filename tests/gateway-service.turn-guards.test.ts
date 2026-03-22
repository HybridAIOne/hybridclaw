import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock, ensurePluginManagerInitializedMock, pluginManagerMock } =
  vi.hoisted(() => {
    const pluginManager = {
      collectPromptContextDetails: vi.fn(async () => ({
        sections: [],
        pluginIds: [],
      })),
      getToolDefinitions: vi.fn(() => []),
      notifyBeforeAgentStart: vi.fn(async () => {}),
      notifySessionStart: vi.fn(async () => {}),
      notifyTurnComplete: vi.fn(async () => {}),
      notifyAgentEnd: vi.fn(async () => {}),
      handleSessionReset: vi.fn(async () => {}),
    };
    return {
      runAgentMock: vi.fn(),
      ensurePluginManagerInitializedMock: vi.fn(async () => pluginManager),
      pluginManagerMock: pluginManager,
    };
  });

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/plugins/plugin-manager.js', () => ({
  ensurePluginManagerInitialized: ensurePluginManagerInitializedMock,
  reloadPluginManager: vi.fn(),
  shutdownPluginManager: vi.fn(),
  listLoadedPluginCommands: vi.fn(() => []),
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-turn-guards-',
  cleanup: () => {
    runAgentMock.mockReset();
    ensurePluginManagerInitializedMock.mockClear();
    pluginManagerMock.collectPromptContextDetails.mockClear();
    pluginManagerMock.getToolDefinitions.mockClear();
    pluginManagerMock.notifyBeforeAgentStart.mockClear();
    pluginManagerMock.notifySessionStart.mockClear();
    pluginManagerMock.notifyTurnComplete.mockClear();
    pluginManagerMock.notifyAgentEnd.mockClear();
    pluginManagerMock.handleSessionReset.mockClear();
  },
});

test('handleGatewayMessage warns on the third repeated autonomous turn', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Still working the same plan.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const request = {
    sessionId: 'session-loop-warning',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    content: 'Continue.',
    model: 'test-model',
    chatbotId: 'bot-1',
    source: 'fullauto' as const,
  };

  await handleGatewayMessage({ ...request });
  await handleGatewayMessage({ ...request });
  const third = await handleGatewayMessage({ ...request });

  expect(third.status).toBe('success');
  expect(third.result).toContain('[Loop warning]');
});

test('handleGatewayMessage force-stops on the fifth repeated autonomous turn', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Still working the same plan.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const request = {
    sessionId: 'session-loop-force-stop',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    content: 'Continue.',
    model: 'test-model',
    chatbotId: 'bot-1',
    source: 'fullauto' as const,
  };

  for (let turn = 0; turn < 4; turn += 1) {
    await handleGatewayMessage({ ...request });
  }
  const fifth = await handleGatewayMessage({ ...request });

  expect(fifth.status).toBe('success');
  expect(fifth.result).toContain('[Loop guard]');
});

test('clarification responses bypass the turn loop escalator', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Can you clarify which repository you want me to inspect?',
    toolsUsed: [],
    toolExecutions: [],
  });

  const request = {
    sessionId: 'session-loop-clarification',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    content: 'Continue.',
    model: 'test-model',
    chatbotId: 'bot-1',
    source: 'fullauto' as const,
  };

  for (let turn = 0; turn < 5; turn += 1) {
    await handleGatewayMessage({ ...request });
  }
  const result = await handleGatewayMessage({ ...request });

  expect(result.status).toBe('success');
  expect(result.result).toBe(
    'Can you clarify which repository you want me to inspect?',
  );
  expect(result.result).not.toContain('[Loop warning]');
  expect(result.result).not.toContain('[Loop guard]');
});
