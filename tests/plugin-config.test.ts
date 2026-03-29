import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';

async function importFreshPluginConfig(config: RuntimeConfig) {
  const saveRuntimeConfig = vi.fn();
  const discoverPlugins = vi.fn();
  const validatePluginConfig = vi.fn();

  class PluginManager {
    constructor(_options: unknown) {}

    discoverPlugins = discoverPlugins;
  }

  vi.doMock('../src/config/runtime-config.js', () => ({
    DEFAULT_RUNTIME_HOME_DIR: '/tmp/hybridclaw-home',
    getRuntimeConfig: () => config,
    runtimeConfigPath: () => '/tmp/config.json',
    saveRuntimeConfig,
  }));
  vi.doMock('../src/plugins/plugin-manager.js', () => ({
    PluginManager,
    validatePluginConfig,
  }));

  const pluginConfig = await import('../src/plugins/plugin-config.ts');
  return {
    ...pluginConfig,
    discoverPlugins,
    saveRuntimeConfig,
    validatePluginConfig,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/config/runtime-config.js');
  vi.doUnmock('../src/plugins/plugin-manager.js');
  vi.resetModules();
});

describe('setPluginEnabled', () => {
  test('returns early without discovery when enabling a plugin with no override entry', async () => {
    const config = {
      plugins: {
        list: [],
      },
    } as RuntimeConfig;
    const { discoverPlugins, saveRuntimeConfig, setPluginEnabled } =
      await importFreshPluginConfig(config);

    await expect(setPluginEnabled('demo-plugin', true)).resolves.toEqual({
      pluginId: 'demo-plugin',
      enabled: true,
      changed: false,
      configPath: '/tmp/config.json',
      entry: null,
    });
    expect(discoverPlugins).not.toHaveBeenCalled();
    expect(saveRuntimeConfig).not.toHaveBeenCalled();
  });

  test('disables an existing plugin override without discovery', async () => {
    const config = {
      plugins: {
        list: [
          {
            id: 'demo-plugin',
            enabled: true,
          },
        ],
      },
    } as RuntimeConfig;
    const { discoverPlugins, saveRuntimeConfig, setPluginEnabled } =
      await importFreshPluginConfig(config);

    await expect(setPluginEnabled('demo-plugin', false)).resolves.toEqual({
      pluginId: 'demo-plugin',
      enabled: false,
      changed: true,
      configPath: '/tmp/config.json',
      entry: {
        id: 'demo-plugin',
        enabled: false,
      },
    });
    expect(discoverPlugins).not.toHaveBeenCalled();
    expect(saveRuntimeConfig).toHaveBeenCalledWith({
      plugins: {
        list: [
          {
            id: 'demo-plugin',
            enabled: false,
          },
        ],
      },
    });
  });
});
