import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const {
  runAgentMock,
  fetchHybridAIAccountChatbotIdMock,
  ensurePluginManagerInitializedMock,
  reloadPluginManagerMock,
  setPluginInboundMessageDispatcherMock,
} = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  fetchHybridAIAccountChatbotIdMock: vi.fn(async () => 'bot-test'),
  ensurePluginManagerInitializedMock: vi.fn(async () => null),
  reloadPluginManagerMock: vi.fn(async () => null),
  setPluginInboundMessageDispatcherMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/providers/hybridai-bots.js', async () => {
  const actual = await vi.importActual('../src/providers/hybridai-bots.ts');
  return {
    ...actual,
    fetchHybridAIAccountChatbotId: fetchHybridAIAccountChatbotIdMock,
  };
});

vi.mock('../src/plugins/plugin-manager.js', () => ({
  ensurePluginManagerInitialized: ensurePluginManagerInitializedMock,
  reloadPluginManager: reloadPluginManagerMock,
  setPluginInboundMessageDispatcher: setPluginInboundMessageDispatcherMock,
  shutdownPluginManager: vi.fn(async () => {}),
  listLoadedPluginCommands: vi.fn(() => []),
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-agent-addressing-',
  cleanup: () => {
    runAgentMock.mockReset();
    fetchHybridAIAccountChatbotIdMock.mockClear();
    ensurePluginManagerInitializedMock.mockClear();
    reloadPluginManagerMock.mockClear();
    setPluginInboundMessageDispatcherMock.mockClear();
  },
});

test('routes addressed chat turns into the executor to field and sticks follow-ups', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'done',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({
    id: 'research',
    displayName: 'Research Agent',
  });

  const first = await handleGatewayMessage({
    sessionId: 'session-addressed-agent',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'User',
    content: '@Research-Agent summarize this',
  });
  const second = await handleGatewayMessage({
    sessionId: 'session-addressed-agent',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'User',
    content: 'continue',
  });

  expect(first.status).toBe('success');
  expect(first.addressEnvelope).toEqual({ to: 'research', from: 'main' });
  expect(second.status).toBe('success');
  expect(second.addressEnvelope).toEqual({ to: 'research', from: 'research' });
  expect(runAgentMock).toHaveBeenCalledTimes(2);
  expect(runAgentMock.mock.calls[0]?.[0]).toMatchObject({
    agentId: 'research',
    addressEnvelope: { to: 'research', from: 'main' },
  });
  expect(runAgentMock.mock.calls[1]?.[0]).toMatchObject({
    agentId: 'research',
    addressEnvelope: { to: 'research', from: 'research' },
  });
});

test('unknown addressed chat turns fail before executor dispatch', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayMessage({
    sessionId: 'session-unknown-agent',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'User',
    content: '@missing summarize this',
  });

  expect(result.status).toBe('error');
  expect(result.error).toContain('Unknown agent address');
  expect(runAgentMock).not.toHaveBeenCalled();
});

test('@team fans out with child to fields without making the last agent sticky', async () => {
  setupHome();

  runAgentMock.mockImplementation(async (request: { agentId?: string }) => ({
    status: 'success',
    result: `reply from ${request.agentId}`,
    toolsUsed: [],
    toolExecutions: [],
  }));

  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({ id: 'research' });
  upsertRegisteredAgent({ id: 'writer' });

  const fanout = await handleGatewayMessage({
    sessionId: 'session-team-agent',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'User',
    content: '@team status',
  });
  const followUp = await handleGatewayMessage({
    sessionId: 'session-team-agent',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'User',
    content: 'continue',
  });

  expect(fanout.status).toBe('success');
  expect(fanout.addressEnvelope).toEqual({
    to: ['research', 'writer'],
    from: 'main',
    fanoutAlias: 'team',
  });
  expect(fanout.result).toContain('@research: reply from research');
  expect(fanout.result).toContain('@writer: reply from writer');
  expect(followUp.status).toBe('success');
  expect(followUp.addressEnvelope).toBeUndefined();
  expect(runAgentMock).toHaveBeenCalledTimes(3);
  expect(runAgentMock.mock.calls[0]?.[0]).toMatchObject({
    agentId: 'research',
    addressEnvelope: { to: 'research', from: 'main', fanoutAlias: 'team' },
  });
  expect(runAgentMock.mock.calls[1]?.[0]).toMatchObject({
    agentId: 'writer',
    addressEnvelope: { to: 'writer', from: 'main', fanoutAlias: 'team' },
  });
  expect(runAgentMock.mock.calls[2]?.[0]).toMatchObject({
    agentId: 'main',
  });
});
