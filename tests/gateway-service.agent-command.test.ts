import fs from 'node:fs';
import path from 'node:path';

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
  fetchHybridAIAccountChatbotIdMock: vi.fn(async () => 'user-bootstrap'),
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
  tempHomePrefix: 'hybridclaw-gateway-agent-command-',
  cleanup: () => {
    runAgentMock.mockReset();
    fetchHybridAIAccountChatbotIdMock.mockClear();
    ensurePluginManagerInitializedMock.mockClear();
    reloadPluginManagerMock.mockClear();
    setPluginInboundMessageDispatcherMock.mockClear();
  },
});

test('agent create seeds bootstrap workspace files and explains hatching trigger', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-agent-create',
    guildId: null,
    channelId: 'web',
    args: ['agent', 'create', 'bob'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }

  const workspacePath = agentWorkspaceDir('bob');
  expect(fs.existsSync(path.join(workspacePath, 'BOOTSTRAP.md'))).toBe(true);
  expect(fs.existsSync(path.join(workspacePath, 'USER.md'))).toBe(true);
  expect(result.title).toBe('Agent Created');
  expect(result.text).toContain(`Workspace: ${path.resolve(workspacePath)}`);
  expect(result.text).toContain(
    'Hatching: open or switch to a session with this agent.',
  );
  expect(result.text).toContain(
    'hatching starts automatically without waiting for a user message',
  );
});

test('agent switch starts active BOOTSTRAP hatching in a reused session', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Hi. I am hatching now.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { initDatabase, storeMessage } = await import('../src/memory/db.ts');
  const { handleGatewayCommand, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');

  initDatabase({ quiet: true });
  upsertRegisteredAgent({
    id: 'research',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
  });
  ensureBootstrapFiles('research');

  const sessionId = 'session-agent-switch-bootstrap';
  storeMessage(sessionId, 'user-1', 'user', 'user', 'previous turn', 'bob');

  const result = await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    args: ['agent', 'switch', 'research'],
  });

  expect(result.kind).toBe('plain');
  if (result.kind !== 'plain') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain('Hatching will start automatically');

  await vi.waitFor(() => {
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });
  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ role: string; content: string }>;
        agentId?: string;
      }
    | undefined;
  expect(request?.agentId).toBe('research');
  expect(request?.messages?.at(-1)).toEqual({
    role: 'user',
    content: expect.stringContaining(
      'A startup instruction file (BOOTSTRAP.md) exists',
    ),
  });
  expect(getGatewayHistory(sessionId, 10).history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        agent_id: 'research',
        content: 'Hi. I am hatching now.',
      }),
    ]),
  );
});

test('agent shorthand switches by display name', async () => {
  setupHome();

  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({
    id: 'research',
    displayName: 'Research Agent',
  });

  const switched = await handleGatewayCommand({
    sessionId: 'session-agent-shorthand',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    args: ['agent', '@Research', 'Agent'],
  });
  const current = await handleGatewayCommand({
    sessionId: 'session-agent-shorthand',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'user',
    args: ['agent', 'current'],
  });

  expect(switched.kind).toBe('plain');
  expect(switched.text).toContain('Session agent set to `research`');
  expect(current.kind).toBe('info');
  expect(current.text).toContain('Current agent: research');
});
