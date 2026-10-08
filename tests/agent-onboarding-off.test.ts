import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { callAuxiliaryModelMock } from './helpers/gateway-auxiliary-mock.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock, pluginManagerMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  pluginManagerMock: {
    collectPromptContextDetails: vi.fn(async () => ({
      sections: [],
      pluginIds: [],
      replacesBuiltInMemory: false,
    })),
    collectPromptContext: vi.fn(async () => []),
    getToolDefinitions: vi.fn(() => []),
    getMemoryLayerBehavior: vi.fn(async () => ({
      replacesBuiltInMemory: false,
    })),
    hasMiddleware: vi.fn(() => false),
    hasOutputGuards: vi.fn(() => false),
    notifyBeforeAgentStart: vi.fn(async () => {}),
    notifyAgentEnd: vi.fn(async () => {}),
    notifyMemoryWrites: vi.fn(async () => {}),
    notifySessionStart: vi.fn(async () => {}),
    notifyTurnComplete: vi.fn(async () => {}),
  },
}));
vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));
vi.mock('../src/providers/hybridai-bots.js', async () => ({
  ...(await vi.importActual('../src/providers/hybridai-bots.ts')),
  fetchHybridAIAccountChatbotId: vi.fn(async () => 'bot-test'),
}));
vi.mock('../src/plugins/plugin-manager.js', () => ({
  ensurePluginManagerInitialized: vi.fn(async () => pluginManagerMock),
  listLoadedPluginCommands: vi.fn(() => []),
  reloadPluginManager: vi.fn(async () => pluginManagerMock),
  setPluginInboundMessageDispatcher: vi.fn(),
  shutdownPluginManager: vi.fn(async () => {}),
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'agent-onboarding-off-',
  cleanup: () => {
    runAgentMock.mockReset();
    callAuxiliaryModelMock.mockClear();
  },
});

async function setup() {
  setupHome();
  const { handleAgentPackageCommand } = await import(
    '../src/cli/agent-command.ts'
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const workspace = await import('../src/workspace.ts');
  const registry = await import('../src/agents/agent-registry.ts');
  return {
    handleAgentPackageCommand,
    hy: () => agentWorkspaceDir('hy'),
    ...workspace,
    ...registry,
  };
}

function onboardingState(workspace: string) {
  return JSON.parse(
    fs.readFileSync(
      path.join(workspace, '.hybridclaw', 'workspace-state.json'),
      'utf8',
    ),
  ) as { bootstrapSeededAt?: string; onboardingCompletedAt?: string };
}

test('a new agent with onboarding false never gets BOOTSTRAP.md, even after a workspace wipe', async () => {
  const ctx = await setup();
  await ctx.handleAgentPackageCommand([
    'config',
    JSON.stringify({ id: 'hy', onboarding: false }),
    '--activate',
  ]);
  expect(ctx.getAgentById('hy')?.onboarding).toBe(false);
  expect(fs.existsSync(path.join(ctx.hy(), 'BOOTSTRAP.md'))).toBe(false);
  expect(fs.existsSync(path.join(ctx.hy(), 'SOUL.md'))).toBe(true);
  expect(onboardingState(ctx.hy())).toMatchObject({
    bootstrapSeededAt: expect.any(String),
    onboardingCompletedAt: expect.any(String),
  });
  expect(ctx.resolveStartupBootstrapFile('hy')).toBeNull();

  // `/reset` wipes the workspace; the next turn re-seeds it without hatching.
  ctx.resetWorkspace('hy');
  ctx.ensureBootstrapFiles('hy');
  expect(fs.existsSync(path.join(ctx.hy(), 'BOOTSTRAP.md'))).toBe(false);
  expect(ctx.isBootstrapping('hy')).toBe(false);

  // A markdown BOOTSTRAP.md in a later config does not restart it either.
  await ctx.handleAgentPackageCommand([
    'config',
    JSON.stringify({ id: 'hy', markdown: { 'BOOTSTRAP.md': '# hatch\n' } }),
  ]);
  expect(fs.existsSync(path.join(ctx.hy(), 'BOOTSTRAP.md'))).toBe(false);
  expect(ctx.getAgentById('hy')?.onboarding).toBe(false);

  // Other agents still hatch.
  await ctx.handleAgentPackageCommand(['config', JSON.stringify({ id: 'writer' })]);
  expect(ctx.isBootstrapping('writer')).toBe(true);
});

test('turning onboarding off removes an existing BOOTSTRAP.md and autostart claims', async () => {
  const ctx = await setup();
  await ctx.handleAgentPackageCommand(['config', JSON.stringify({ id: 'hy' })]);
  expect(ctx.isBootstrapping('hy')).toBe(true);
  const db = await import('../src/memory/db.ts');
  db.setMemoryValue(
    'gateway.bootstrap_autostart.workspace.v1',
    'gateway.bootstrap_autostart.v1.hy.BOOTSTRAP.md.abc',
    { status: 'started' },
  );
  await ctx.handleAgentPackageCommand([
    'config',
    JSON.stringify({ id: 'hy', onboarding: false }),
  ]);
  expect(fs.existsSync(path.join(ctx.hy(), 'BOOTSTRAP.md'))).toBe(false);
  expect(ctx.isBootstrapping('hy')).toBe(false);
  expect(
    db.listMemoryValues('gateway.bootstrap_autostart.workspace.v1'),
  ).toEqual([]);
});

test('reset from defaults with onboarding false comes back without onboarding', async () => {
  const ctx = await setup();
  await ctx.handleAgentPackageCommand(['config', JSON.stringify({ id: 'hy' })]);
  await ctx.handleAgentPackageCommand([
    'defaults',
    JSON.stringify({ id: 'hy', displayName: 'Hy', onboarding: false }),
  ]);
  const { resetAgent } = await import('../src/agents/agent-reset.ts');
  await resetAgent('hy');
  expect(ctx.getAgentById('hy')?.onboarding).toBe(false);
  expect(fs.existsSync(path.join(ctx.hy(), 'BOOTSTRAP.md'))).toBe(false);
  expect(ctx.isBootstrapping('hy')).toBe(false);
});

test('history autostart and hatching completion skip an agent with onboarding off', async () => {
  const ctx = await setup();
  await ctx.handleAgentPackageCommand([
    'config',
    JSON.stringify({ id: 'hy', onboarding: false }),
    '--activate',
  ]);
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Hello.',
    toolsUsed: [],
    toolExecutions: [],
  });
  const { ensureGatewayBootstrapAutostart } = await import(
    '../src/gateway/gateway-service.ts'
  );
  await ensureGatewayBootstrapAutostart({
    sessionId: 'main-0123456789abcdef0123456789abcdef-hy',
    channelId: 'web',
    agentId: 'hy',
  });
  expect(runAgentMock).not.toHaveBeenCalled();

  const { recordBootstrapHatchingTurnResult } = await import(
    '../src/gateway/hatching-completion.ts'
  );
  expect(
    recordBootstrapHatchingTurnResult({
      agentId: 'hy',
      bootstrapFile: ctx.resolveStartupBootstrapFile('hy'),
      toolExecutions: [
        {
          name: 'message',
          arguments: JSON.stringify({
            action: 'send',
            to: 'user@example.com',
            subject: 'Welcome',
            content: 'hi',
          }),
          result: '{"ok":true}',
          durationMs: 1,
        },
      ],
      turnSucceeded: true,
    }),
  ).toBeNull();
});
