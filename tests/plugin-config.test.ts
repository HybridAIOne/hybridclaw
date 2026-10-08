import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';

async function importFreshPluginConfig(config: RuntimeConfig) {
  const saveRuntimeConfig = vi.fn();
  const discoverPlugins = vi.fn();
  const resolveEffectivePluginConfigSchema = vi.fn();

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
    resolveEffectivePluginConfigSchema,
  }));

  const pluginConfig = await import('../src/plugins/plugin-config.ts');
  return {
    ...pluginConfig,
    discoverPlugins,
    resolveEffectivePluginConfigSchema,
    saveRuntimeConfig,
  };
}

const DEMO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    apiKey: { type: 'string' },
    auth: {
      type: 'object',
      additionalProperties: false,
      properties: { token: { type: 'string' } },
    },
    targets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string' } },
      },
    },
    sessions: { type: 'object', additionalProperties: { type: 'string' } },
  },
};

function demoPluginConfig(config: Record<string, unknown> = {}): RuntimeConfig {
  return {
    plugins: { list: [{ id: 'demo-plugin', enabled: true, config }] },
  } as RuntimeConfig;
}

async function importWithSchema(config: RuntimeConfig, schema: unknown) {
  const pluginConfig = await importFreshPluginConfig(config);
  // Discovery finds the installed plugin whether or not it has an override.
  pluginConfig.discoverPlugins.mockImplementation(
    async (candidateConfig: RuntimeConfig) => [
      {
        id: 'demo-plugin',
        config:
          candidateConfig.plugins.list.find(
            (entry) => entry.id === 'demo-plugin',
          )?.config ?? {},
      },
    ],
  );
  pluginConfig.resolveEffectivePluginConfigSchema.mockResolvedValue(schema);
  return pluginConfig;
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

describe('writePluginConfigValue', () => {
  test.each([
    [
      'extra',
      '1',
      'Plugin `demo-plugin` does not declare config key `extra`.',
    ],
    [
      'auth',
      '{"token":"t","extra":1}',
      'Plugin `demo-plugin` does not declare config key `auth.extra`.',
    ],
    [
      'targets',
      '[{"name":"a"},{"name":"b","extra":1}]',
      'Plugin `demo-plugin` does not declare config key `targets[1].extra`.',
    ],
    ['apiKey', '42', 'plugin config.apiKey must be string.'],
  ])('rejects %s=%s without saving', async (key, rawValue, message) => {
    const { saveRuntimeConfig, writePluginConfigValue } =
      await importWithSchema(demoPluginConfig(), DEMO_SCHEMA);

    await expect(
      writePluginConfigValue('demo-plugin', key, rawValue),
    ).rejects.toThrow(message);
    expect(saveRuntimeConfig).not.toHaveBeenCalled();
  });

  test.each([
    ['a declared key', DEMO_SCHEMA, 'auth', '{"token":"t"}'],
    ['a key in an open map', DEMO_SCHEMA, 'sessions', '{"any-id":"v"}'],
    ['any key without a schema', undefined, 'extra', '1'],
  ])('saves %s', async (_label, schema, key, rawValue) => {
    const { saveRuntimeConfig, writePluginConfigValue } =
      await importWithSchema(demoPluginConfig(), schema);

    await expect(
      writePluginConfigValue('demo-plugin', key, rawValue),
    ).resolves.toMatchObject({ key, changed: true });
    expect(saveRuntimeConfig).toHaveBeenCalledOnce();
  });

  test('an undeclared key saved earlier blocks neither writes nor its removal', async () => {
    const { saveRuntimeConfig, unsetPluginConfigValue, writePluginConfigValue } =
      await importWithSchema(demoPluginConfig({ stale: true }), DEMO_SCHEMA);

    await expect(
      writePluginConfigValue('demo-plugin', 'apiKey', 'k'),
    ).resolves.toMatchObject({
      entry: { config: { stale: true, apiKey: 'k' } },
    });
    await expect(
      unsetPluginConfigValue('demo-plugin', 'stale'),
    ).resolves.toMatchObject({ removed: true, changed: true });
    expect(saveRuntimeConfig).toHaveBeenCalledTimes(2);
  });
});

describe('bare plugin entries', () => {
  // Discovery finds the plugin only through its entry, as for a bundled
  // plugin enabled in place, or also from the runtime home.
  async function importWithDiscovery(
    config: RuntimeConfig,
    source: 'bundled' | 'home',
  ) {
    const pluginConfig = await importFreshPluginConfig(config);
    pluginConfig.discoverPlugins.mockImplementation(
      async (candidateConfig: RuntimeConfig) => {
        const entry = candidateConfig.plugins.list.find(
          (candidate) => candidate.id === 'demo-plugin',
        );
        if (source === 'bundled' && entry?.enabled !== true) return [];
        return [{ id: 'demo-plugin', config: entry?.config ?? {} }];
      },
    );
    pluginConfig.resolveEffectivePluginConfigSchema.mockResolvedValue(
      DEMO_SCHEMA,
    );
    return pluginConfig;
  }

  test.each([
    ['bundled', [{ id: 'demo-plugin', enabled: true, config: {} }]],
    ['home', []],
  ] as const)('re-enabling a %s plugin keeps its entry only when discovery needs it', async (source, expected) => {
    const config = {
      plugins: { list: [{ id: 'demo-plugin', enabled: false, config: {} }] },
    } as RuntimeConfig;
    const { saveRuntimeConfig, setPluginEnabled } = await importWithDiscovery(
      config,
      source,
    );

    await setPluginEnabled('demo-plugin', true);
    expect(saveRuntimeConfig.mock.calls[0]?.[0].plugins.list).toEqual(expected);
  });

  test('unsetting the last key of a bundled plugin keeps the entry that installs it', async () => {
    const { saveRuntimeConfig, unsetPluginConfigValue } =
      await importWithDiscovery(demoPluginConfig({ apiKey: 'k' }), 'bundled');

    await unsetPluginConfigValue('demo-plugin', 'apiKey');
    expect(saveRuntimeConfig.mock.calls[0]?.[0].plugins.list).toEqual([
      { id: 'demo-plugin', enabled: true, config: {} },
    ]);
  });
});
