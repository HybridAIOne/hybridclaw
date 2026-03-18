import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock, ensurePluginManagerInitializedMock, pluginManagerMock } =
  vi.hoisted(() => {
    const pluginManager = {
      collectPromptContext: vi.fn(async () => ['plugin-memory-context']),
      getToolDefinitions: vi.fn(() => [
        {
          name: 'memory_lookup',
          description: 'Query plugin memory',
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
      listPluginSummary: vi.fn(() => []),
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
    pluginManagerMock.listPluginSummary.mockClear();
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
    toolsUsed: ['memory_lookup'],
    toolExecutions: [
      {
        name: 'memory_lookup',
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
          name: 'memory_lookup',
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
      toolNames: ['memory_lookup'],
    }),
  );
});

test('handleGatewayCommand lists plugin summaries', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  pluginManagerMock.listPluginSummary.mockReturnValue([
    {
      id: 'demo-plugin',
      name: 'Demo Plugin',
      version: '1.0.0',
      source: 'project',
      enabled: true,
      tools: ['demo_echo'],
      hooks: ['demo-hook'],
    },
    {
      id: 'broken-plugin',
      source: 'home',
      enabled: true,
      error: 'register exploded',
      tools: [],
      hooks: [],
    },
  ]);

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-list',
    guildId: null,
    channelId: 'web',
    args: ['plugin', 'list'],
  });

  expect(pluginManagerMock.listPluginSummary).toHaveBeenCalled();
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugins');
  expect(result.text).toContain('demo-plugin v1.0.0 [project]');
  expect(result.text).toContain('tools: demo_echo');
  expect(result.text).toContain('broken-plugin [home]');
  expect(result.text).toContain('error: register exploded');
});
