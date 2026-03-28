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

test('ensureGatewayBootstrapAutostart also kicks off from BOOT.md once per session', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Boot instructions noted. Ready to begin.',
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
    '# BOOT.md\n\nStart proactively with a short greeting.\n',
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
    | { messages?: Array<{ role: string; content: string }> }
    | undefined;
  expect(
    request?.messages?.some((message) =>
      message.content.includes('## BOOT.md'),
    ),
  ).toBe(true);
  expect(request?.messages?.at(-1)).toEqual({
    role: 'user',
    content: expect.stringContaining(
      'A startup instruction file (BOOT.md) exists',
    ),
  });

  expect(getGatewayHistory(sessionId, 10).history).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: 'Boot instructions noted. Ready to begin.',
    }),
  ]);

  await ensureGatewayBootstrapAutostart({ sessionId });
  expect(runAgentMock).toHaveBeenCalledTimes(1);
});
