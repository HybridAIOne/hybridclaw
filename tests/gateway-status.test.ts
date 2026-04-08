import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_HYBRIDAI_API_KEY = process.env.HYBRIDAI_API_KEY;
const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const ORIGINAL_HF_TOKEN = process.env.HF_TOKEN;
const ORIGINAL_MSTEAMS_APP_ID = process.env.MSTEAMS_APP_ID;
const ORIGINAL_MSTEAMS_APP_PASSWORD = process.env.MSTEAMS_APP_PASSWORD;
const ORIGINAL_MSTEAMS_TENANT_ID = process.env.MSTEAMS_TENANT_ID;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-gateway-status-'));
}

function writeRuntimeConfig(
  homeDir: string,
  mutator?: (config: RuntimeConfig) => void,
): void {
  const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
  config.ops.dbPath = path.join(
    homeDir,
    '.hybridclaw',
    'data',
    'hybridclaw.db',
  );
  mutator?.(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.sig`;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/logger.js');
  vi.doUnmock('../src/plugins/plugin-manager.js');
  vi.doUnmock('../src/providers/hybridai-discovery.js');
  vi.doUnmock('../src/providers/model-catalog.js');
  vi.doUnmock('../src/providers/local-discovery.js');
  vi.doUnmock('../src/providers/hybridai-health.js');
  vi.doUnmock('../src/providers/local-health.js');
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('HYBRIDAI_API_KEY', ORIGINAL_HYBRIDAI_API_KEY);
  restoreEnvVar('OPENROUTER_API_KEY', ORIGINAL_OPENROUTER_API_KEY);
  restoreEnvVar('MISTRAL_API_KEY', ORIGINAL_MISTRAL_API_KEY);
  restoreEnvVar('HF_TOKEN', ORIGINAL_HF_TOKEN);
  restoreEnvVar('MSTEAMS_APP_ID', ORIGINAL_MSTEAMS_APP_ID);
  restoreEnvVar('MSTEAMS_APP_PASSWORD', ORIGINAL_MSTEAMS_APP_PASSWORD);
  restoreEnvVar('MSTEAMS_TENANT_ID', ORIGINAL_MSTEAMS_TENANT_ID);
});

function mockHealthProbes(options?: {
  hybridaiReachable?: boolean;
  localBackends?: Array<{
    backend: 'ollama' | 'lmstudio' | 'vllm';
    reachable: boolean;
    latencyMs?: number;
    error?: string;
    modelCount?: number;
  }>;
}): void {
  const reachable = options?.hybridaiReachable ?? false;
  const localBackends = new Map(
    (options?.localBackends || []).map((entry) => [
      entry.backend,
      {
        backend: entry.backend,
        reachable: entry.reachable,
        latencyMs: entry.latencyMs ?? 10,
        ...(entry.error ? { error: entry.error } : {}),
        ...(typeof entry.modelCount === 'number'
          ? { modelCount: entry.modelCount }
          : {}),
      },
    ]),
  );
  vi.doMock('../src/providers/hybridai-health.js', () => ({
    hybridAIProbe: {
      get: vi.fn(async () => ({
        reachable,
        latencyMs: 10,
        modelCount: 3,
        ...(reachable ? {} : { error: 'mocked' }),
      })),
      peek: vi.fn(() => null),
      invalidate: vi.fn(),
    },
  }));
  vi.doMock('../src/providers/local-health.js', () => ({
    localBackendsProbe: {
      get: vi.fn(async () => new Map(localBackends)),
      peek: vi.fn(() => new Map(localBackends)),
      invalidate: vi.fn(),
    },
    checkConnection: vi.fn(),
    checkModelConnection: vi.fn(),
    checkAllBackends: vi.fn(async () => new Map()),
  }));
}

test('getGatewayStatus includes Codex auth state', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDAI_API_KEY = 'hai-test-gateway-status-1234567890';
  vi.resetModules();
  mockHealthProbes({ hybridaiReachable: true });

  const { saveCodexAuthStore, extractExpiresAtFromJwt } = await import(
    '../src/auth/codex-auth.ts'
  );
  const { initDatabase } = await import('../src/memory/db.ts');
  const accessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 600,
    chatgpt_account_id: 'acct_gateway',
  });

  saveCodexAuthStore(
    {
      version: 1,
      credentials: {
        accessToken,
        refreshToken: 'refresh_gateway',
        accountId: 'acct_gateway',
        expiresAt: extractExpiresAtFromJwt(accessToken),
        provider: 'openai-codex',
        authMethod: 'oauth',
        source: 'device-code',
        lastRefresh: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    },
    homeDir,
  );
  initDatabase({ quiet: true });

  const { getGatewayStatus } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const status = await getGatewayStatus();

  expect(status.codex).toMatchObject({
    authenticated: true,
    source: 'device-code',
    accountId: 'acct_gateway',
    reloginRequired: false,
  });
  expect(status.codex?.expiresAt).toBeGreaterThan(Date.now());
  expect(status.providerHealth?.codex).toMatchObject({
    kind: 'remote',
    reachable: true,
    modelCount: expect.any(Number),
  });
  expect(status.providerHealth?.hybridai).toMatchObject({
    kind: 'remote',
    reachable: true,
    modelCount: expect.any(Number),
  });
});

test('getGatewayStatus includes the configured default agent id', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();
  mockHealthProbes();
  writeRuntimeConfig(homeDir, (config) => {
    config.agents = {
      ...(config.agents ?? {}),
      defaultAgentId: 'charly',
      list: [{ id: 'main' }, { id: 'charly' }],
    };
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getGatewayStatus } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const status = await getGatewayStatus();

  expect(status.defaultAgentId).toBe('charly');
});

test('status command includes the current session agent', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({
    id: 'research',
    model: 'openai-codex/gpt-5.3-codex',
  });

  await handleGatewayCommand({
    sessionId: 'session-status-agent',
    guildId: null,
    channelId: 'channel-status-agent',
    args: ['agent', 'switch', 'research'],
  });
  const result = await handleGatewayCommand({
    sessionId: 'session-status-agent',
    guildId: null,
    channelId: 'channel-status-agent',
    args: ['status'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Status');
  expect(result.text).toContain('Agent: research');
  expect(result.text).toContain(
    `CWD: ${path.resolve(agentWorkspaceDir('research'))}`,
  );
});

test('status command includes active sandbox session ids when present', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();
  vi.doMock('../src/agent/executor.js', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('../src/agent/executor.js')>();
    return {
      ...actual,
      getActiveExecutorSessionIds: vi.fn(() => [
        'agent:main:channel:openai:chat:dm:peer:aaaabbbbccccdddd',
        'agent:main:channel:openai:chat:dm:peer:1111222233334444',
      ]),
      getSandboxDiagnostics: vi.fn(() => ({
        mode: 'host' as const,
        modeExplicit: true,
        runningInsideContainer: false,
        image: null,
        network: null,
        memory: null,
        memorySwap: null,
        cpus: null,
        securityFlags: ['workspace fencing'],
        mountAllowlistPath: '/tmp/mount-allowlist.json',
        additionalMountsConfigured: 0,
        activeSessions: 2,
        activeSessionIds: [
          'agent:main:channel:openai:chat:dm:peer:aaaabbbbccccdddd',
          'agent:main:channel:openai:chat:dm:peer:1111222233334444',
        ],
        warning: 'Running in host mode without container isolation.',
      })),
    };
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const result = await handleGatewayCommand({
    sessionId: 'session-status-sandbox',
    guildId: null,
    channelId: 'tui',
    args: ['status'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain('Sandbox sessions:');
  expect(result.text).toContain(
    'agent:main:channel:openai:chat:dm:peer:aaaabbbbccccdddd',
  );
});

test('sessions command includes abbreviated first and last message snippets', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { getOrCreateSession, initDatabase, storeMessage } = await import(
    '../src/memory/db.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const session = getOrCreateSession(
    'session-sessions-snippet',
    null,
    'web',
    'main',
  );
  storeMessage(
    session.id,
    'user_a',
    'user_a',
    'user',
    'First prompt that should appear as an abbreviated preview because it is intentionally long and wordy for testing.',
  );
  storeMessage(
    session.id,
    'assistant',
    'assistant',
    'assistant',
    'Final assistant reply that should also be shortened in the sessions listing because it is similarly verbose.',
  );

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: ['sessions'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Sessions');
  expect(result.text).toContain('session-sessions-snippet');
  expect(result.text).toContain('last: ');
  expect(result.text).not.toContain('last active ');
  expect(result.text).toContain('"First prompt that should appear as an..."');
  expect(result.text).toContain('"Final assistant reply that should als..."');
  expect(result.text).toContain('" ... "');
});

test('sessions active lists active sandbox sessions and clear-active stops them', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();
  const stopAllExecutionsMock = vi.fn();
  vi.doMock('../src/agent/executor.js', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('../src/agent/executor.js')>();
    return {
      ...actual,
      getActiveExecutorSessionIds: vi.fn(() => [
        'agent:main:channel:openai:chat:dm:peer:aaaabbbbccccdddd',
        'agent:main:channel:openai:chat:dm:peer:1111222233334444',
      ]),
      stopAllExecutions: stopAllExecutionsMock,
    };
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const activeResult = await handleGatewayCommand({
    sessionId: 'session-active-sandbox',
    guildId: null,
    channelId: 'tui',
    args: ['sessions', 'active'],
  });
  expect(activeResult.kind).toBe('info');
  if (activeResult.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${activeResult.kind}`);
  }
  expect(activeResult.title).toBe('Active Sandbox Sessions');
  expect(activeResult.text).toContain('Count: 2');
  expect(activeResult.text).toContain(
    'agent:main:channel:openai:chat:dm:peer:aaaabbbbccccdddd',
  );

  const clearResult = await handleGatewayCommand({
    sessionId: 'session-active-sandbox',
    guildId: null,
    channelId: 'tui',
    args: ['sessions', 'clear-active'],
  });
  expect(clearResult.kind).toBe('info');
  if (clearResult.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${clearResult.kind}`);
  }
  expect(clearResult.title).toBe('Stopped Sandbox Sessions');
  expect(clearResult.text).toContain('Stopped 2 active sandbox sessions.');
  expect(stopAllExecutionsMock).toHaveBeenCalledTimes(1);
});

test('auth status hybridai shows local HybridAI auth details', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  delete process.env.HYBRIDAI_API_KEY;
  vi.resetModules();
  writeRuntimeConfig(homeDir, (config) => {
    config.hybridai.baseUrl = 'https://hybridai.example';
    config.hybridai.defaultModel = 'gpt-4.1-mini';
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { saveRuntimeSecrets } = await import(
    '../src/security/runtime-secrets.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  saveRuntimeSecrets({
    HYBRIDAI_API_KEY: 'hai-status1234567890abcd',
  });
  initDatabase({ quiet: true });
  const result = await handleGatewayCommand({
    sessionId: 'session-auth-status',
    guildId: null,
    channelId: 'tui',
    args: ['auth', 'status', 'hybridai'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('HybridAI Auth Status');
  expect(result.text).toContain('Authenticated: yes');
  expect(result.text).toContain('Source: runtime-secrets');
  expect(result.text).toContain('API key: configured');
  expect(result.text).not.toContain('credentials.json');
  expect(result.text).not.toContain('Path:');
  expect(result.text).toContain('Base URL: https://hybridai.example');
  expect(result.text).toContain('Default model: hybridai/gpt-4.1-mini');
  expect(result.text).toContain(
    'Billing: unavailable from this status command',
  );
});

test('auth status hybridai is restricted outside local TUI/web sessions', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const result = await handleGatewayCommand({
    sessionId: 'session-auth-status-remote',
    guildId: 'guild-1',
    channelId: 'discord-channel-1',
    args: ['auth', 'status', 'hybridai'],
  });

  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Auth Status Restricted');
  expect(result.text).toContain('only available from local TUI/web sessions');
});

test('auth status supports all configured providers from local sessions', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.OPENROUTER_API_KEY = 'or-status-1234567890';
  process.env.MISTRAL_API_KEY = 'mistral-status-1234567890';
  process.env.HF_TOKEN = 'hf-status-1234567890';
  process.env.MSTEAMS_APP_ID = 'teams-app-id';
  process.env.MSTEAMS_APP_PASSWORD = 'teams-status-1234567890';
  process.env.MSTEAMS_TENANT_ID = 'teams-tenant-id';
  vi.resetModules();
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = true;
    config.mistral.enabled = true;
    config.huggingface.enabled = true;
    config.msteams.enabled = true;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = true;
    config.local.backends.vllm.enabled = false;
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const cases = [
    {
      provider: 'codex',
      expectedTitle: 'Codex Auth Status',
      expectedText: 'Authenticated:',
    },
    {
      provider: 'openrouter',
      expectedTitle: 'OpenRouter Auth Status',
      expectedText: 'Enabled: yes',
      expectedSecretText: 'API key: configured',
    },
    {
      provider: 'mistral',
      expectedTitle: 'Mistral Auth Status',
      expectedText: 'Enabled: yes',
      expectedSecretText: 'API key: configured',
    },
    {
      provider: 'huggingface',
      expectedTitle: 'Hugging Face Auth Status',
      expectedText: 'Enabled: yes',
      expectedSecretText: 'API key: configured',
    },
    {
      provider: 'local',
      expectedTitle: 'Local Auth Status',
      expectedText: 'lmstudio: enabled',
    },
    {
      provider: 'msteams',
      expectedTitle: 'Microsoft Teams Auth Status',
      expectedText: 'App ID: teams-app-id',
      expectedSecretText: 'App password: configured',
    },
  ] as const;

  for (const entry of cases) {
    const result = await handleGatewayCommand({
      sessionId: `session-auth-status-${entry.provider}`,
      guildId: null,
      channelId: 'tui',
      args: ['auth', 'status', entry.provider],
    });

    expect(result.kind).toBe('info');
    if (result.kind !== 'info') {
      throw new Error(`Unexpected result kind: ${result.kind}`);
    }
    expect(result.title).toBe(entry.expectedTitle);
    expect(result.text).toContain(entry.expectedText);
    if ('expectedSecretText' in entry) {
      expect(result.text).toContain(entry.expectedSecretText);
    }
    expect(result.text).not.toContain('Path:');
  }
});

test('secret commands manage encrypted secrets and HTTP auth routes', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();
  writeRuntimeConfig(homeDir);

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { readStoredRuntimeSecret } = await import(
    '../src/security/runtime-secrets.ts'
  );

  initDatabase({ quiet: true });

  const setResult = await handleGatewayCommand({
    sessionId: 'session-secret-set',
    guildId: null,
    channelId: 'tui',
    args: ['secret', 'set', 'NEW_HAI_API_KEY', 'super-secret-value'],
  });
  expect(setResult.kind).toBe('plain');
  expect(readStoredRuntimeSecret('NEW_HAI_API_KEY')).toBe('super-secret-value');

  const routeResult = await handleGatewayCommand({
    sessionId: 'session-secret-route',
    guildId: null,
    channelId: 'tui',
    args: [
      'secret',
      'route',
      'add',
      'https://hybridai.one/v1/',
      'NEW_HAI_API_KEY',
    ],
  });
  expect(routeResult.kind).toBe('plain');

  const listResult = await handleGatewayCommand({
    sessionId: 'session-secret-list',
    guildId: null,
    channelId: 'tui',
    args: ['secret', 'list'],
  });
  expect(listResult.kind).toBe('info');
  if (listResult.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${listResult.kind}`);
  }
  expect(listResult.text).toContain('NEW_HAI_API_KEY');
  expect(listResult.text).toContain('https://hybridai.one/v1/');
  expect(listResult.text).not.toContain('super-secret-value');

  const storedConfig = JSON.parse(
    fs.readFileSync(path.join(homeDir, '.hybridclaw', 'config.json'), 'utf-8'),
  ) as RuntimeConfig;
  expect(storedConfig.tools.httpRequest.authRules).toEqual([
    {
      urlPrefix: 'https://hybridai.one/v1/',
      header: 'Authorization',
      prefix: 'Bearer',
      secret: {
        source: 'store',
        id: 'NEW_HAI_API_KEY',
      },
    },
  ]);
});

