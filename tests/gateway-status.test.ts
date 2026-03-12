import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_HYBRIDAI_API_KEY = process.env.HYBRIDAI_API_KEY;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-gateway-status-'));
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
  vi.doUnmock('../src/providers/model-catalog.js');
  vi.doUnmock('../src/providers/local-discovery.js');
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('HYBRIDAI_API_KEY', ORIGINAL_HYBRIDAI_API_KEY);
});

test('getGatewayStatus includes Codex auth state', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDAI_API_KEY = 'hai-test-gateway-status-1234567890';
  vi.resetModules();

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
  const status = getGatewayStatus();

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

test('status command includes the current session agent', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
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
  expect(result.text).toContain('Model: garbage/model');
  expect(warnMock).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-create-agent',
      agentId: 'research',
      model: 'garbage/model',
    }),
    'Skipping agent model validation because no available models are configured',
  );
});

test('getGatewayAdminModels sorts catalog entries by monthly usage descending', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  vi.doMock('../src/providers/model-catalog.js', () => ({
    getAvailableModelList: vi.fn(() => ['model-a', 'model-b', 'model-c']),
  }));
  vi.doMock('../src/providers/local-discovery.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/local-discovery.js')
    >('../src/providers/local-discovery.js');
    return {
      ...actual,
      discoverAllLocalModels: vi.fn(async () => []),
      getLocalModelInfo: vi.fn(() => null),
    };
  });

  const { initDatabase, recordUsageEvent } = await import('../src/memory/db.ts');
  const { getGatewayAdminModels } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  recordUsageEvent({
    sessionId: 's-b',
    agentId: 'main',
    model: 'model-b',
    inputTokens: 600,
    outputTokens: 400,
    totalTokens: 1_000,
    toolCalls: 1,
    costUsd: 0.01,
  });
  recordUsageEvent({
    sessionId: 's-c',
    agentId: 'main',
    model: 'model-c',
    inputTokens: 300,
    outputTokens: 200,
    totalTokens: 500,
    toolCalls: 1,
    costUsd: 0.005,
  });

  const result = await getGatewayAdminModels();
  const ids = result.models.map((model) => model.id);

  expect(ids.indexOf('model-b')).toBeLessThan(ids.indexOf('model-c'));
  expect(ids.indexOf('model-c')).toBeLessThan(ids.indexOf('model-a'));
  expect(result.models.find((model) => model.id === 'model-b')?.usageMonthly)
    .toMatchObject({
      totalTokens: 1_000,
      callCount: 1,
    });
});
