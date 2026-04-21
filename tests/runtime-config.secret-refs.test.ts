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
  test('loads memory recall settings from config.json', async () => {
    const homeDir = makeTempHome();
    writeRawRuntimeConfig(homeDir, (config) => {
      const memory = config.memory as Record<string, unknown>;
      memory.semanticPromptHardCap = 27;
      memory.embedding = {
        provider: 'transformers',
        model: 'onnx-community/embeddinggemma-300m-ONNX',
        revision: '75a84c732f1884df76bec365346230e32f582c82',
        dtype: 'q4',
      };
      memory.queryMode = 'no-stopwords';
      memory.backend = 'full-text';
      memory.rerank = 'bm25';
      memory.tokenizer = 'porter';
    });

    const runtimeConfig = await importFreshRuntimeConfig(homeDir);

    expect(runtimeConfig.getRuntimeConfig().memory.semanticPromptHardCap).toBe(
      27,
    );
    expect(runtimeConfig.getRuntimeConfig().memory.embedding.provider).toBe(
      'transformers',
    );
    expect(runtimeConfig.getRuntimeConfig().memory.embedding.model).toBe(
      'onnx-community/embeddinggemma-300m-ONNX',
    );
    expect(runtimeConfig.getRuntimeConfig().memory.embedding.revision).toBe(
      '75a84c732f1884df76bec365346230e32f582c82',
    );
    expect(runtimeConfig.getRuntimeConfig().memory.embedding.dtype).toBe('q4');
    expect(runtimeConfig.getRuntimeConfig().memory.queryMode).toBe(
      'no-stopwords',
    );
    expect(runtimeConfig.getRuntimeConfig().memory.backend).toBe('full-text');
    expect(runtimeConfig.getRuntimeConfig().memory.rerank).toBe('bm25');
    expect(runtimeConfig.getRuntimeConfig().memory.tokenizer).toBe('porter');
  });

  test('resolves store and env secret refs for targeted config fields', async () => {
    const homeDir = makeTempHome();
    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.saveRuntimeSecrets({
      WEB_API_TOKEN: 'web-token-from-store',
      EMAIL_PASSWORD: 'email-app-password',
      IMESSAGE_PASSWORD: 'bluebubbles-password',
      TWILIO_AUTH_TOKEN: 'twilio-auth-token',
    });
    process.env.TEST_GATEWAY_TOKEN = 'gateway-token-from-env';
    process.env.TEST_VLLM_API_KEY = 'vllm-token-from-env';

    writeRawRuntimeConfig(homeDir, (config) => {
      const ops = config.ops as Record<string, unknown>;
      ops.webApiToken = { source: 'store', id: 'WEB_API_TOKEN' };
      ops.gatewayApiToken = '$' + '{TEST_GATEWAY_TOKEN}';

      const imessage = config.imessage as Record<string, unknown>;
      imessage.enabled = true;
      imessage.backend = 'bluebubbles';
      imessage.serverUrl = 'https://bluebubbles.example.com';
      imessage.password = { source: 'store', id: 'IMESSAGE_PASSWORD' };

      const email = config.email as Record<string, unknown>;
      email.enabled = true;
      email.password = { source: 'store', id: 'EMAIL_PASSWORD' };

      const voice = config.voice as Record<string, unknown>;
      voice.enabled = true;
      const twilio = voice.twilio as Record<string, unknown>;
      twilio.accountSid = 'AC123';
      twilio.fromNumber = '+14155550123';
      twilio.authToken = { source: 'store', id: 'TWILIO_AUTH_TOKEN' };

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
    expect(config.email.password).toBe('email-app-password');
    expect(config.imessage.password).toBe('bluebubbles-password');
    expect(config.voice.twilio.authToken).toBe('twilio-auth-token');
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

  test('throws on reload when email password secret ref is unresolved', async () => {
    const homeDir = makeTempHome();
    writeRawRuntimeConfig(homeDir, (config) => {
      const email = config.email as Record<string, unknown>;
      email.enabled = true;
      email.password = { source: 'store', id: 'EMAIL_PASSWORD' };
    });

    const runtimeConfig = await importFreshRuntimeConfig(homeDir);

    expect(() => runtimeConfig.reloadRuntimeConfig('test')).toThrow(
      /email\.password references stored secret EMAIL_PASSWORD but it is not set/,
    );
  });
});
