import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const {
  runAgentMock,
  ensurePluginManagerInitializedMock,
  reloadPluginManagerMock,
  setPluginInboundMessageDispatcherMock,
} = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  ensurePluginManagerInitializedMock: vi.fn(async () => null),
  reloadPluginManagerMock: vi.fn(async () => null),
  setPluginInboundMessageDispatcherMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

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
  const cachedResult = await getGatewayAgentList();

  expect(fetchMock).toHaveBeenCalledWith(
    agentCardUrl,
    expect.objectContaining({ method: 'GET' }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(result.remotePeers).toEqual([
    {
      peerId: 'inst-peer',
      instanceId: 'inst-peer',
      agentCardUrl,
      agents: [{ id: 'remote@team@inst-peer', name: 'Remote Research' }],
    },
  ]);
  expect(cachedResult.remotePeers).toEqual(result.remotePeers);
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

test('agent-scoped turns cannot address agents outside the scope', async () => {
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
  upsertRegisteredAgent({ id: 'research', displayName: 'Research Agent' });
  upsertRegisteredAgent({ id: 'support', displayName: 'Support Agent' });

  const base = {
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'User',
    agentId: 'support',
    allowedAgentIds: ['support'],
  };

  const forbidden = { statusCode: 403 };
  await expect(
    handleGatewayMessage({
      ...base,
      sessionId: 'session-scoped-addressed',
      content: '@Research-Agent summarize this',
    }),
  ).rejects.toMatchObject({
    ...forbidden,
    message: expect.stringContaining('`research` is not available'),
  });
  await expect(
    handleGatewayMessage({
      ...base,
      sessionId: 'session-scoped-fanout',
      content: '@team hello',
    }),
  ).rejects.toMatchObject(forbidden);
  await expect(
    handleGatewayMessage({
      ...base,
      sessionId: 'session-scoped-remote',
      content: '@remote@team@peer-instance hello',
    }),
  ).rejects.toMatchObject(forbidden);

  expect(runAgentMock).not.toHaveBeenCalled();

  const allowed = await handleGatewayMessage({
    ...base,
    sessionId: 'session-scoped-allowed',
    content: 'hello',
  });
  expect(allowed.status).toBe('success');
  expect(runAgentMock.mock.calls[0]?.[0]).toMatchObject({
    agentId: 'support',
  });
});

test('a personal agent is reached by its own chat only: no address, fanout, list or switch', async () => {
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
  const { resolveA2AAgentId } = await import('../src/a2a/identity.ts');
  const { initDatabase } = await import('../src/memory/db.ts');
  const { observeChannelUser, setChannelUserAgent } = await import(
    '../src/memory/channel-users.ts'
  );
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({ id: 'sales' });
  upsertRegisteredAgent({ id: 'sales-fast', extends: 'sales' });
  upsertRegisteredAgent({
    id: 'sales-erika',
    extends: 'sales',
    displayName: 'Sales · Erika',
  });

  const colleague = {
    guildId: null,
    channelId: 'web',
    userId: 'user-2',
    username: 'Colleague',
    sessionId: 'session-colleague',
  };
  // A child someone is assigned to is that person's; other children are not.
  const erika = {
    channelKind: 'msteams',
    tenantId: 'tenant-1',
    userId: 'user-1',
  } as const;
  observeChannelUser({ ...erika, displayName: 'Erika', isMessage: true });
  setChannelUserAgent(erika, 'sales-erika');

  for (const content of [
    '@sales-erika what do you remember?',
    '@Sales-Erika what do you remember?',
    `@${resolveA2AAgentId('sales-erika')} what do you remember?`,
  ]) {
    const addressed = await handleGatewayMessage({ ...colleague, content });
    expect(addressed).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Unknown agent address'),
    });
  }
  expect(runAgentMock).not.toHaveBeenCalled();

  const fanout = await handleGatewayMessage({
    ...colleague,
    content: '@all status',
  });
  expect(fanout.addressEnvelope).toMatchObject({
    to: ['main', 'sales', 'sales-fast'],
  });

  const command = (sessionId: string, ...args: string[]) =>
    handleGatewayCommand({ ...colleague, sessionId, args });
  const listed = (await command('session-colleague', 'agent', 'list')).text;
  expect(listed).toContain('sales-fast');
  expect(listed).not.toContain('sales-erika');
  for (const args of [
    ['agent', 'switch', 'sales-erika'],
    ['agent', '@sales-erika'],
  ]) {
    const refused = await command('session-colleague', ...args);
    expect(refused.kind).toBe('error');
    expect(refused.text).not.toContain('Session agent set');
  }
  expect(
    (await command('session-colleague', 'agent', 'current')).text,
  ).toContain('Current agent: main');

  // The person's own chat is routed to the agent and may name it.
  const own = {
    ...colleague,
    channelId: 'msteams',
    userId: 'user-1',
    sessionId: 'session-erika',
    agentId: 'sales-erika',
  };
  expect(
    (await handleGatewayMessage({ ...own, content: 'hello' })).result,
  ).toBe('reply from sales-erika');
  expect(
    (await handleGatewayMessage({ ...own, content: '@sales-erika again' }))
      .result,
  ).toBe('reply from sales-erika');
  expect((await command('session-erika', 'agent', 'list')).text).toContain(
    'sales-erika (current)',
  );
});
