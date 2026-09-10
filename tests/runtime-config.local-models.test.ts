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
    { endpoints: [], message: 'no matching local.endpoints entry' },
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

  test('rejects removing the selected endpoint without replacing the default', async () => {
    writeConfig([endpoint]);
    const config = await import('../src/config/runtime-config.js');
    const before = fs.readFileSync(configPath, 'utf8');
    const draft = config.getRuntimeConfig();
    draft.local.endpoints = [];

    expect(() => config.saveRuntimeConfig(draft)).toThrow(
      'no matching local.endpoints entry',
    );
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect(config.getRuntimeConfig().local.endpoints).toHaveLength(1);

    draft.hybridai.defaultModel = 'hybridai/gpt-5-nano';
    expect(config.saveRuntimeConfig(draft).local.endpoints).toEqual([]);
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
