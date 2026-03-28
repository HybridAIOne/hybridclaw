import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock, ensurePluginManagerInitializedMock, pluginManagerMock } =
  vi.hoisted(() => {
    const pluginManager = {
      getToolDefinitions: vi.fn(() => []),
      notifyBeforeAgentStart: vi.fn(async () => {}),
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

const { fetchHybridAIAccountChatbotIdMock } = vi.hoisted(() => ({
  fetchHybridAIAccountChatbotIdMock: vi.fn(async () => 'user-bootstrap'),
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
  listLoadedPluginCommands: vi.fn(() => []),
  reloadPluginManager: vi.fn(async () => pluginManagerMock),
  shutdownPluginManager: vi.fn(async () => {}),
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-bootstrap-autostart-',
  cleanup: () => {
    runAgentMock.mockReset();
    fetchHybridAIAccountChatbotIdMock.mockClear();
    ensurePluginManagerInitializedMock.mockClear();
    pluginManagerMock.getToolDefinitions.mockClear();
    pluginManagerMock.notifyBeforeAgentStart.mockClear();
    pluginManagerMock.notifySessionStart.mockClear();
  },
});

test('ensureGatewayBootstrapAutostart stores only the assistant bootstrap opener once per session', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Hello. I am ready to get you oriented.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');

  initDatabase({ quiet: true });

  const sessionId = 'agent:main:channel:web:chat:dm:peer:bootstrap-test';
  await ensureGatewayBootstrapAutostart({ sessionId });

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ role: string; content: string }>;
        channelId?: string;
      }
    | undefined;
  expect(request?.channelId).toBe('web');
  expect(request?.chatbotId).toBe('user-bootstrap');
  expect(request?.messages?.some((message) => message.role === 'system')).toBe(
    true,
  );
  expect(
    request?.messages?.some((message) =>
      message.content.includes('## BOOTSTRAP.md'),
    ),
  ).toBe(true);
  expect(request?.messages?.at(-1)).toEqual({
    role: 'user',
    content: expect.stringContaining(
      'A startup instruction file (BOOTSTRAP.md) exists',
    ),
  });

  const history = getGatewayHistory(sessionId, 10).history;
  expect(history).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: 'Hello. I am ready to get you oriented.',
    }),
  ]);

  const storedSession = memoryService.getSessionById(sessionId);
  expect(storedSession?.message_count).toBe(1);
  expect(pluginManagerMock.notifySessionStart).toHaveBeenCalledTimes(1);
  expect(pluginManagerMock.notifyBeforeAgentStart).toHaveBeenCalledTimes(1);

  await ensureGatewayBootstrapAutostart({ sessionId });
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(getGatewayHistory(sessionId, 10).history).toHaveLength(1);
});

test('ensureGatewayBootstrapAutostart also kicks off from OPENING.md once per session', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Opening instructions noted. Ready to begin.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');

  initDatabase({ quiet: true });
  ensureBootstrapFiles('main');

  const workspaceDir = agentWorkspaceDir('main');
  fs.unlinkSync(path.join(workspaceDir, 'BOOTSTRAP.md'));
  fs.writeFileSync(
    path.join(workspaceDir, 'OPENING.md'),
    '# OPENING.md\n\nStart proactively with a short greeting.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(workspaceDir, '.hybridclaw', 'workspace-state.json'),
    `${JSON.stringify(
      {
        version: 1,
        bootstrapSeededAt: '2026-03-28T18:00:00.000Z',
        onboardingCompletedAt: '2026-03-28T18:00:01.000Z',
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  const sessionId = 'agent:main:channel:web:chat:dm:peer:boot-md-test';
  await ensureGatewayBootstrapAutostart({ sessionId });

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ role: string; content: string }>;
        chatbotId?: string;
      }
    | undefined;
  expect(request?.chatbotId).toBe('user-bootstrap');
  expect(
    request?.messages?.some((message) =>
      message.content.includes('## OPENING.md'),
    ),
  ).toBe(true);
  expect(request?.messages?.at(-1)).toEqual({
    role: 'user',
    content: expect.stringContaining(
      'A startup instruction file (OPENING.md) exists',
    ),
  });

  expect(getGatewayHistory(sessionId, 10).history).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: 'Opening instructions noted. Ready to begin.',
    }),
  ]);

  await ensureGatewayBootstrapAutostart({ sessionId });
  expect(runAgentMock).toHaveBeenCalledTimes(1);
});

test('ensureGatewayBootstrapAutostart ignores BOOT.md even when it is customized', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'This should never be used.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { ensureBootstrapFiles } = await import('../src/workspace.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');

  initDatabase({ quiet: true });
  ensureBootstrapFiles('main');

  const workspaceDir = agentWorkspaceDir('main');
  fs.unlinkSync(path.join(workspaceDir, 'BOOTSTRAP.md'));
  fs.writeFileSync(
    path.join(workspaceDir, 'BOOT.md'),
    '# BOOT.md\n\nThese instructions should stay passive.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(workspaceDir, '.hybridclaw', 'workspace-state.json'),
    `${JSON.stringify(
      {
        version: 1,
        bootstrapSeededAt: '2026-03-28T18:00:00.000Z',
        onboardingCompletedAt: '2026-03-28T18:00:01.000Z',
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  const sessionId = 'agent:main:channel:web:chat:dm:peer:default-boot-md-test';
  await ensureGatewayBootstrapAutostart({ sessionId });

  expect(runAgentMock).not.toHaveBeenCalled();
  expect(getGatewayHistory(sessionId, 10).history).toEqual([]);
});

test('ensureGatewayBootstrapAutostart prevents duplicate concurrent runs for the same fresh session', async () => {
  setupHome();

  let resolveRun: ((value: {
    status: 'success';
    result: string;
    toolsUsed: never[];
    toolExecutions: never[];
  }) => void) | null = null;
  const runAgentPromise = new Promise<{
    status: 'success';
    result: string;
    toolsUsed: never[];
    toolExecutions: never[];
  }>((resolve) => {
    resolveRun = resolve;
  });
  runAgentMock.mockImplementation(() => runAgentPromise);

  const { initDatabase } = await import('../src/memory/db.ts');
  const { ensureGatewayBootstrapAutostart, getGatewayHistory } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const sessionId = 'agent:main:channel:web:chat:dm:peer:bootstrap-race-test';
  const firstRun = ensureGatewayBootstrapAutostart({ sessionId });
  const secondRun = ensureGatewayBootstrapAutostart({ sessionId });
  await vi.waitFor(() => {
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  resolveRun?.({
    status: 'success',
    result: 'Hello once.',
    toolsUsed: [],
    toolExecutions: [],
  });
  await Promise.all([firstRun, secondRun]);

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(getGatewayHistory(sessionId, 10).history).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: 'Hello once.',
    }),
  ]);
});
