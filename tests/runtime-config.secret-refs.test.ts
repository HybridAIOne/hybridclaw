import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
const ORIGINAL_TEST_GATEWAY_TOKEN = process.env.TEST_GATEWAY_TOKEN;
const ORIGINAL_TEST_VLLM_API_KEY = process.env.TEST_VLLM_API_KEY;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-secret-refs-'));
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function writeRawRuntimeConfig(
  homeDir: string,
  mutator?: (config: Record<string, unknown>) => void,
): void {
  const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as Record<string, unknown>;
  const ops = config.ops as Record<string, unknown>;
  ops.dbPath = path.join(homeDir, '.hybridclaw', 'data', 'hybridclaw.db');
  delete (config.container as Record<string, unknown>).sandboxMode;
  mutator?.(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

async function importFreshRuntimeSecrets(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
  return import('../src/security/runtime-secrets.ts');
}

async function importFreshRuntimeConfig(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
  return import('../src/config/runtime-config.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar(
    'HYBRIDCLAW_DISABLE_CONFIG_WATCHER',
    ORIGINAL_DISABLE_CONFIG_WATCHER,
  );
  restoreEnvVar('TEST_GATEWAY_TOKEN', ORIGINAL_TEST_GATEWAY_TOKEN);
  restoreEnvVar('TEST_VLLM_API_KEY', ORIGINAL_TEST_VLLM_API_KEY);
});

describe('runtime config secret refs', () => {
  test('resolves store and env secret refs for targeted config fields', async () => {
    const homeDir = makeTempHome();
    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.saveRuntimeSecrets({
      WEB_API_TOKEN: 'web-token-from-store',
      IMESSAGE_PASSWORD: 'bluebubbles-password',
    });
    process.env.TEST_GATEWAY_TOKEN = 'gateway-token-from-env';
    process.env.TEST_VLLM_API_KEY = 'vllm-token-from-env';

    writeRawRuntimeConfig(homeDir, (config) => {
      const ops = config.ops as Record<string, unknown>;
      ops.webApiToken = { source: 'store', id: 'WEB_API_TOKEN' };
      ops.gatewayApiToken = '${TEST_GATEWAY_TOKEN}';

      const imessage = config.imessage as Record<string, unknown>;
      imessage.enabled = true;
      imessage.backend = 'bluebubbles';
      imessage.serverUrl = 'https://bluebubbles.example.com';
      imessage.password = { source: 'store', id: 'IMESSAGE_PASSWORD' };

      const local = config.local as Record<string, unknown>;
      const backends = local.backends as Record<string, unknown>;
      const vllm = backends.vllm as Record<string, unknown>;
      vllm.enabled = true;
      vllm.apiKey = { source: 'env', id: 'TEST_VLLM_API_KEY' };
    });

    const runtimeConfig = await importFreshRuntimeConfig(homeDir);
    const config = runtimeConfig.getRuntimeConfig();

    expect(config.ops.webApiToken).toBe('web-token-from-store');
    expect(config.ops.gatewayApiToken).toBe('gateway-token-from-env');
    expect(config.imessage.password).toBe('bluebubbles-password');
    expect(config.local.backends.vllm.apiKey).toBe('vllm-token-from-env');
  });

  test('preserves secret refs on unrelated config updates', async () => {
    const homeDir = makeTempHome();
    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.saveRuntimeSecrets({
      IMESSAGE_PASSWORD: 'bluebubbles-password',
    });

    writeRawRuntimeConfig(homeDir, (config) => {
      const imessage = config.imessage as Record<string, unknown>;
      imessage.enabled = true;
      imessage.backend = 'bluebubbles';
      imessage.serverUrl = 'https://bluebubbles.example.com';
      imessage.password = { source: 'store', id: 'IMESSAGE_PASSWORD' };
    });

    const runtimeConfig = await importFreshRuntimeConfig(homeDir);
    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.heartbeat.channel = 'ops-alerts';
    });

    const stored = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, '.hybridclaw', 'config.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    const imessage = stored.imessage as Record<string, unknown>;

    expect(imessage.password).toEqual({
      source: 'store',
      id: 'IMESSAGE_PASSWORD',
    });
  });

  test('preserves secret refs even when env-backed resolved values change', async () => {
    const homeDir = makeTempHome();
    process.env.TEST_GATEWAY_TOKEN = 'gateway-token-before';

    writeRawRuntimeConfig(homeDir, (config) => {
      const ops = config.ops as Record<string, unknown>;
      ops.gatewayApiToken = { source: 'env', id: 'TEST_GATEWAY_TOKEN' };
    });

    const runtimeConfig = await importFreshRuntimeConfig(homeDir);
    expect(runtimeConfig.getRuntimeConfig().ops.gatewayApiToken).toBe(
      'gateway-token-before',
    );

    process.env.TEST_GATEWAY_TOKEN = 'gateway-token-after';
    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.heartbeat.channel = 'ops-alerts';
    });

    const stored = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, '.hybridclaw', 'config.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    const ops = stored.ops as Record<string, unknown>;

    expect(ops.gatewayApiToken).toEqual({
      source: 'env',
      id: 'TEST_GATEWAY_TOKEN',
    });
  });

  test('throws on reload when an active secret ref is unresolved', async () => {
    const homeDir = makeTempHome();
    writeRawRuntimeConfig(homeDir, (config) => {
      const imessage = config.imessage as Record<string, unknown>;
      imessage.enabled = true;
      imessage.backend = 'bluebubbles';
      imessage.serverUrl = 'https://bluebubbles.example.com';
      imessage.password = { source: 'store', id: 'IMESSAGE_PASSWORD' };
    });

    const runtimeConfig = await importFreshRuntimeConfig(homeDir);

    expect(() => runtimeConfig.reloadRuntimeConfig('test')).toThrow(
      /imessage\.password references stored secret IMESSAGE_PASSWORD but it is not set/,
    );
  });
});