test('secret route add normalizes URL prefixes before saving auth rules', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();
  writeRuntimeConfig(homeDir);

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  await handleGatewayCommand({
    sessionId: 'session-secret-set-normalized',
    guildId: null,
    channelId: 'tui',
    args: ['secret', 'set', 'NEW_HAI_API_KEY', 'super-secret-value'],
  });
  await handleGatewayCommand({
    sessionId: 'session-secret-route-normalized',
    guildId: null,
    channelId: 'tui',
    args: [
      'secret',
      'route',
      'add',
      'https://user:pass@hybridai.one/v1?debug=1#frag',
      'NEW_HAI_API_KEY',
    ],
  });

  const storedConfig = JSON.parse(
    fs.readFileSync(path.join(homeDir, '.hybridclaw', 'config.json'), 'utf-8'),
  ) as RuntimeConfig;
  expect(storedConfig.tools.httpRequest.authRules).toEqual([
    {
      urlPrefix: 'https://hybridai.one/v1/',
      header: 'Authorization',
      prefix: 'Bearer',
      secret: {
        source: 'store',
        id: 'NEW_HAI_API_KEY',
      },
    },
  ]);
});

test('config shows the local runtime config', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();
  writeRuntimeConfig(homeDir, (config) => {
    config.hybridai.maxTokens = 4096;
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const result = await handleGatewayCommand({
    sessionId: 'session-config-view',
    guildId: null,
    channelId: 'web',
    args: ['config'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Runtime Config');
  expect(
    result.text.startsWith(
      `Active config: ${path.join(homeDir, '.hybridclaw', 'config.json')}\n`,
    ),
  ).toBe(true);
  expect(result.text).toContain('"maxTokens": 4096');
});

test('config check validates the local runtime config', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();
  writeRuntimeConfig(homeDir, (config) => {
    config.hybridai.maxTokens = 4096;
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const result = await handleGatewayCommand({
    sessionId: 'session-config-check',
    guildId: null,
    channelId: 'web',
    args: ['config', 'check'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Config Check');
  expect(result.text).toContain('✓ Config');
  expect(result.text).toContain('0 errors');
});

test('config reload hot-reloads the local runtime config from disk', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();
  writeRuntimeConfig(homeDir, (config) => {
    config.hybridai.maxTokens = 4096;
  });

  const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  writeRuntimeConfig(homeDir, (config) => {
    config.hybridai.maxTokens = 8192;
  });

  const result = await handleGatewayCommand({
    sessionId: 'session-config-reload',
    guildId: null,
    channelId: 'web',
    args: ['config', 'reload'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Runtime Config Reloaded');
  expect(result.text).toContain(`Path: ${configPath}`);
  expect(result.text).toContain('"maxTokens": 8192');
  expect(result.text).toContain('Check:');
  expect(result.text).toContain('✓ Config');
  expect(getRuntimeConfig().hybridai.maxTokens).toBe(8192);
});

test('config set updates an existing dotted runtime config key', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();
  writeRuntimeConfig(homeDir, (config) => {
    config.hybridai.maxTokens = 4096;
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const result = await handleGatewayCommand({
    sessionId: 'session-config-set',
    guildId: null,
    channelId: 'tui',
    args: ['config', 'set', 'hybridai.maxTokens', '8192'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Runtime Config Updated');
  expect(result.text).toContain('Key: hybridai.maxTokens');
  expect(result.text).toContain('"maxTokens": 8192');
  expect(result.text).toContain('Check:');
  expect(result.text).toContain('✓ Config');
  expect(getRuntimeConfig().hybridai.maxTokens).toBe(8192);
});

test('config is restricted outside local TUI/web sessions', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const result = await handleGatewayCommand({
    sessionId: 'session-config-remote',
    guildId: 'guild-1',
    channelId: 'discord-channel-1',
    args: ['config'],
  });

  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Config Restricted');
  expect(result.text).toContain('only available from local TUI/web sessions');
});

test('assistant presentation caches resolved image assets per agent path', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { getGatewayAssistantPresentationForAgent } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({
    id: 'charly',
    name: 'Charly Agent',
    displayName: 'Charly',
    imageAsset: 'avatars/charly.png',
  });

  const avatarPath = path.join(
    agentWorkspaceDir('charly'),
    'avatars',
    'charly.png',
  );
  fs.mkdirSync(path.dirname(avatarPath), { recursive: true });
  fs.writeFileSync(avatarPath, Buffer.from('89504e470d0a1a0a', 'hex'));

  const statSyncSpy = vi.spyOn(fs, 'statSync');

  expect(getGatewayAssistantPresentationForAgent('charly')).toMatchObject({
    agentId: 'charly',
    displayName: 'Charly',
    imageUrl: '/api/agent-avatar?agentId=charly',
  });
  expect(getGatewayAssistantPresentationForAgent('charly')).toMatchObject({
    agentId: 'charly',
    displayName: 'Charly',
    imageUrl: '/api/agent-avatar?agentId=charly',
  });
  expect(statSyncSpy).toHaveBeenCalledTimes(1);
});

test('getGatewayStatus includes loaded plugin commands for TUI discovery', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();
  mockHealthProbes();

  vi.doMock('../src/plugins/plugin-manager.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/plugins/plugin-manager.js')
    >('../src/plugins/plugin-manager.js');
    return {
      ...actual,
      listLoadedPluginCommands: vi.fn(() => [
        {
          name: 'qmd',
          description: 'Show QMD plugin and index status',
        },
      ]),
    };
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getGatewayStatus } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const status = await getGatewayStatus();

  expect(status.pluginCommands).toEqual([
    {
      name: 'qmd',
      description: 'Show QMD plugin and index status',
    },
  ]);
});

test('status uses OpenRouter context_length metadata for the context window', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.OPENROUTER_API_KEY = 'or-status-test';
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = true;
    config.hybridai.defaultModel = 'openrouter/hunter-alpha';
    config.openrouter.models = ['openrouter/hunter-alpha'];
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'hunter-alpha',
                context_length: 262144,
                pricing: {
                  prompt: '0',
                  completion: '0',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );

  const { initDatabase } = await import('../src/memory/db.ts');
  const { makeAuditRunId, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  recordAuditEvent({
    sessionId: 'session-status-openrouter-context',
    runId: makeAuditRunId('test'),
    event: {
      type: 'model.usage',
      provider: 'openrouter',
      model: 'openrouter/hunter-alpha',
      promptTokens: 12_000,
    },
  });

  const result = await handleGatewayCommand({
    sessionId: 'session-status-openrouter-context',
    guildId: null,
    channelId: 'channel-status-openrouter-context',
    args: ['status'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain('🧠 Model: openrouter/hunter-alpha');
  expect(result.text).toContain('📚 Context: 12k/262k');
});

test('status uses Hugging Face context_length metadata for the context window', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HF_TOKEN = 'hf-status-test';
  writeRuntimeConfig(homeDir, (config) => {
    config.huggingface.enabled = true;
    config.hybridai.defaultModel =
      'huggingface/meta-llama/Llama-3.1-8B-Instruct';
    config.huggingface.models = [
      'huggingface/meta-llama/Llama-3.1-8B-Instruct',
    ];
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'meta-llama/Llama-3.1-8B-Instruct',
                context_length: 131072,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );

  const { initDatabase } = await import('../src/memory/db.ts');
  const { makeAuditRunId, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  recordAuditEvent({
    sessionId: 'session-status-huggingface-context',
    runId: makeAuditRunId('test'),
    event: {
      type: 'model.usage',
      provider: 'huggingface',
      model: 'huggingface/meta-llama/Llama-3.1-8B-Instruct',
      promptTokens: 10_000,
    },
  });

  const result = await handleGatewayCommand({
    sessionId: 'session-status-huggingface-context',
    guildId: null,
    channelId: 'channel-status-huggingface-context',
    args: ['status'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain(
    '🧠 Model: huggingface/meta-llama/Llama-3.1-8B-Instruct',
  );
  expect(result.text).toContain('📚 Context: 10k/131k');
});

test('status uses Mistral max_context_length metadata for the context window', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.MISTRAL_API_KEY = 'mistral-status-test';
  writeRuntimeConfig(homeDir, (config) => {
    config.mistral.enabled = true;
    config.hybridai.defaultModel = 'mistral/mistral-large-latest';
    config.mistral.models = ['mistral/mistral-large-latest'];
    config.openrouter.enabled = false;
    config.huggingface.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/models')) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer mistral-status-test',
        });
        return new Response(
          JSON.stringify([
            {
              id: 'mistral-large-latest',
              max_context_length: 131072,
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );

  const { initDatabase } = await import('../src/memory/db.ts');
  const { makeAuditRunId, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  recordAuditEvent({
    sessionId: 'session-status-mistral-context',
    runId: makeAuditRunId('test'),
    event: {
      type: 'model.usage',
      provider: 'mistral',
      model: 'mistral/mistral-large-latest',
      promptTokens: 11_000,
    },
  });

  const result = await handleGatewayCommand({
    sessionId: 'session-status-mistral-context',
    guildId: null,
    channelId: 'channel-status-mistral-context',
    args: ['status'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain('🧠 Model: mistral/mistral-large-latest');
  expect(result.text).toContain('📚 Context: 11k/131k');
});

test('status uses Hugging Face provider-level context_length metadata for the context window', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HF_TOKEN = 'hf-status-test';
  writeRuntimeConfig(homeDir, (config) => {
    config.huggingface.enabled = true;
    config.hybridai.defaultModel = 'huggingface/XiaomiMiMo/MiMo-V2-Flash';
    config.huggingface.models = ['huggingface/XiaomiMiMo/MiMo-V2-Flash'];
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'XiaomiMiMo/MiMo-V2-Flash',
                providers: [
                  {
                    provider: 'novita',
                    status: 'live',
                    context_length: 262144,
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );

  const { initDatabase } = await import('../src/memory/db.ts');
  const { makeAuditRunId, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  recordAuditEvent({
    sessionId: 'session-status-huggingface-provider-context',
    runId: makeAuditRunId('test'),
    event: {
      type: 'model.usage',
      provider: 'huggingface',
      model: 'huggingface/XiaomiMiMo/MiMo-V2-Flash',
      promptTokens: 23_000,
    },
  });

  const result = await handleGatewayCommand({
    sessionId: 'session-status-huggingface-provider-context',
    guildId: null,
    channelId: 'channel-status-huggingface-provider-context',
    args: ['status'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain(
    '🧠 Model: huggingface/XiaomiMiMo/MiMo-V2-Flash',
  );
  expect(result.text).toContain('📚 Context: 23k/262k');
});

test('status reuses the context window recorded by model set when later discovery lacks it', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.OPENROUTER_API_KEY = 'or-status-model-set-test';
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = true;
    config.openrouter.models = ['openrouter/hunter-alpha'];
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });

  vi.resetModules();
  mockHealthProbes({ hybridaiReachable: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'hunter-alpha', context_length: 262144 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );

  {
    const { initDatabase } = await import('../src/memory/db.ts');
    const { handleGatewayCommand } = await import(
      '../src/gateway/gateway-service.ts'
    );

    initDatabase({ quiet: true });
    const setResult = await handleGatewayCommand({
      sessionId: 'session-status-model-set-context',
      guildId: null,
      channelId: 'channel-status-model-set-context',
      args: ['model', 'set', 'openrouter/hunter-alpha'],
    });
    expect(setResult.kind).toBe('plain');
  }

  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  mockHealthProbes({ hybridaiReachable: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'hunter-alpha' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );

  const { initDatabase } = await import('../src/memory/db.ts');
  const { makeAuditRunId, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  recordAuditEvent({
    sessionId: 'session-status-model-set-context',
    runId: makeAuditRunId('test'),
    event: {
      type: 'model.usage',
      provider: 'openrouter',
      model: 'openrouter/hunter-alpha',
      promptTokens: 21_000,
    },
  });

  const result = await handleGatewayCommand({
    sessionId: 'session-status-model-set-context',
    guildId: null,
    channelId: 'channel-status-model-set-context',
    args: ['status'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain('🧠 Model: openrouter/hunter-alpha');
  expect(result.text).toContain('📚 Context: 21k/262k');
});

test('status shows zero cache usage when the provider reports zero cache tokens', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { makeAuditRunId, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  recordAuditEvent({
    sessionId: 'session-status-zero-cache',
    runId: makeAuditRunId('test'),
    event: {
      type: 'model.usage',
      provider: 'openrouter',
      model: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
      promptTokens: 53_211,
      completionTokens: 952,
      apiUsageAvailable: true,
      apiPromptTokens: 53_211,
      apiCompletionTokens: 952,
      apiTotalTokens: 54_163,
      apiCacheUsageAvailable: true,
      apiCacheReadTokens: 0,
      apiCacheWriteTokens: 0,
      cacheReadTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteTokens: 0,
      cacheWriteInputTokens: 0,
    },
  });

  const result = await handleGatewayCommand({
    sessionId: 'session-status-zero-cache',
    guildId: null,
    channelId: 'channel-status-zero-cache',
    args: ['status'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain('🗄️ Cache: 0% hit · 0 cached, 0 new');
});

test('agent create warns when model validation is skipped because no models are available', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const warnMock = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnMock,
      error: vi.fn(),
      fatal: vi.fn(),
    },
  }));
  vi.doMock('../src/providers/model-catalog.js', () => ({
    getAvailableModelList: vi.fn(() => []),
    refreshAvailableModelCatalogs: vi.fn(async () => {}),
  }));

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-create-agent',
    guildId: null,
    channelId: 'channel-create-agent',
    args: ['agent', 'create', 'research', '--model', 'garbage/model'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Agent Created');
  expect(result.text).toContain('Agent: research');
  expect(result.text).toContain('Model: hybridai/garbage/model');
  expect(warnMock).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-create-agent',
      agentId: 'research',
      model: 'garbage/model',
    }),
    'Skipping agent model validation because no available models are configured',
  );
});

test('model list includes discovered OpenRouter models', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  delete process.env.HYBRIDAI_API_KEY;
  process.env.OPENROUTER_API_KEY = 'or-gateway-status-1234567890';
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = true;
    config.openrouter.models = ['openrouter/anthropic/claude-sonnet-4'];
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();
  mockHealthProbes({ hybridaiReachable: true });
  vi.doMock('../src/providers/hybridai-discovery.ts', () => ({
    discoverHybridAIModels: vi.fn(async () => []),
    getDiscoveredHybridAIModelContextWindow: vi.fn(() => null),
    getDiscoveredHybridAIModelNames: vi.fn(() => []),
  }));

  const fetchMock = vi.fn(async (input: string) => {
    if (input.endsWith('/models')) {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'openai/gpt-4.1-mini' },
            { id: 'nvidia/nemotron-3-super-120b-a12b:free' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected URL: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-model-list-openrouter',
    guildId: null,
    channelId: 'channel-model-list-openrouter',
    args: ['model', 'list'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Available Models');
  expect(result.text).toContain('hybridai/gpt-4.1-mini');
  expect(result.text).toContain('hybridai/gpt-5-nano');
  expect(result.text).toContain('openrouter/anthropic/claude-sonnet-4');
  expect(result.text).toContain('openrouter/openai/gpt-4.1-mini');
  expect(result.text).toContain(
    'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
  );
  expect(result.modelCatalog).toEqual(
    expect.arrayContaining([
      {
        value: 'gpt-4.1-mini',
        label: 'hybridai/gpt-4.1-mini (current)',
        isFree: false,
      },
      {
        value: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
        label: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
        isFree: false,
        recommended: true,
      },
    ]),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('model list openrouter asks for authorization before reporting no models', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  delete process.env.OPENROUTER_API_KEY;
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = true;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();
  mockHealthProbes({ hybridaiReachable: true });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-model-list-openrouter-auth-required',
    guildId: null,
    channelId: 'channel-model-list-openrouter-auth-required',
    args: ['model', 'list', 'openrouter'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Available Models');
  expect(result.text).toContain('OpenRouter is not authorized.');
  expect(result.text).toContain('Authorize it first from a terminal:');
  expect(result.text).toContain('hybridclaw auth login openrouter');
  expect(result.text).toContain('Then rerun `model list openrouter`.');
  expect(result.text).not.toContain('No models available for provider');
});

test('model list openrouter asks to enable the provider when credentials exist but it is disabled', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.OPENROUTER_API_KEY = 'or-gateway-status-1234567890';
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = false;
    config.openrouter.models = ['openrouter/anthropic/claude-sonnet-4'];
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();
  mockHealthProbes({ hybridaiReachable: true });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-model-list-openrouter-enable-required',
    guildId: null,
    channelId: 'channel-model-list-openrouter-enable-required',
    args: ['model', 'list', 'openrouter'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Available Models');
  expect(result.text).toContain('OpenRouter is disabled.');
  expect(result.text).toContain('config set openrouter.enabled true');
  expect(result.text).toContain('Then rerun `model list openrouter`.');
  expect(result.text).not.toContain('No models available for provider');
});

test('model list includes discovered HybridAI models', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDAI_API_KEY = 'hai-gateway-status-1234567890';
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();
  mockHealthProbes({ hybridaiReachable: true });

  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/models')) {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer hai-gateway-status-1234567890',
      });
      return new Response(
        JSON.stringify({
          data: [{ id: 'gpt-5-ultra', context_length: 512_000 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected URL: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-model-list-hybridai',
    guildId: null,
    channelId: 'channel-model-list-hybridai',
    args: ['model', 'list', 'hybridai'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Available Models (hybridai)');
  expect(result.text).toContain('hybridai/gpt-5-nano');
  expect(result.text).toContain('hybridai/gpt-5-ultra');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('model list filters by provider alias', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.OPENROUTER_API_KEY = 'or-gateway-status-1234567890';
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = true;
    config.openrouter.models = [
      'openrouter/zeta/model-b',
      'openrouter/alpha/model-a',
    ];
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();
  mockHealthProbes({ hybridaiReachable: true });

  const fetchMock = vi.fn(async (input: string) => {
    if (input.endsWith('/models')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'free',
              pricing: {
                prompt: '0',
                completion: '0',
                request: '0',
              },
            },
            {
              id: 'healer-alpha',
              pricing: {
                prompt: '0',
                completion: '0',
                request: '0',
              },
            },
            {
              id: 'hunter-alpha',
              pricing: {
                prompt: '0',
                completion: '0',
                request: '0',
              },
            },
            {
              id: 'ai21/jamba-large-1.7',
              pricing: {
                prompt: '1',
                completion: '1',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected URL: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-model-list-openrouter-filtered',
    guildId: null,
    channelId: 'channel-model-list-openrouter-filtered',
    args: ['model', 'list', 'openrouter'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Available Models (openrouter)');
  expect(result.text).toBe(
    [
      'openrouter/free',
      'openrouter/healer-alpha',
      'openrouter/hunter-alpha',
      'openrouter/ai21/jamba-large-1.7',
      'openrouter/alpha/model-a',
      'openrouter/zeta/model-b',
    ].join('\n'),
  );
  expect(result.modelCatalog).toEqual([
    { value: 'openrouter/free', label: 'openrouter/free', isFree: true },
    {
      value: 'openrouter/healer-alpha',
      label: 'openrouter/healer-alpha',
      isFree: true,
    },
    {
      value: 'openrouter/hunter-alpha',
      label: 'openrouter/hunter-alpha',
      isFree: true,
    },
    {
      value: 'openrouter/ai21/jamba-large-1.7',
      label: 'openrouter/ai21/jamba-large-1.7',
      isFree: false,
    },
    {
      value: 'openrouter/alpha/model-a',
      label: 'openrouter/alpha/model-a',
      isFree: false,
    },
    {
      value: 'openrouter/zeta/model-b',
      label: 'openrouter/zeta/model-b',
      isFree: false,
    },
  ]);
  expect(result.text).not.toContain('gpt-5-nano');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('model list shows the full Hugging Face catalog', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HF_TOKEN = 'hf-gateway-status-1234567890';
  writeRuntimeConfig(homeDir, (config) => {
    config.huggingface.enabled = true;
    config.hybridai.defaultModel = 'huggingface/Qwen/Qwen3.5-397B-A17B';
    config.huggingface.models = ['huggingface/Qwen/Qwen3.5-397B-A17B'];
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();
  mockHealthProbes({ hybridaiReachable: true });

  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/models')) {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer hf-gateway-status-1234567890',
      });
      return new Response(
        JSON.stringify({
          data: [
            { id: 'Qwen/Qwen3.5-397B-A17B' },
            { id: 'deepseek-ai/DeepSeek-V3.2' },
            { id: 'Qwen/Qwen3.5-27B-FP8' },
            { id: 'zeta/custom-model' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected URL: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const listed = await handleGatewayCommand({
    sessionId: 'session-model-list-huggingface',
    guildId: null,
    channelId: 'channel-model-list-huggingface',
    args: ['model', 'list', 'huggingface'],
  });

  expect(listed.kind).toBe('info');
  if (listed.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${listed.kind}`);
  }
  expect(listed.title).toBe('Available Models (huggingface)');
  expect(listed.text).toContain('huggingface/Qwen/Qwen3.5-397B-A17B (current)');
  expect(listed.text).toContain('huggingface/deepseek-ai/DeepSeek-V3.2');
  expect(listed.text).toContain('huggingface/Qwen/Qwen3.5-27B-FP8');
  expect(listed.text).toContain('huggingface/zeta/custom-model');
  expect(listed.modelCatalog).toEqual(
    expect.arrayContaining([
      {
        value: 'huggingface/Qwen/Qwen3.5-397B-A17B',
        label: 'huggingface/Qwen/Qwen3.5-397B-A17B (current)',
        isFree: false,
        recommended: true,
      },
      {
        value: 'huggingface/deepseek-ai/DeepSeek-V3.2',
        label: 'huggingface/deepseek-ai/DeepSeek-V3.2',
        isFree: false,
        recommended: true,
      },
      {
        value: 'huggingface/Qwen/Qwen3.5-27B-FP8',
        label: 'huggingface/Qwen/Qwen3.5-27B-FP8',
        isFree: false,
        recommended: true,
      },
      {
        value: 'huggingface/zeta/custom-model',
        label: 'huggingface/zeta/custom-model',
        isFree: false,
      },
    ]),
  );
});

test('model list highlights recommended Mistral models and hides legacy entries', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.MISTRAL_API_KEY = 'mistral-gateway-status-1234567890';
  writeRuntimeConfig(homeDir, (config) => {
    config.mistral.enabled = true;
    config.hybridai.defaultModel = 'mistral/mistral-medium-latest';
    config.mistral.models = ['mistral/mistral-medium-latest'];
    config.openrouter.enabled = false;
    config.huggingface.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();
  mockHealthProbes({ hybridaiReachable: true });

  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/models')) {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer mistral-gateway-status-1234567890',
      });
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'mistral-small-2603' },
            {
              id: 'mistral-large-2512',
              name: 'mistral-large-2512',
              aliases: [],
            },
            {
              id: 'mistral-large-latest',
              name: 'mistral-large-2512',
              aliases: [],
            },
            {
              id: 'devstral-2512',
              name: 'devstral-2512',
              aliases: [],
            },
            {
              id: 'devstral-latest',
              name: 'devstral-2512',
              aliases: [],
            },
            {
              id: 'devstral-medium-latest',
              name: 'devstral-2512',
              aliases: [],
            },
            {
              id: 'mistral-medium-latest',
              name: 'mistral-medium-2508',
              aliases: ['mistral-medium-2508', 'mistral-medium'],
            },
            {
              id: 'mistral-medium-2508',
              name: 'mistral-medium-2508',
              aliases: ['mistral-medium-latest', 'mistral-medium'],
            },
            { id: 'mistral-small-2506' },
            { id: 'ministral-14b-2512' },
            { id: 'ministral-8b-2512' },
            { id: 'ministral-3b-2512' },
            {
              id: 'magistral-medium-latest',
              name: 'magistral-medium-2509',
              aliases: ['magistral-medium-2509'],
            },
            {
              id: 'magistral-medium-2509',
              name: 'magistral-medium-2509',
              aliases: ['magistral-medium-latest'],
            },
            {
              id: 'magistral-small-latest',
              name: 'magistral-small-2509',
              aliases: ['magistral-small-2509'],
            },
            {
              id: 'magistral-small-2509',
              name: 'magistral-small-2509',
              aliases: ['magistral-small-latest'],
            },
            {
              id: 'codestral-2501',
              deprecation: '2026-05-31T12:00:00Z',
            },
            { id: 'custom-team-model' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected URL: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const listed = await handleGatewayCommand({
    sessionId: 'session-model-list-mistral',
    guildId: null,
    channelId: 'channel-model-list-mistral',
    args: ['model', 'list', 'mistral'],
  });

  expect(listed.kind).toBe('info');
  if (listed.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${listed.kind}`);
  }
  expect(listed.title).toBe('Available Models (mistral)');
  expect(listed.text).toContain('mistral/mistral-medium-2508 (current)');
  expect(listed.text).toContain('mistral/mistral-small-2603');
  expect(listed.text).toContain('mistral/mistral-large-2512');
  expect(listed.text).toContain('mistral/devstral-2512');
  expect(listed.text).toContain('mistral/mistral-small-2506');
  expect(listed.text).toContain('mistral/ministral-14b-2512');
  expect(listed.text).toContain('mistral/ministral-8b-2512');
  expect(listed.text).toContain('mistral/ministral-3b-2512');
  expect(listed.text).toContain('mistral/magistral-medium-2509');
  expect(listed.text).toContain('mistral/magistral-small-2509');
  expect(listed.text).toContain('mistral/custom-team-model');
  expect(listed.text).not.toContain('mistral/codestral-2501');
  expect(listed.text).not.toContain('mistral/mistral-large-latest');
  expect(listed.text).not.toContain('mistral/devstral-latest');
  expect(listed.text).not.toContain('mistral/devstral-medium-latest');
  expect(listed.text).not.toContain('mistral/mistral-medium-latest');
  expect(listed.text).not.toContain('mistral/magistral-medium-latest');
  expect(listed.text).not.toContain('mistral/magistral-small-latest');
  expect(listed.modelCatalog).toEqual(
    expect.arrayContaining([
      {
        value: 'mistral/custom-team-model',
        label: 'mistral/custom-team-model',
        isFree: false,
      },
      {
        value: 'mistral/mistral-small-2603',
        label: 'mistral/mistral-small-2603',
        isFree: false,
        recommended: true,
      },
      {
        value: 'mistral/mistral-large-2512',
        label: 'mistral/mistral-large-2512',
        isFree: false,
        recommended: true,
      },
      {
        value: 'mistral/devstral-2512',
        label: 'mistral/devstral-2512',
        isFree: false,
        recommended: true,
      },
      {
        value: 'mistral/mistral-medium-2508',
        label: 'mistral/mistral-medium-2508 (current)',
        isFree: false,
        recommended: true,
      },
      {
        value: 'mistral/mistral-small-2506',
        label: 'mistral/mistral-small-2506',
        isFree: false,
      },
      {
        value: 'mistral/ministral-14b-2512',
        label: 'mistral/ministral-14b-2512',
        isFree: false,
        recommended: true,
      },
      {
        value: 'mistral/ministral-8b-2512',
        label: 'mistral/ministral-8b-2512',
        isFree: false,
        recommended: true,
      },
      {
        value: 'mistral/ministral-3b-2512',
        label: 'mistral/ministral-3b-2512',
        isFree: false,
        recommended: true,
      },
      {
        value: 'mistral/magistral-medium-2509',
        label: 'mistral/magistral-medium-2509',
        isFree: false,
        recommended: true,
      },
      {
        value: 'mistral/magistral-small-2509',
        label: 'mistral/magistral-small-2509',
        isFree: false,
      },
      {
        value: 'mistral/magistral-medium-2509',
        label: 'mistral/magistral-medium-2509',
        isFree: false,
        recommended: true,
      },
    ]),
  );
  expect(listed.modelCatalog).not.toEqual(
    expect.arrayContaining([
      {
        value: 'mistral/mistral-medium-latest',
        label: 'mistral/mistral-medium-latest',
        isFree: false,
      },
      {
        value: 'mistral/mistral-large-latest',
        label: 'mistral/mistral-large-latest',
        isFree: false,
      },
      {
        value: 'mistral/devstral-latest',
        label: 'mistral/devstral-latest',
        isFree: false,
      },
      {
        value: 'mistral/magistral-medium-latest',
        label: 'mistral/magistral-medium-latest',
        isFree: false,
      },
      {
        value: 'mistral/codestral-2501',
        label: 'mistral/codestral-2501',
        isFree: false,
      },
    ]),
  );
});

test('model info shows global, agent, and session scopes', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  writeRuntimeConfig(homeDir, (config) => {
    config.hybridai.defaultModel = 'gpt-5';
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({
    id: 'research',
    model: 'gpt-5-mini',
  });

  await handleGatewayCommand({
    sessionId: 'session-model-scopes',
    guildId: null,
    channelId: 'channel-model-scopes',
    args: ['agent', 'switch', 'research'],
  });
  await handleGatewayCommand({
    sessionId: 'session-model-scopes',
    guildId: null,
    channelId: 'channel-model-scopes',
    args: ['model', 'set', 'hybridai/gpt-5-nano'],
  });
  const result = await handleGatewayCommand({
    sessionId: 'session-model-scopes',
    guildId: null,
    channelId: 'channel-model-scopes',
    args: ['model', 'info'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Model Info');
  expect(result.text).toContain('Effective model: hybridai/gpt-5-nano');
  expect(result.text).toContain('Global model: hybridai/gpt-5');
  expect(result.text).toContain('Agent model: hybridai/gpt-5-mini');
  expect(result.text).toContain('Session model: hybridai/gpt-5-nano');
});

test('model info filters unavailable provider models from available now', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDAI_API_KEY = 'hai-model-info-1234567890';
  writeRuntimeConfig(homeDir, (config) => {
    config.hybridai.defaultModel = 'gpt-5';
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = true;
    config.local.backends.lmstudio.baseUrl = 'http://127.0.0.1:1234/v1';
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();
  mockHealthProbes({
    hybridaiReachable: true,
    localBackends: [
      {
        backend: 'lmstudio',
        reachable: false,
        error: 'connection refused',
      },
    ],
  });

  const fetchMock = vi.fn(async (input: string) => {
    if (input.endsWith('/models')) {
      return new Response(
        JSON.stringify({
          data: [{ id: 'gpt-5-ultra', context_length: 512_000 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (input.endsWith('/v1/models')) {
      return new Response(
        JSON.stringify({
          data: [{ id: 'qwen/qwen3.5-9b' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected URL: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-model-info-state',
    guildId: null,
    channelId: 'channel-model-info-state',
    args: ['model', 'info'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain('Available now:');
  expect(result.text).toContain('hybridai/gpt-5');
  expect(result.text).toContain('hybridai/gpt-5-ultra');
  expect(result.text).not.toContain('openai-codex/');
  expect(result.text).not.toContain('lmstudio/qwen/qwen3.5-9b');
  expect(result.modelCatalog).toEqual(
    expect.arrayContaining([
      {
        value: 'gpt-5',
        label: 'hybridai/gpt-5 (current)',
        isFree: false,
      },
    ]),
  );
});

test('model list refreshes local backend health before filtering models', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = true;
    config.local.backends.lmstudio.baseUrl = 'http://127.0.0.1:1234/v1';
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();

  let useFreshState = false;
  const invalidate = vi.fn(() => {
    useFreshState = true;
  });
  vi.doMock('../src/providers/hybridai-health.js', () => ({
    hybridAIProbe: {
      get: vi.fn(async () => ({
        reachable: true,
        latencyMs: 10,
        modelCount: 3,
      })),
      peek: vi.fn(() => null),
      invalidate: vi.fn(),
    },
  }));
  vi.doMock('../src/providers/local-health.js', () => ({
    localBackendsProbe: {
      get: vi.fn(
        async () =>
          new Map([
            [
              'lmstudio',
              {
                backend: 'lmstudio',
                reachable: !useFreshState,
                latencyMs: 10,
                ...(useFreshState
                  ? { error: 'connection refused' }
                  : { modelCount: 1 }),
              },
            ],
          ]),
      ),
      peek: vi.fn(() => null),
      invalidate,
    },
    checkConnection: vi.fn(),
    checkModelConnection: vi.fn(),
    checkAllBackends: vi.fn(async () => new Map()),
  }));
  vi.doMock('../src/providers/hybridai-discovery.ts', () => ({
    discoverHybridAIModels: vi.fn(async () => []),
    getDiscoveredHybridAIModelContextWindow: vi.fn(() => null),
    getDiscoveredHybridAIModelNames: vi.fn(() => []),
  }));
  vi.doMock('../src/providers/local-discovery.ts', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/local-discovery.ts')
    >('../src/providers/local-discovery.ts');
    return {
      ...actual,
      discoverAllLocalModels: vi.fn(async () => []),
      getDiscoveredLocalModelNames: vi.fn(() => ['lmstudio/qwen/qwen3.5-9b']),
    };
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-model-list-fresh-local-health',
    guildId: null,
    channelId: 'channel-model-list-fresh-local-health',
    args: ['model', 'list'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(result.text).not.toContain('lmstudio/qwen/qwen3.5-9b');
});

test('model clear does not refresh provider health probes', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = true;
    config.local.backends.lmstudio.baseUrl = 'http://127.0.0.1:1234/v1';
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();

  const invalidateLocal = vi.fn();
  const invalidateHybridAI = vi.fn();
  vi.doMock('../src/providers/hybridai-health.js', () => ({
    hybridAIProbe: {
      get: vi.fn(async () => ({
        reachable: true,
        latencyMs: 10,
        modelCount: 3,
      })),
      peek: vi.fn(() => null),
      invalidate: invalidateHybridAI,
    },
  }));
  vi.doMock('../src/providers/local-health.js', () => ({
    localBackendsProbe: {
      get: vi.fn(async () => new Map()),
      peek: vi.fn(() => null),
      invalidate: invalidateLocal,
    },
    checkConnection: vi.fn(),
    checkModelConnection: vi.fn(),
    checkAllBackends: vi.fn(async () => new Map()),
  }));

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-model-clear-no-refresh',
    guildId: null,
    channelId: 'channel-model-clear-no-refresh',
    args: ['model', 'clear'],
  });

  expect(result.kind).toBe('plain');
  expect(invalidateLocal).not.toHaveBeenCalled();
  expect(invalidateHybridAI).not.toHaveBeenCalled();
});

test('model clear removes the session override and falls back to the agent model', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  writeRuntimeConfig(homeDir, (config) => {
    config.hybridai.defaultModel = 'gpt-5';
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({
    id: 'research',
    model: 'gpt-5-mini',
  });

  await handleGatewayCommand({
    sessionId: 'session-model-clear',
    guildId: null,
    channelId: 'channel-model-clear',
    args: ['agent', 'switch', 'research'],
  });
  await handleGatewayCommand({
    sessionId: 'session-model-clear',
    guildId: null,
    channelId: 'channel-model-clear',
    args: ['model', 'set', 'hybridai/gpt-5-nano'],
  });
  const cleared = await handleGatewayCommand({
    sessionId: 'session-model-clear',
    guildId: null,
    channelId: 'channel-model-clear',
    args: ['model', 'clear'],
  });
  const info = await handleGatewayCommand({
    sessionId: 'session-model-clear',
    guildId: null,
    channelId: 'channel-model-clear',
    args: ['model', 'info'],
  });

  expect(cleared.kind).toBe('plain');
  if (cleared.kind !== 'plain') {
    throw new Error(`Unexpected result kind: ${cleared.kind}`);
  }
  expect(cleared.text).toContain(
    'Session model override cleared. Effective model: `hybridai/gpt-5-mini`.',
  );
  expect(info.kind).toBe('info');
  if (info.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${info.kind}`);
  }
  expect(info.text).toContain('Effective model: hybridai/gpt-5-mini');
  expect(info.text).toContain('Global model: hybridai/gpt-5');
  expect(info.text).toContain('Agent model: hybridai/gpt-5-mini');
  expect(info.text).toContain('Session model: (none)');
});

test('agent model sets the persistent model for the current session agent', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  writeRuntimeConfig(homeDir, (config) => {
    config.hybridai.defaultModel = 'gpt-5';
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getStoredAgentConfig, resolveAgentModel, upsertRegisteredAgent } =
    await import('../src/agents/agent-registry.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({
    id: 'research',
    model: 'gpt-5-mini',
  });

  await handleGatewayCommand({
    sessionId: 'session-agent-model',
    guildId: null,
    channelId: 'channel-agent-model',
    args: ['agent', 'switch', 'research'],
  });
  await handleGatewayCommand({
    sessionId: 'session-agent-model',
    guildId: null,
    channelId: 'channel-agent-model',
    args: ['model', 'set', 'hybridai/gpt-5-nano'],
  });
  const updated = await handleGatewayCommand({
    sessionId: 'session-agent-model',
    guildId: null,
    channelId: 'channel-agent-model',
    args: ['agent', 'model', 'hybridai/gpt-5'],
  });
  const info = await handleGatewayCommand({
    sessionId: 'session-agent-model',
    guildId: null,
    channelId: 'channel-agent-model',
    args: ['agent', 'model'],
  });

  expect(updated.kind).toBe('info');
  if (updated.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${updated.kind}`);
  }
  expect(updated.title).toBe('Agent Model Updated');
  expect(updated.text).toContain('Effective model: hybridai/gpt-5-nano');
  expect(updated.text).toContain('Global model: hybridai/gpt-5');
  expect(updated.text).toContain('Agent model: hybridai/gpt-5');
  expect(updated.text).toContain('Session model: hybridai/gpt-5-nano');
  expect(updated.text).toContain(
    'Run `model clear` to use the updated agent model in this session.',
  );
  expect(resolveAgentModel(getStoredAgentConfig('research'))).toBe('gpt-5');
  expect(info.kind).toBe('info');
  if (info.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${info.kind}`);
  }
  expect(info.title).toBe('Agent Model');
  expect(info.text).toContain('Current agent: research');
  expect(info.text).toContain('Effective model: hybridai/gpt-5-nano');
  expect(info.text).toContain('Global model: hybridai/gpt-5');
  expect(info.text).toContain('Agent model: hybridai/gpt-5');
  expect(info.text).toContain('Session model: hybridai/gpt-5-nano');
});
