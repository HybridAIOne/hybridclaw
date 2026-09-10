import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';

let home: string;
let configPath: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-local-config-'));
  configPath = path.join(home, 'config.json');
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', home);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  fs.rmSync(home, { recursive: true, force: true });
});

const endpoint = {
  name: 'mac-mlx',
  type: 'mlx' as const,
  enabled: true,
  baseUrl: 'http://127.0.0.1:8321/v1',
  apiKey: 'test-key',
  zone: 'local' as const,
};

function writeConfig(endpoints: unknown, model = 'mac-mlx/spark-x2.5-4b') {
  const config = JSON.parse(
    fs.readFileSync('config.example.json', 'utf8'),
  ) as RuntimeConfig;
  config.ops.dbPath = path.join(home, 'data', 'hybridclaw.db');
  config.local.endpoints = endpoints as RuntimeConfig['local']['endpoints'];
  config.hybridai.defaultModel = model;
  const text = `${JSON.stringify(config, null, 2)}\n`;
  fs.writeFileSync(configPath, text);
  return text;
}

describe('local model configuration integrity', () => {
  test.each([
    { endpoints: [{ ...endpoint, baseUrl: 'https://example.com/v1' }], message: 'MLX requires http://127.0.0.1' },
    { endpoints: [{ ...endpoint, baseUrl: 'http://test-key@example.com/v1' }], message: 'MLX requires http://127.0.0.1' },
    { endpoints: [{ ...endpoint, zone: 'cloud' }], message: 'MLX endpoint zone must be local' },
    { endpoints: {}, message: 'local.endpoints must be an array' },
    { endpoints: [null], message: 'local.endpoints[0] must be an object' },
    {
      endpoints: [{ ...endpoint, name: 'invalid/name' }],
      message: 'local.endpoints[0].name must be',
    },
    {
      endpoints: [{ ...endpoint, name: 'openai' }],
      message: 'local.endpoints[0].name must be',
    },
    {
      endpoints: [endpoint, endpoint],
      message: 'local.endpoints[1].name duplicates',
    },
    {
      endpoints: [{ ...endpoint, type: 'unsupported-backend' }],
      message: 'local.endpoints[0].type is not supported by this HybridClaw build',
    },
    {
      endpoints: [{ ...endpoint, type: 'unsupported-backend', enabled: false }],
      message: 'local.endpoints[0].type is not supported by this HybridClaw build',
    },
  ])(
    'preserves invalid endpoint config: $message',
    async ({ endpoints, message }) => {
      const before = writeConfig(endpoints);
      const config = await import('../src/config/runtime-config.js');

      expect(config.getRuntimeConfigLoadError()?.message).toContain(message);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
        'test-key',
      );
    },
  );

  test.each([
    {
      endpoints: [{ ...endpoint, enabled: false }],
      message: 'disabled local endpoint',
    },
  ])(
    'rejects a default with $message before startup',
    async ({ endpoints, message }) => {
      const before = writeConfig(endpoints);
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const config = await import('../src/config/runtime-config.js');
      expect(config.getRuntimeConfigLoadError()?.message).toContain(message);
      const { ensureRuntimeCredentials } = await import('../src/onboarding.js');

      await expect(
        ensureRuntimeCredentials({
          commandName: 'hybridclaw gateway start',
          requireCredentials: false,
        }),
      ).rejects.toThrow(/hybridai.defaultModel.*mac-mlx/);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test('accepts a configured MLX model even when the service is stopped', async () => {
    writeConfig([endpoint]);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const config = await import('../src/config/runtime-config.js');

    expect(config.getRuntimeConfigLoadError()).toBeNull();
    expect(config.getRuntimeConfig().hybridai.defaultModel).toBe(
      'mac-mlx/spark-x2.5-4b',
    );
    expect(config.getRuntimeConfig().local.endpoints[0]).toMatchObject(endpoint);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    'gpt-5-nano',
    'hybridai/vendor/model',
    'openai/gpt-5',
    'ollama/local-model',
  ])('preserves supported provider reference %s', async (model) => {
    writeConfig([], model);
    const config = await import('../src/config/runtime-config.js');
    expect(config.getRuntimeConfigLoadError()).toBeNull();
    expect(config.getRuntimeConfig().hybridai.defaultModel).toBe(model);
  });

  test('keeps a missing endpoint reference available for repair without inventing a provider', async () => {
    writeConfig([]);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const config = await import('../src/config/runtime-config.js');
    expect(config.getRuntimeConfigLoadError()).toBeNull();
    expect(config.getRuntimeConfig().hybridai.defaultModel).toBe('mac-mlx/spark-x2.5-4b');
    expect(config.getRuntimeConfig().local.endpoints).toEqual([]);
    const { resolveModelRuntimeCredentials, UnknownModelProviderError } = await import('../src/providers/factory.js');
    await expect(resolveModelRuntimeCredentials({ model: config.getRuntimeConfig().hybridai.defaultModel })).rejects.toThrow(UnknownModelProviderError);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('removing an endpoint preserves its default reference and fails inference without falling back', async () => {
    writeConfig([endpoint]);
    const config = await import('../src/config/runtime-config.js');
    const draft = config.getRuntimeConfig();
    draft.local.endpoints = [];
    const saved = config.saveRuntimeConfig(draft);
    expect(saved.local.endpoints).toEqual([]);
    expect(saved.hybridai.defaultModel).toBe('mac-mlx/spark-x2.5-4b');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).hybridai.defaultModel).toBe(saved.hybridai.defaultModel);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { resolveModelRuntimeCredentials, UnknownModelProviderError } = await import('../src/providers/factory.js');
    await expect(resolveModelRuntimeCredentials({ model: saved.hybridai.defaultModel })).rejects.toThrow(UnknownModelProviderError);
    expect(fetch).not.toHaveBeenCalled();
    draft.hybridai.defaultModel = 'hybridai/gpt-5-nano';
    expect(config.saveRuntimeConfig(draft).hybridai.defaultModel).toBe('hybridai/gpt-5-nano');
  });

  test('keeps invalid disk config intact during refresh-based updates and recovers after correction', async () => {
    writeConfig([endpoint]);
    const config = await import('../src/config/runtime-config.js');
    const active = config.getRuntimeConfig();
    const before = writeConfig([{ ...endpoint, type: 'unsupported-backend' }]);
    const mutate = vi.fn();
    const updates = [
      () => config.updateRuntimeConfig(mutate),
      () => config.migrateLegacySchedulerJobsFromRuntimeConfig(),
      () => config.setRuntimeConfigSecretInput('ops.webApiToken', ''),
      () => config.setRuntimeConfigLocalEndpointSecretInput('mac-mlx', ''),
      () => config.setRuntimeConfigSlackWebhookSecretInput('example', ''),
      () => config.setRuntimeConfigDiscordWebhookSecretInput('example', ''),
    ];

    expect(() => config.reloadRuntimeConfig()).toThrow('type is not supported');
    for (const update of updates) {
      expect(update).toThrow('type is not supported');
      expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    }
    expect(mutate).not.toHaveBeenCalled();
    expect(config.getRuntimeConfig()).toEqual(active);

    writeConfig([endpoint]);
    config.reloadRuntimeConfig();
    expect(config.getRuntimeConfigLoadError()).toBeNull();
    expect(config.getRuntimeConfig().local.endpoints[0]).toMatchObject(endpoint);
  });
});

// Full replacement and snapshot recovery deliberately do not reload invalid
// disk state; incremental updates remain forbidden until the repair validates.
test.each(['replacement', 'last-known-good'])('repairs invalid local settings through %s without editing the file', async (mode) => {
  writeConfig([endpoint]);
  const config = await import('../src/config/runtime-config.js');
  const good = config.getRuntimeConfig();
  const invalid = writeConfig([{ ...endpoint, type: 'unsupported-backend' }]);
  expect(() => config.reloadRuntimeConfig()).toThrow();
  expect(() => config.updateRuntimeConfig((draft) => { draft.ops.logLevel = 'debug'; })).toThrow();
  expect(fs.readFileSync(configPath, 'utf8')).toBe(invalid);
  const repaired = mode === 'replacement' ? config.saveRuntimeConfig(good) : config.restoreLastKnownGoodRuntimeConfig();
  expect(repaired.local.endpoints[0]).toMatchObject(endpoint);
  expect(config.getRuntimeConfigLoadError()).toBeNull();
  expect(config.updateRuntimeConfig((draft) => { draft.ops.logLevel = 'debug'; }).ops.logLevel).toBe('debug');
});

test.each([
  { ...endpoint, baseUrl: 'https://example.com/v1' },
  { ...endpoint, zone: 'cloud' },
])('blocks every partial update for invalid MLX transport without overwriting disk', async (invalidEndpoint) => {
  writeConfig([endpoint]);
  const config = await import('../src/config/runtime-config.js');
  const before = writeConfig([invalidEndpoint]);
  const updates = [
    () => config.updateRuntimeConfig(() => {}),
    () => config.migrateLegacySchedulerJobsFromRuntimeConfig(),
    () => config.setRuntimeConfigSecretInput('ops.webApiToken', ''),
    () => config.setRuntimeConfigLocalEndpointSecretInput('mac-mlx', ''),
    () => config.setRuntimeConfigSlackWebhookSecretInput('example', ''),
    () => config.setRuntimeConfigDiscordWebhookSecretInput('example', ''),
  ];
  for (const update of updates) {
    expect(update).toThrow();
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  }
});
