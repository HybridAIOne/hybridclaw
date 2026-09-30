import { expect, test, vi } from 'vitest';

const { manager, reloadPluginManagerMock, saveRuntimeConfigMock } = vi.hoisted(
  () => {
    const manager = { listPluginSummary: vi.fn() };
    return {
      manager,
      reloadPluginManagerMock: vi.fn(async () => manager),
      saveRuntimeConfigMock: vi.fn(),
    };
  },
);

vi.mock('../src/plugins/plugin-manager.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensurePluginManagerInitialized: vi.fn(async () => manager),
  reloadPluginManager: reloadPluginManagerMock,
}));

vi.mock('../src/plugins/plugin-config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  writePluginConfigValue: vi.fn(async (pluginId: string, key: string) => ({
    pluginId,
    key,
    value: [],
    changed: true,
    removed: false,
    configPath: '/tmp/config.json',
  })),
}));

vi.mock('../src/config/runtime-config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  saveRuntimeConfig: saveRuntimeConfigMock,
}));

function summary(error?: string) {
  return [{ id: 'demo-plugin', enabled: true, ...(error ? { error } : {}) }];
}

test.each([
  {
    label: 'breaks a plugin that loaded before',
    before: undefined,
    after: 'unknown agent "ghost"',
    kind: 'error',
    rolledBack: true,
  },
  {
    label: 'leaves a plugin loading',
    before: undefined,
    after: undefined,
    kind: 'info',
    rolledBack: false,
  },
  {
    label: 'touches a plugin that was already failing',
    before: 'missing credential',
    after: 'missing credential',
    kind: 'info',
    rolledBack: false,
  },
])('a plugin config write that $label', async ({
  before,
  after,
  kind,
  rolledBack,
}) => {
  vi.clearAllMocks();
  manager.listPluginSummary.mockReturnValue(summary(after));
  const { handlePluginGatewayCommand } = await import(
    '../src/gateway/gateway-plugin-service.ts'
  );
  const result = await handlePluginGatewayCommand({
    req: {
      sessionId: 'session-plugin-config',
      guildId: null,
      channelId: 'web',
      args: ['plugin', 'config', 'demo-plugin', 'tools', '[]'],
    },
    pluginManager: {
      listPluginSummary: () => summary(before),
    } as never,
    pluginInitError: null,
  });

  expect(result.kind).toBe(kind);
  if (rolledBack) {
    expect(result.text).toContain(`Plugin failed to load with this config: ${after}`);
    expect(result.text).toContain('Previous runtime config was restored.');
    expect(saveRuntimeConfigMock).toHaveBeenCalledTimes(1);
  } else {
    expect(saveRuntimeConfigMock).not.toHaveBeenCalled();
  }
});
