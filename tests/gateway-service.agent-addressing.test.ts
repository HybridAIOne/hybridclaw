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

test('leading canonical remote addresses queue A2A chat without local executor dispatch', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { listA2AOutboxItems } = await import('../src/a2a/a2a-outbound.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayMessage({
    sessionId: 'session-remote-canonical-agent',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'User',
    content: '@remote@team@peer-instance hello from chat',
  });

  expect(result.status).toBe('success');
  expect(result.result).toContain(
    'Queued for delivery to `remote@team@peer-instance`.',
  );
  expect(result.addressEnvelope).toEqual({
    to: 'remote@team@peer-instance',
    from: 'main',
  });
  expect(runAgentMock).not.toHaveBeenCalled();

  expect(listA2AOutboxItems()).toMatchObject([
    {
      envelope: {
        sender_agent_id: expect.stringMatching(/^main@local@inst-/),
        sender_instance_id: expect.stringMatching(/^inst-/),
        recipient_agent_id: 'remote@team@peer-instance',
        thread_id: 'session-remote-canonical-agent',
        intent: 'chat',
        content: 'hello from chat',
      },
      identityResolution: {
        status: 'unresolved',
        canonicalId: 'remote@team@peer-instance',
      },
    },
  ]);
});

test('agent list includes agents from trusted peer Agent Cards', async () => {
  setupHome();

  const agentCardUrl = 'https://peer.example.com/.well-known/agent.json';
  const fetchMock = vi.fn(async () => {
    return new Response(
      JSON.stringify({
        url: 'https://peer.example.com/a2a',
        hybridclaw: { instanceId: 'inst-peer' },
        agents: [
          { id: 'remote@team@inst-peer', name: 'Remote Research' },
          { id: 'other@team@inst-other', name: 'Wrong Instance' },
          { id: 'not canonical', name: 'Invalid Agent' },
        ],
      }),
      {
        headers: { 'content-type': 'application/json' },
      },
    );
  });
  vi.stubGlobal('fetch', fetchMock);

  const { initDatabase } = await import('../src/memory/db.ts');
  const { upsertA2ATrustedPublicKeyPeer } = await import(
    '../src/a2a/trust-ledger.ts'
  );
  const { getGatewayAgentList } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  upsertA2ATrustedPublicKeyPeer({
    peerId: 'inst-peer',
    agentCardUrl,
    deliveryUrl: 'https://peer.example.com/a2a',
    publicKeyFingerprint: 'A'.repeat(43),
  });

  const result = await getGatewayAgentList();

  expect(fetchMock).toHaveBeenCalledWith(
    agentCardUrl,
    expect.objectContaining({ method: 'GET' }),
  );
  expect(result.remotePeers).toEqual([
    {
      peerId: 'inst-peer',
      instanceId: 'inst-peer',
      label: 'inst-peer',
      agentCardUrl,
      agents: [{ id: 'remote@team@inst-peer', name: 'Remote Research' }],
    },
  ]);
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

test('@team fanout continues past an agent whose run throws', async () => {
  setupHome();

  runAgentMock.mockImplementation(async (request: { agentId?: string }) => {
    if (request.agentId === 'research') {
      throw new Error('research runtime crashed');
    }
    return {
      status: 'success',
      result: `reply from ${request.agentId}`,
      toolsUsed: [],
      toolExecutions: [],
    };
  });

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
    sessionId: 'session-team-agent-failure',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'User',
    content: '@team status',
  });

  expect(fanout.status).toBe('success');
  expect(fanout.result).toMatch(/@research: .*(failed|crashed|error)/i);
  expect(fanout.result).toContain('@writer: reply from writer');
});
