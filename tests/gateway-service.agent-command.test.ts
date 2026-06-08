import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const {
  ensurePluginManagerInitializedMock,
  reloadPluginManagerMock,
  setPluginInboundMessageDispatcherMock,
} = vi.hoisted(() => ({
  ensurePluginManagerInitializedMock: vi.fn(async () => null),
  reloadPluginManagerMock: vi.fn(async () => null),
  setPluginInboundMessageDispatcherMock: vi.fn(),
}));

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
  expect(result.text).toContain('Hatching: open a fresh chat/session');
  expect(result.text).toContain('Agent commands do not run hatching turns.');
});
