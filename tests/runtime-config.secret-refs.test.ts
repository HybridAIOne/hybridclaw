import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

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

  test('resolves stored secret refs for targeted config fields', async () => {
    const homeDir = makeTempHome();
    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.saveRuntimeSecrets({
      WEB_API_TOKEN: 'web-token-from-store',
      GATEWAY_API_TOKEN: 'gateway-token-from-store',
      EMAIL_PASSWORD: 'email-app-password',
      SALES_EMAIL_PASSWORD: 'sales-email-password',
      IMESSAGE_PASSWORD: 'bluebubbles-password',
      TWILIO_AUTH_TOKEN: 'twilio-auth-token',
      VLLM_API_KEY: 'vllm-token-from-store',
    });

    writeRawRuntimeConfig(homeDir, (config) => {
      const ops = config.ops as Record<string, unknown>;
      ops.webApiToken = { source: 'store', id: 'WEB_API_TOKEN' };
      ops.gatewayApiToken = { source: 'store', id: 'GATEWAY_API_TOKEN' };

      const imessage = config.imessage as Record<string, unknown>;
      imessage.enabled = true;
      imessage.backend = 'bluebubbles';
      imessage.serverUrl = 'https://bluebubbles.example.com';
      imessage.password = { source: 'store', id: 'IMESSAGE_PASSWORD' };

      const email = config.email as Record<string, unknown>;
      email.enabled = true;
      email.password = { source: 'store', id: 'EMAIL_PASSWORD' };
      email.accounts = [
        {
          agentId: 'sales',
          address: 'sales@example.com',
          imapHost: 'imap.example.com',
          imapPort: 993,
          imapSecure: true,
          smtpHost: 'smtp.example.com',
          smtpPort: 587,
          smtpSecure: false,
          password: { source: 'store', id: 'SALES_EMAIL_PASSWORD' },
          folders: ['INBOX'],
          allowFrom: ['lead@example.com'],
        },
      ];

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
      vllm.apiKey = { source: 'store', id: 'VLLM_API_KEY' };
    });

    const runtimeConfig = await importFreshRuntimeConfig(homeDir);
    const config = runtimeConfig.getRuntimeConfig();

    expect(config.ops.webApiToken).toBe('web-token-from-store');
    expect(config.ops.gatewayApiToken).toBe('gateway-token-from-store');
    expect(config.email.password).toBe('email-app-password');
    expect(config.email.accounts[0]?.password).toBe('sales-email-password');
    expect(config.imessage.password).toBe('bluebubbles-password');
    expect(config.voice.twilio.authToken).toBe('twilio-auth-token');
    expect(config.local.backends.vllm.apiKey).toBe('vllm-token-from-store');
  });

  test('preserves email account password refs during config writes', async () => {
    const homeDir = makeTempHome();
    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.saveRuntimeSecrets({
      SALES_EMAIL_PASSWORD: 'sales-email-password',
    });
    writeRawRuntimeConfig(homeDir, (config) => {
      const email = config.email as Record<string, unknown>;
      email.enabled = true;
      email.imapHost = 'imap.example.com';
      email.smtpHost = 'smtp.example.com';
      email.accounts = [
        {
          agentId: 'sales',
          address: 'sales@example.com',
          password: { source: 'store', id: 'SALES_EMAIL_PASSWORD' },
          folders: ['INBOX'],
          allowFrom: ['lead@example.com'],
        },
      ];
    });

    const runtimeConfig = await importFreshRuntimeConfig(homeDir);
    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.email.pollIntervalMs = 60_000;
    });

    const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      email?: { accounts?: Array<{ password?: unknown }> };
    };
    expect(saved.email?.accounts?.[0]?.password).toEqual({
      source: 'store',
      id: 'SALES_EMAIL_PASSWORD',
    });
  });

  test('canonicalizes legacy browser cloud env refs to stored refs', async () => {
    const homeDir = makeTempHome();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeRawRuntimeConfig(homeDir, (config) => {
      const browser = config.browser as Record<string, unknown>;
      const browserUseCloud = browser.browserUseCloud as Record<
        string,
        unknown
      >;
      browserUseCloud.apiKeyRef = {
        source: 'env',
        id: 'BROWSER_USE_API_KEY',
      };
    });

    const runtimeConfig = await importFreshRuntimeConfig(homeDir);

    expect(
      runtimeConfig.getRuntimeConfig().browser.browserUseCloud.apiKeyRef,
    ).toEqual({
      source: 'store',
      id: 'BROWSER_USE_API_KEY',
    });
    expect(warn).toHaveBeenCalledWith(
      '[runtime-config] migrating browser.browserUseCloud.apiKeyRef legacy env SecretRef to stored SecretRef',
    );
  });

  test('rejects malformed legacy browser cloud env refs clearly', async () => {
    const homeDir = makeTempHome();
    writeRawRuntimeConfig(homeDir, (config) => {
      const browser = config.browser as Record<string, unknown>;
      const browserUseCloud = browser.browserUseCloud as Record<
        string,
        unknown
      >;
      browserUseCloud.apiKeyRef = {
        source: 'env',
        id: 42,
      };
    });

    const runtimeConfig = await importFreshRuntimeConfig(homeDir);

    expect(runtimeConfig.getRuntimeConfigLoadError()?.message).toBe(
      'browser.browserUseCloud.apiKeyRef legacy env ref id must be a string.',
    );
    expect(() => runtimeConfig.reloadRuntimeConfig('test')).toThrow(
      'browser.browserUseCloud.apiKeyRef legacy env ref id must be a string.',
    );
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

  test('preserves stored secret refs even when resolved values change', async () => {
    const homeDir = makeTempHome();
    const runtimeSecrets = await importFreshRuntimeSecrets(homeDir);
    runtimeSecrets.saveRuntimeSecrets({
      GATEWAY_API_TOKEN: 'gateway-token-before',
    });

    writeRawRuntimeConfig(homeDir, (config) => {
      const ops = config.ops as Record<string, unknown>;
      ops.gatewayApiToken = { source: 'store', id: 'GATEWAY_API_TOKEN' };
    });

    const runtimeConfig = await importFreshRuntimeConfig(homeDir);
    expect(runtimeConfig.getRuntimeConfig().ops.gatewayApiToken).toBe(
      'gateway-token-before',
    );

    runtimeSecrets.saveRuntimeSecrets({
      GATEWAY_API_TOKEN: 'gateway-token-after',
    });
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
      source: 'store',
      id: 'GATEWAY_API_TOKEN',
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

  test('throws on reload when email account password secret ref is unresolved', async () => {
    const homeDir = makeTempHome();
    writeRawRuntimeConfig(homeDir, (config) => {
      const email = config.email as Record<string, unknown>;
      email.enabled = true;
      email.imapHost = 'imap.example.com';
      email.smtpHost = 'smtp.example.com';
      email.accounts = [
        {
          agentId: 'sales',
          address: 'sales@example.com',
          password: { source: 'store', id: 'SALES_EMAIL_PASSWORD' },
          folders: ['INBOX'],
          allowFrom: ['lead@example.com'],
        },
      ];
    });

    const runtimeConfig = await importFreshRuntimeConfig(homeDir);

    expect(() => runtimeConfig.reloadRuntimeConfig('test')).toThrow(
      /email\.accounts\[0\]\.password references stored secret SALES_EMAIL_PASSWORD but it is not set/,
    );
  });
});
