import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock, ensurePluginManagerInitializedMock, pluginManagerMock } =
  vi.hoisted(() => {
    const pluginManager = {
      collectPromptContext: vi.fn(async () => ['plugin-memory-context']),
      getToolDefinitions: vi.fn(() => [
        {
          name: 'honcho_query',
          description: 'Query Honcho memory',
          parameters: {
            type: 'object' as const,
            properties: {
              question: { type: 'string' },
            },
            required: ['question'],
          },
        },
      ]),
      notifyBeforeAgentStart: vi.fn(async () => {}),
      notifyTurnComplete: vi.fn(async () => {}),
      notifyAgentEnd: vi.fn(async () => {}),
      handleSessionReset: vi.fn(async () => {}),
      notifySessionStart: vi.fn(async () => {}),
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
  shutdownPluginManager: vi.fn(async () => {}),
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-plugins-',
  cleanup: () => {
    runAgentMock.mockReset();
    ensurePluginManagerInitializedMock.mockClear();
    pluginManagerMock.collectPromptContext.mockClear();
    pluginManagerMock.getToolDefinitions.mockClear();
    pluginManagerMock.notifyBeforeAgentStart.mockClear();
    pluginManagerMock.notifyTurnComplete.mockClear();
    pluginManagerMock.notifyAgentEnd.mockClear();
    pluginManagerMock.handleSessionReset.mockClear();
    pluginManagerMock.notifySessionStart.mockClear();
  },
});

test('handleGatewayMessage injects plugin prompt context and forwards plugin tools to the agent', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'plugin-aware reply',
    toolsUsed: ['honcho_query'],
    toolExecutions: [
      {
        name: 'honcho_query',
        arguments: '{"question":"what matters?"}',
        result: 'long-term summary',
        durationMs: 12,
      },
    ],
  });

  const result = await handleGatewayMessage({
    sessionId: 'session-plugin-test',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    content: 'What do you remember about me?',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(pluginManagerMock.collectPromptContext).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-plugin-test',
      userId: 'user-42',
      agentId: 'main',
    }),
  );
  expect(runAgentMock).toHaveBeenCalledWith(
    expect.objectContaining({
      pluginTools: [
        expect.objectContaining({
          name: 'honcho_query',
        }),
      ],
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('plugin-memory-context'),
        }),
      ]),
    }),
  );
  expect(pluginManagerMock.notifyBeforeAgentStart).toHaveBeenCalled();
  expect(pluginManagerMock.notifyTurnComplete).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-plugin-test',
      userId: 'user-42',
      agentId: 'main',
      messages: [
        expect.objectContaining({
          role: 'user',
          content: 'What do you remember about me?',
        }),
        expect.objectContaining({
          role: 'assistant',
          content: 'plugin-aware reply',
        }),
      ],
    }),
  );
  expect(pluginManagerMock.notifyAgentEnd).toHaveBeenCalledWith(
    expect.objectContaining({
      resultText: 'plugin-aware reply',
      toolNames: ['honcho_query'],
    }),
  );
});
