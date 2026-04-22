import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;

const createTempDir = useTempDir();

const DAY_MS = 24 * 60 * 60 * 1000;
const recentIso = () => new Date(Date.now() - 5 * DAY_MS).toISOString();
const staleIso = () => new Date(Date.now() - 90 * DAY_MS).toISOString();

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

useCleanMocks({
  restoreAllMocks: true,
  cleanup: () => {
    restoreEnvVar('HOME', ORIGINAL_HOME);
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: ORIGINAL_STDIN_IS_TTY,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: ORIGINAL_STDOUT_IS_TTY,
    });
  },
  resetModules: true,
  unmock: ['node:child_process'],
});

test('runDoctor fixes insecure credentials permissions and reruns the check', async () => {
  const homeDir = createTempDir('hybridclaw-doctor-home-');
  process.env.HOME = homeDir;
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: false,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: false,
  });

  const credentialsPath = path.join(homeDir, '.hybridclaw', 'credentials.json');
  const runtimeSecrets = await import('../src/security/runtime-secrets.ts');
  runtimeSecrets.saveRuntimeSecrets({
    HYBRIDAI_API_KEY: 'hai-test-1234567890',
  });
  fs.chmodSync(credentialsPath, 0o644);

  const { runDoctor } = await import('../src/doctor.ts');
  const report = await runDoctor({
    component: 'credentials',
    fix: true,
    json: false,
  });

  expect(report.summary).toMatchObject({
    ok: 1,
    warn: 0,
    error: 0,
    exitCode: 0,
  });
  expect(report.results).toEqual([
    expect.objectContaining({
      label: 'Credentials',
      severity: 'ok',
      fixable: false,
    }),
  ]);
  expect(fs.statSync(credentialsPath).mode & 0o777).toBe(0o600);
});

test('checkConfig fixes world-readable config permissions to owner-only', async () => {
  const dir = createTempDir('hybridclaw-doctor-config-');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ version: 16, hybridai: { defaultModel: 'gpt-5-nano' }, ops: { dbPath: '/tmp/hybridclaw.db' }, container: { image: 'hybridclaw-agent' } }, null, 2)}\n`,
    'utf-8',
  );
  fs.chmodSync(configPath, 0o666);

  const actualRuntimeConfig = await import('../src/config/runtime-config.js');
  vi.doMock('../src/config/runtime-config.js', () => ({
    ...actualRuntimeConfig,
    CONFIG_VERSION: 16,
    ensureRuntimeConfigFile: vi.fn(),
    getRuntimeConfig: () => ({
      hybridai: { defaultModel: 'gpt-5-nano' },
      ops: { dbPath: '/tmp/hybridclaw.db' },
      container: { image: 'hybridclaw-agent' },
      tools: { disabled: [] },
      mcpServers: {},
    }),
    runtimeConfigPath: () => configPath,
  }));
  vi.doMock('../src/agent/tool-summary.js', () => ({
    listKnownToolNames: () => [],
  }));
  vi.doMock('../src/memory/db.js', () => ({
    getToolUsageSummary: () => [],
  }));

  const { checkConfig } = await import('../src/doctor/checks/config.ts');
  const [result] = await checkConfig();

  expect(result.severity).toBe('warn');
  expect(result.fix).toBeDefined();

  await result.fix?.apply();
  expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
});

test('checkConfig warns on unused tools and MCP servers and disables them with fixes', async () => {
  const dir = createTempDir('hybridclaw-doctor-config-usage-');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ version: 17, hybridai: { defaultModel: 'gpt-5-nano' }, ops: { dbPath: '/tmp/hybridclaw.db' }, container: { image: 'hybridclaw-agent' } }, null, 2)}\n`,
    'utf-8',
  );

  let runtimeConfigState = {
    hybridai: { defaultModel: 'gpt-5-nano' },
    ops: { dbPath: '/tmp/hybridclaw.db' },
    container: { image: 'hybridclaw-agent' },
    tools: { disabled: [] as string[] },
    mcpServers: {
      github: {
        transport: 'stdio' as const,
        command: 'node',
        args: ['github.js'],
      },
      slack: {
        transport: 'stdio' as const,
        command: 'node',
        args: ['slack.js'],
      },
    },
  };

  vi.doMock('../src/agent/tool-summary.js', () => ({
    listKnownToolNames: () => [
      'read',
      'browser_close',
      'browser_navigate',
      'image',
    ],
  }));
  vi.doMock('../src/config/runtime-config.js', () => ({
    CONFIG_VERSION: 17,
    ensureRuntimeConfigFile: vi.fn(),
    getRuntimeConfig: () => structuredClone(runtimeConfigState),
    getRuntimeDisabledToolNames: (config: {
      tools?: { disabled?: string[] };
    }) => new Set(config.tools?.disabled ?? []),
    runtimeConfigPath: () => configPath,
    setRuntimeToolEnabled: (
      draft: { tools: { disabled: string[] } },
      toolName: string,
      enabled: boolean,
    ) => {
      const nextDisabled = new Set(draft.tools.disabled);
      if (enabled) {
        nextDisabled.delete(toolName);
      } else {
        nextDisabled.add(toolName);
      }
      draft.tools.disabled = [...nextDisabled].sort((left, right) =>
        left.localeCompare(right),
      );
    },
    updateRuntimeConfig: (
      mutate: (
        draft: typeof runtimeConfigState & {
          tools: { disabled: string[] };
        },
      ) => void,
    ) => {
      const draft = structuredClone(runtimeConfigState);
      mutate(draft);
      runtimeConfigState = draft;
      return structuredClone(runtimeConfigState);
    },
  }));
  vi.doMock('../src/memory/db.js', () => ({
    getToolUsageSummary: () => [
      {
        toolName: 'read',
        callsSinceCutoff: 2,
        lastUsedAt: recentIso(),
      },
      {
        toolName: 'github__search',
        callsSinceCutoff: 1,
        lastUsedAt: recentIso(),
      },
    ],
  }));

  const { checkConfig } = await import('../src/doctor/checks/config.ts');
  const results = await checkConfig();

  expect(results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        label: 'Unused tools',
        severity: 'warn',
        message: expect.stringContaining('browser tools'),
      }),
      expect.objectContaining({
        label: 'Unused MCP servers',
        severity: 'warn',
        message: expect.stringContaining('slack'),
      }),
    ]),
  );

  const unusedTools = results.find((result) => result.label === 'Unused tools');
  const unusedMcpServers = results.find(
    (result) => result.label === 'Unused MCP servers',
  );
  expect(unusedTools?.message).not.toContain('browser_close');
  expect(unusedTools?.message).not.toContain('browser_navigate');
  await unusedTools?.fix?.apply();
  await unusedMcpServers?.fix?.apply();

  expect(runtimeConfigState.tools.disabled).toEqual([
    'browser_close',
    'browser_navigate',
    'image',
  ]);
  expect(runtimeConfigState.mcpServers.github.enabled).toBeUndefined();
  expect(runtimeConfigState.mcpServers.slack.enabled).toBe(false);
});

test('checkConfig does not flag a single unused browser subtool when other browser tools are active', async () => {
  const dir = createTempDir('hybridclaw-doctor-config-browser-partial-');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ version: 17, hybridai: { defaultModel: 'gpt-5-nano' }, ops: { dbPath: '/tmp/hybridclaw.db' }, container: { image: 'hybridclaw-agent' } }, null, 2)}\n`,
    'utf-8',
  );

  vi.doMock('../src/agent/tool-summary.js', () => ({
    listKnownToolNames: () => [
      'read',
      'browser_close',
      'browser_navigate',
      'web_extract',
    ],
  }));
  vi.doMock('../src/config/runtime-config.js', () => ({
    CONFIG_VERSION: 17,
    ensureRuntimeConfigFile: vi.fn(),
    getRuntimeConfig: () => ({
      hybridai: { defaultModel: 'gpt-5-nano' },
      ops: { dbPath: '/tmp/hybridclaw.db' },
      container: { image: 'hybridclaw-agent' },
      tools: { disabled: [] as string[] },
      mcpServers: {},
    }),
    getRuntimeDisabledToolNames: () => new Set<string>(),
    runtimeConfigPath: () => configPath,
    setRuntimeToolEnabled: vi.fn(),
    updateRuntimeConfig: vi.fn(),
  }));
  vi.doMock('../src/memory/db.js', () => ({
    getToolUsageSummary: () => [
      {
        toolName: 'read',
        callsSinceCutoff: 2,
        lastUsedAt: recentIso(),
      },
      {
        toolName: 'browser_navigate',
        callsSinceCutoff: 1,
        lastUsedAt: recentIso(),
      },
    ],
  }));

  const { checkConfig } = await import('../src/doctor/checks/config.ts');
  const results = await checkConfig();
  const unusedTools = results.find((result) => result.label === 'Unused tools');

  expect(unusedTools?.severity).toBe('warn');
  expect(unusedTools?.message).toContain('web_extract');
  expect(unusedTools?.message).not.toContain('browser tools');
  expect(unusedTools?.message).not.toContain('browser_close');
});

test('checkConfig describes a grouped browser warning as a toolset when singular', async () => {
  const dir = createTempDir('hybridclaw-doctor-config-browser-grouped-');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ version: 17, hybridai: { defaultModel: 'gpt-5-nano' }, ops: { dbPath: '/tmp/hybridclaw.db' }, container: { image: 'hybridclaw-agent' } }, null, 2)}\n`,
    'utf-8',
  );

  vi.doMock('../src/agent/tool-summary.js', () => ({
    listKnownToolNames: () => ['read', 'browser_close', 'browser_navigate'],
  }));
  vi.doMock('../src/config/runtime-config.js', () => ({
    CONFIG_VERSION: 17,
    ensureRuntimeConfigFile: vi.fn(),
    getRuntimeConfig: () => ({
      hybridai: { defaultModel: 'gpt-5-nano' },
      ops: { dbPath: '/tmp/hybridclaw.db' },
      container: { image: 'hybridclaw-agent' },
      tools: { disabled: [] as string[] },
      mcpServers: {},
    }),
    getRuntimeDisabledToolNames: () => new Set<string>(),
    runtimeConfigPath: () => configPath,
    setRuntimeToolEnabled: vi.fn(),
    updateRuntimeConfig: vi.fn(),
  }));
  vi.doMock('../src/memory/db.js', () => ({
    getToolUsageSummary: () => [
      {
        toolName: 'read',
        callsSinceCutoff: 2,
        lastUsedAt: recentIso(),
      },
    ],
  }));

  const { checkConfig } = await import('../src/doctor/checks/config.ts');
  const results = await checkConfig();
  const unusedTools = results.find((result) => result.label === 'Unused tools');

  expect(unusedTools?.severity).toBe('warn');
  expect(unusedTools?.message).toContain('1 enabled tool or toolset unused');
  expect(unusedTools?.message).toContain('browser tools');
});

test('checkConfigFile ignores unused tool and MCP hygiene warnings', async () => {
  const dir = createTempDir('hybridclaw-doctor-config-file-only-');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ version: 17, hybridai: { defaultModel: 'gpt-5-nano' }, ops: { dbPath: '/tmp/hybridclaw.db' }, container: { image: 'hybridclaw-agent' } }, null, 2)}\n`,
    'utf-8',
  );
  fs.chmodSync(configPath, 0o600);

  vi.doMock('../src/agent/tool-summary.js', () => ({
    listKnownToolNames: () => ['read', 'browser_navigate'],
  }));
  vi.doMock('../src/config/runtime-config.js', () => ({
    CONFIG_VERSION: 17,
    ensureRuntimeConfigFile: vi.fn(),
    getRuntimeConfig: () => ({
      hybridai: { defaultModel: 'gpt-5-nano' },
      ops: { dbPath: '/tmp/hybridclaw.db' },
      container: { image: 'hybridclaw-agent' },
      tools: { disabled: [] as string[] },
      mcpServers: {
        github: {
          transport: 'stdio' as const,
          command: 'node',
          args: ['github.js'],
        },
      },
    }),
    getRuntimeDisabledToolNames: () => new Set<string>(),
    runtimeConfigPath: () => configPath,
    setRuntimeToolEnabled: vi.fn(),
    updateRuntimeConfig: vi.fn(),
  }));
  vi.doMock('../src/memory/db.js', () => ({
    getToolUsageSummary: () => [
      {
        toolName: 'read',
        callsSinceCutoff: 1,
        lastUsedAt: recentIso(),
      },
    ],
  }));

  const { checkConfigFile } = await import('../src/doctor/checks/config.ts');
  const results = await checkConfigFile();

  expect(results).toEqual([
    expect.objectContaining({
      label: 'Config',
      severity: 'ok',
    }),
  ]);
});

test('checkProviders treats probe failures as provider health failures', async () => {
  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => ({
      hybridai: {
        defaultModel: 'gpt-5-nano',
        models: ['gpt-5'],
      },
      codex: {},
      openrouter: {
        enabled: false,
        models: [],
      },
    }),
  }));
  vi.doMock('../src/providers/factory.js', () => ({
    resolveModelProvider: () => 'hybridai',
  }));
  vi.doMock('../src/auth/codex-auth.js', () => ({
    getCodexAuthStatus: () => ({
      authenticated: false,
      reloginRequired: true,
    }),
  }));
  vi.doMock('../src/doctor/provider-probes.js', () => ({
    probeHybridAI: vi.fn(async () => {
      throw new Error('network down');
    }),
    probeCodex: vi.fn(),
    probeOpenRouter: vi.fn(),
  }));

  const { checkProviders } = await import('../src/doctor/checks/providers.ts');
  const [result] = await checkProviders();

  expect(result.severity).toBe('error');
  expect(result.message).toContain('HybridAI network down');
});

test('probeAnthropic sends bearer auth for OAuth tokens', async () => {
  vi.doUnmock('../src/doctor/provider-probes.js');
  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => ({
      ops: { logLevel: 'silent' },
    }),
    onRuntimeConfigChange: vi.fn(),
  }));
  vi.doMock('../src/config/config.js', () => ({
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
    ANTHROPIC_ENABLED: true,
    ANTHROPIC_METHOD: 'api-key',
    CODEX_BASE_URL: 'https://chatgpt.com/backend-api/codex',
    CONTAINER_SANDBOX_MODE: 'container',
    HUGGINGFACE_BASE_URL: 'https://router.huggingface.co/v1',
    HUGGINGFACE_ENABLED: false,
    MISTRAL_BASE_URL: 'https://api.mistral.ai/v1',
    MISTRAL_ENABLED: false,
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENROUTER_ENABLED: false,
  }));
  vi.doMock('../src/auth/anthropic-auth.js', () => ({
    requireAnthropicApiKey: vi.fn(() => ({
      method: 'api-key',
      source: 'env',
      apiKey: 'sk-ant-oat-doctor-test',
      headers: {
        'anthropic-version': '2023-06-01',
        'x-app': 'cli',
      },
      path: '/tmp/credentials.json',
    })),
    requireAnthropicClaudeCliCredential: vi.fn(),
  }));
  const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer sk-ant-oat-doctor-test',
      'anthropic-version': '2023-06-01',
      'x-app': 'cli',
    });
    expect(init?.headers).not.toHaveProperty('x-api-key');
    return new Response(JSON.stringify({ data: [{ id: 'claude' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const { probeAnthropic } = await import('../src/doctor/provider-probes.js');
  const result = await probeAnthropic();

  expect(result).toMatchObject({ reachable: true, modelCount: 1 });
});

test('probeAnthropic sends x-api-key auth for API keys', async () => {
  vi.doUnmock('../src/doctor/provider-probes.js');
  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => ({
      ops: { logLevel: 'silent' },
    }),
    onRuntimeConfigChange: vi.fn(),
  }));
  vi.doMock('../src/config/config.js', () => ({
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
    ANTHROPIC_ENABLED: true,
    ANTHROPIC_METHOD: 'api-key',
    CODEX_BASE_URL: 'https://chatgpt.com/backend-api/codex',
    CONTAINER_SANDBOX_MODE: 'container',
    HUGGINGFACE_BASE_URL: 'https://router.huggingface.co/v1',
    HUGGINGFACE_ENABLED: false,
    MISTRAL_BASE_URL: 'https://api.mistral.ai/v1',
    MISTRAL_ENABLED: false,
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENROUTER_ENABLED: false,
  }));
  vi.doMock('../src/auth/anthropic-auth.js', () => ({
    requireAnthropicApiKey: vi.fn(() => ({
      method: 'api-key',
      source: 'env',
      apiKey: 'sk-ant-api03-doctor-test',
      headers: {
        'anthropic-version': '2023-06-01',
      },
      path: '/tmp/credentials.json',
    })),
    requireAnthropicClaudeCliCredential: vi.fn(),
  }));
  const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({
      'x-api-key': 'sk-ant-api03-doctor-test',
      'anthropic-version': '2023-06-01',
    });
    expect(init?.headers).not.toHaveProperty('Authorization');
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const { probeAnthropic } = await import('../src/doctor/provider-probes.js');
  const result = await probeAnthropic();

  expect(result).toMatchObject({ reachable: true, modelCount: 0 });
});

test('checkDatabase reports a stale schema as warn with a migration fix', async () => {
  const dir = createTempDir('hybridclaw-doctor-db-');
  const dbPath = path.join(dir, 'hybridclaw.db');
  const database = new Database(dbPath);
  database.pragma('user_version = 11');
  database.close();

  const initDatabase = vi.fn();
  vi.doMock('../src/config/config.js', () => ({
    DB_PATH: dbPath,
  }));
  vi.doMock('../src/memory/db.js', () => ({
    DATABASE_SCHEMA_VERSION: 12,
    initDatabase,
  }));

  const { checkDatabase } = await import('../src/doctor/checks/database.ts');
  const [result] = await checkDatabase();

  expect(result.severity).toBe('warn');
  expect(result.message).toContain('migration available to v12');
  expect(result.fix).toBeDefined();

  await result.fix?.apply();
  expect(initDatabase).toHaveBeenCalledWith({ quiet: true, dbPath });
});

test('checkDatabase reports an unwritable database as error', async () => {
  const dir = createTempDir('hybridclaw-doctor-db-');
  const dbPath = path.join(dir, 'hybridclaw.db');
  const database = new Database(dbPath);
  database.pragma('user_version = 12');
  database.close();
  fs.chmodSync(dbPath, 0o444);

  vi.doMock('../src/config/config.js', () => ({
    DB_PATH: dbPath,
  }));
  vi.doMock('../src/memory/db.js', () => ({
    DATABASE_SCHEMA_VERSION: 12,
    initDatabase: vi.fn(),
  }));

  const { checkDatabase } = await import('../src/doctor/checks/database.ts');
  const [result] = await checkDatabase();

  expect(result.severity).toBe('error');
  expect(result.message).toContain('file is not writable');
  expect(result.fix).toBeUndefined();
});

test('checkGateway exposes a restart fix when the PID is alive but the API is unreachable', async () => {
  const restartGatewayFromDoctor = vi.fn(async () => {});

  vi.doMock('../src/gateway/gateway-client.js', () => ({
    gatewayHealth: vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }),
  }));
  vi.doMock('../src/gateway/gateway-lifecycle.js', () => ({
    readGatewayPid: () => ({
      pid: 12345,
      startedAt: '2026-03-17T10:00:00.000Z',
      cwd: '/tmp/hybridclaw-doctor',
      command: ['node', 'dist/cli.js', 'gateway'],
    }),
    isPidRunning: () => true,
    removeGatewayPidFile: vi.fn(),
  }));
  vi.doMock('../src/doctor/gateway-repair.js', () => ({
    restartGatewayFromDoctor,
  }));

  const { checkGateway } = await import('../src/doctor/checks/gateway.ts');
  const [result] = await checkGateway();

  expect(result.severity).toBe('error');
  expect(result.fix?.summary).toContain('restart');

  await result.fix?.apply();
  expect(restartGatewayFromDoctor).toHaveBeenCalledTimes(1);
});

test('checkDisk warns when free space cannot be determined', async () => {
  const dir = createTempDir('hybridclaw-doctor-disk-');
  const dbPath = path.join(dir, 'hybridclaw.db');
  fs.writeFileSync(dbPath, 'db', 'utf-8');

  vi.doMock('../src/config/config.js', () => ({
    DATA_DIR: dir,
    DB_PATH: dbPath,
  }));
  vi.spyOn(fs, 'statfsSync').mockImplementation(() => {
    throw new Error('unsupported');
  });

  const { checkDisk } = await import('../src/doctor/checks/disk.ts');
  const [result] = await checkDisk();

  expect(result.severity).toBe('warn');
  expect(result.message).toContain('free space unavailable');
  expect(result.message).toContain('DB 2 B');
});

test('readDirSize skips unreadable entries and symlink loops', async () => {
  const dir = createTempDir('hybridclaw-doctor-size-');
  fs.writeFileSync(path.join(dir, 'good.txt'), 'good', 'utf-8');
  fs.writeFileSync(path.join(dir, 'bad.txt'), 'bad', 'utf-8');
  fs.symlinkSync('.', path.join(dir, 'loop'));

  type LstatArgs = Parameters<typeof fs.lstatSync>;
  const originalLstatSync = fs.lstatSync.bind(fs) as (
    ...args: LstatArgs
  ) => ReturnType<typeof fs.lstatSync>;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((
    filePath: LstatArgs[0],
    options?: LstatArgs[1],
  ) => {
    if (String(filePath).endsWith('bad.txt')) {
      throw new Error('permission denied');
    }
    return originalLstatSync(filePath, options as LstatArgs[1]);
  }) as never);

  const { readDirSize } = await import('../src/doctor/utils.ts');

  expect(readDirSize(dir)).toBe(4);
});

test('checkDocker only reports daemon and image state', async () => {
  vi.doMock('../src/config/config.js', () => ({
    CONTAINER_IMAGE: 'hybridclaw-agent',
    getResolvedSandboxMode: () => 'container',
  }));
  const updateRuntimeConfig = vi.fn();
  vi.doMock('../src/config/runtime-config.js', () => ({
    isContainerSandboxModeExplicit: () => true,
    updateRuntimeConfig,
  }));
  vi.doMock('../src/infra/container-setup.js', () => ({
    containerImageExists: vi.fn(async () => true),
    ensureContainerImageReady: vi.fn(),
    probeDockerAccess: vi.fn(async () => ({
      ready: true,
      kind: 'ready',
      detail: '',
    })),
  }));
  vi.doMock('../src/infra/install-root.js', () => ({
    resolveInstallRoot: () => '/tmp/hybridclaw-doctor',
  }));

  const { checkDocker } = await import('../src/doctor/checks/docker.ts');
  const [result] = await checkDocker();

  expect(result.severity).toBe('ok');
  expect(result.message).toBe('Daemon running, image hybridclaw-agent present');
  expect(result.message).not.toContain('free');
});

test('checkDocker errors when configured sandbox requires Docker and Docker is missing', async () => {
  vi.doMock('../src/config/config.js', () => ({
    CONTAINER_IMAGE: 'hybridclaw-agent',
    getResolvedSandboxMode: () => 'container',
  }));
  const updateRuntimeConfig = vi.fn();
  vi.doMock('../src/config/runtime-config.js', () => ({
    isContainerSandboxModeExplicit: () => true,
    updateRuntimeConfig,
  }));
  vi.doMock('../src/infra/container-setup.js', () => ({
    containerImageExists: vi.fn(async () => false),
    ensureContainerImageReady: vi.fn(),
    probeDockerAccess: vi.fn(async () => ({
      ready: false,
      kind: 'missing',
      detail: 'spawn docker ENOENT',
    })),
  }));
  vi.doMock('../src/infra/install-root.js', () => ({
    resolveInstallRoot: () => '/tmp/hybridclaw-doctor',
  }));

  const { checkDocker } = await import('../src/doctor/checks/docker.ts');
  const [result] = await checkDocker();

  expect(result.severity).toBe('error');
  expect(result.message).toContain('Docker unavailable');
  expect(result.message).toContain('sandbox mode `container` requires Docker');
  expect(result.message).toContain('set `container.sandboxMode` to `host`');
});

test('checkDocker only warns when sandbox is host and Docker is missing', async () => {
  vi.doMock('../src/config/config.js', () => ({
    CONTAINER_IMAGE: 'hybridclaw-agent',
    getResolvedSandboxMode: () => 'host',
  }));
  const updateRuntimeConfig = vi.fn();
  vi.doMock('../src/config/runtime-config.js', () => ({
    isContainerSandboxModeExplicit: () => true,
    updateRuntimeConfig,
  }));
  vi.doMock('../src/infra/container-setup.js', () => ({
    containerImageExists: vi.fn(async () => false),
    ensureContainerImageReady: vi.fn(),
    probeDockerAccess: vi.fn(async () => ({
      ready: false,
      kind: 'missing',
      detail: 'spawn docker ENOENT',
    })),
  }));
  vi.doMock('../src/infra/install-root.js', () => ({
    resolveInstallRoot: () => '/tmp/hybridclaw-doctor',
  }));

  const { checkDocker } = await import('../src/doctor/checks/docker.ts');
  const [result] = await checkDocker();

  expect(result.severity).toBe('warn');
  expect(result.message).toBe('Docker unavailable (spawn docker ENOENT)');
});

test('checkDocker reports permission denied and offers a host-mode fix when sandbox mode is implicit', async () => {
  vi.doMock('../src/config/config.js', () => ({
    CONTAINER_IMAGE: 'hybridclaw-agent',
    getResolvedSandboxMode: () => 'container',
  }));
  const updateRuntimeConfig = vi.fn();
  vi.doMock('../src/config/runtime-config.js', () => ({
    isContainerSandboxModeExplicit: () => false,
    updateRuntimeConfig,
  }));
  vi.doMock('../src/infra/container-setup.js', () => ({
    containerImageExists: vi.fn(async () => false),
    ensureContainerImageReady: vi.fn(),
    probeDockerAccess: vi.fn(async () => ({
      ready: false,
      kind: 'permission-denied',
      detail:
        'permission denied while trying to connect to the Docker daemon socket',
    })),
  }));
  vi.doMock('../src/infra/install-root.js', () => ({
    resolveInstallRoot: () => '/tmp/hybridclaw-doctor',
  }));

  const { checkDocker } = await import('../src/doctor/checks/docker.ts');
  const [result] = await checkDocker();

  expect(result.severity).toBe('error');
  expect(result.message).toContain('cannot access the Docker daemon');
  expect(result.message).toContain('`docker` group');
  expect(result.fix?.summary).toBe('Switch runtime sandbox mode to host');

  await result.fix?.apply();
  expect(updateRuntimeConfig).toHaveBeenCalledTimes(1);
});

test('restartGatewayFromDoctor configures a bounded spawn timeout', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src', 'doctor', 'gateway-repair.ts'),
    'utf-8',
  );

  expect(source).toContain('timeout: 30_000');
});

test('checkSecurity does not offer an auto-fix for modified instruction copies', async () => {
  const dataDir = createTempDir('hybridclaw-doctor-security-');

  vi.doMock('../src/config/config.js', () => ({
    DATA_DIR: dataDir,
  }));
  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => ({}),
    isSecurityTrustAccepted: () => true,
  }));
  vi.doMock('../src/security/instruction-integrity.js', () => ({
    summarizeInstructionIntegrity: () => 'SECURITY.md:modified',
    syncRuntimeInstructionCopies: vi.fn(),
    verifyInstructionIntegrity: () => ({
      ok: false,
      files: [
        {
          path: 'SECURITY.md',
          sourcePath: '/repo/SECURITY.md',
          runtimePath: '/tmp/runtime/SECURITY.md',
          expectedHash: 'expected',
          actualHash: 'actual',
          status: 'modified',
        },
      ],
    }),
  }));

  const { checkSecurity } = await import('../src/doctor/checks/security.ts');
  const [result] = await checkSecurity();

  expect(result.severity).toBe('warn');
  expect(result.message).toContain('SECURITY.md:modified');
  expect(result.fix).toBeUndefined();
});

test('checkSkills warns on enabled caution skills and disables them with fix', async () => {
  const disabledSkills = new Set<string>();

  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => ({
      skills: {
        disabled: [...disabledSkills],
      },
    }),
    setRuntimeSkillScopeEnabled: (
      draft: { skills: { disabled: string[] } },
      skillName: string,
      enabled: boolean,
    ) => {
      const nextDisabled = new Set(draft.skills.disabled);
      if (enabled) {
        nextDisabled.delete(skillName);
      } else {
        nextDisabled.add(skillName);
      }
      draft.skills.disabled = [...nextDisabled].sort((left, right) =>
        left.localeCompare(right),
      );
    },
    updateRuntimeConfig: (
      mutate: (draft: { skills: { disabled: string[] } }) => void,
    ) => {
      const draft = {
        skills: {
          disabled: [...disabledSkills],
        },
      };
      mutate(draft);
      disabledSkills.clear();
      for (const skillName of draft.skills.disabled) {
        disabledSkills.add(skillName);
      }
      return draft;
    },
  }));
  vi.doMock('../src/skills/skills.js', () => ({
    loadSkillCatalog: () => [
      {
        name: 'workspace-risk',
        description: 'Workspace skill with a suspicious pattern',
        category: 'security',
        userInvocable: false,
        disableModelInvocation: false,
        always: false,
        requires: {
          bins: [],
          env: [],
        },
        metadata: {
          hybridclaw: {
            tags: [],
            relatedSkills: [],
            install: [],
          },
        },
        filePath: '/tmp/workspace-risk/SKILL.md',
        baseDir: '/tmp/workspace-risk',
        source: 'workspace',
        available: true,
        enabled: true,
        missing: [],
      },
      {
        name: 'safe-skill',
        description: 'Safe skill',
        category: 'misc',
        userInvocable: false,
        disableModelInvocation: false,
        always: false,
        requires: {
          bins: [],
          env: [],
        },
        metadata: {
          hybridclaw: {
            tags: [],
            relatedSkills: [],
            install: [],
          },
        },
        filePath: '/tmp/safe-skill/SKILL.md',
        baseDir: '/tmp/safe-skill',
        source: 'workspace',
        available: true,
        enabled: true,
        missing: [],
      },
    ],
  }));
  vi.doMock('../src/memory/db.js', () => ({
    getSessionCount: () => 0,
    getSkillObservationSummary: () => [],
  }));
  vi.doMock('../src/skills/skills-guard.js', () => ({
    guardSkillDirectory: ({ skillName }: { skillName: string }) => ({
      allowed: true,
      reason: 'allowed for test',
      result: {
        skillName,
        skillPath: `/tmp/${skillName}`,
        sourceTag: 'workspace',
        trustLevel: 'workspace',
        verdict: skillName === 'workspace-risk' ? 'caution' : 'safe',
        findings:
          skillName === 'workspace-risk'
            ? [
                {
                  patternId: 'shell_rc_mod',
                  severity: 'medium',
                  category: 'persistence',
                  file: 'SKILL.md',
                  line: 7,
                  match: '.zshrc',
                  description: 'references shell startup file',
                },
              ]
            : [],
        scannedAt: '2026-03-17T10:00:00.000Z',
        summary: `${skillName} summary`,
        fromCache: false,
      },
    }),
  }));

  const { checkSkills } = await import('../src/doctor/checks/skills.ts');
  const [result] = await checkSkills();

  expect(result.severity).toBe('warn');
  expect(result.message).toContain('workspace-risk');
  expect(result.fix?.summary).toContain('Disable flagged skills');
  expect(disabledSkills.size).toBe(0);

  await result.fix?.apply();
  expect(disabledSkills.has('workspace-risk')).toBe(true);

  await result.fix?.rollback?.();
  expect(disabledSkills.has('workspace-risk')).toBe(false);
});

test('checkSkills warns on enabled skills unused in the last 30 days', async () => {
  const disabledSkills = new Set<string>();

  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => ({
      skills: {
        disabled: [...disabledSkills],
      },
    }),
    setRuntimeSkillScopeEnabled: (
      draft: { skills: { disabled: string[] } },
      skillName: string,
      enabled: boolean,
    ) => {
      const nextDisabled = new Set(draft.skills.disabled);
      if (enabled) {
        nextDisabled.delete(skillName);
      } else {
        nextDisabled.add(skillName);
      }
      draft.skills.disabled = [...nextDisabled].sort((left, right) =>
        left.localeCompare(right),
      );
    },
    updateRuntimeConfig: (
      mutate: (draft: { skills: { disabled: string[] } }) => void,
    ) => {
      const draft = {
        skills: {
          disabled: [...disabledSkills],
        },
      };
      mutate(draft);
      disabledSkills.clear();
      for (const skillName of draft.skills.disabled) {
        disabledSkills.add(skillName);
      }
      return draft;
    },
  }));
  vi.doMock('../src/memory/db.js', () => ({
    getSessionCount: () => 1,
    getSkillObservationSummary: () => [
      {
        skill_name: 'fresh-skill',
        total_executions: 3,
        success_count: 3,
        failure_count: 0,
        partial_count: 0,
        avg_duration_ms: 12,
        tool_calls_attempted: 3,
        tool_calls_failed: 0,
        positive_feedback_count: 0,
        negative_feedback_count: 0,
        error_clusters: [],
        last_observed_at: recentIso(),
      },
      {
        skill_name: 'stale-skill',
        total_executions: 1,
        success_count: 1,
        failure_count: 0,
        partial_count: 0,
        avg_duration_ms: 12,
        tool_calls_attempted: 1,
        tool_calls_failed: 0,
        positive_feedback_count: 0,
        negative_feedback_count: 0,
        error_clusters: [],
        last_observed_at: staleIso(),
      },
    ],
  }));
  vi.doMock('../src/skills/skills.js', () => ({
    loadSkillCatalog: () => [
      {
        name: 'fresh-skill',
        description: 'Recently used',
        category: 'misc',
        userInvocable: false,
        disableModelInvocation: false,
        always: false,
        requires: {
          bins: [],
          env: [],
        },
        metadata: {
          hybridclaw: {
            tags: [],
            relatedSkills: [],
            install: [],
          },
        },
        filePath: '/tmp/fresh-skill/SKILL.md',
        baseDir: '/tmp/fresh-skill',
        source: 'workspace',
        available: true,
        enabled: true,
        missing: [],
      },
      {
        name: 'stale-skill',
        description: 'Used long ago',
        category: 'misc',
        userInvocable: false,
        disableModelInvocation: false,
        always: false,
        requires: {
          bins: [],
          env: [],
        },
        metadata: {
          hybridclaw: {
            tags: [],
            relatedSkills: [],
            install: [],
          },
        },
        filePath: '/tmp/stale-skill/SKILL.md',
        baseDir: '/tmp/stale-skill',
        source: 'workspace',
        available: true,
        enabled: true,
        missing: [],
      },
    ],
  }));
  vi.doMock('../src/skills/skills-guard.js', () => ({
    guardSkillDirectory: () => ({
      allowed: true,
      result: {
        verdict: 'safe',
        findings: [],
      },
    }),
  }));

  const { checkSkills } = await import('../src/doctor/checks/skills.ts');
  const results = await checkSkills();
  const unusedSkills = results.find(
    (result) => result.label === 'Unused skills',
  );

  expect(unusedSkills?.severity).toBe('warn');
  expect(unusedSkills?.message).toContain('stale-skill');

  await unusedSkills?.fix?.apply();
  expect(disabledSkills).toEqual(new Set(['stale-skill']));
});

test('checkSkills warns on enabled skills with zero observations after sessions exist', async () => {
  const disabledSkills = new Set<string>();

  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => ({
      skills: {
        disabled: [...disabledSkills],
      },
    }),
    setRuntimeSkillScopeEnabled: (
      draft: { skills: { disabled: string[] } },
      skillName: string,
      enabled: boolean,
    ) => {
      const nextDisabled = new Set(draft.skills.disabled);
      if (enabled) {
        nextDisabled.delete(skillName);
      } else {
        nextDisabled.add(skillName);
      }
      draft.skills.disabled = [...nextDisabled].sort((left, right) =>
        left.localeCompare(right),
      );
    },
    updateRuntimeConfig: (
      mutate: (draft: { skills: { disabled: string[] } }) => void,
    ) => {
      const draft = {
        skills: {
          disabled: [...disabledSkills],
        },
      };
      mutate(draft);
      disabledSkills.clear();
      for (const skillName of draft.skills.disabled) {
        disabledSkills.add(skillName);
      }
      return draft;
    },
  }));
  vi.doMock('../src/memory/db.js', () => ({
    getSessionCount: () => 1,
    getSkillObservationSummary: () => [],
  }));
  vi.doMock('../src/skills/skills.js', () => ({
    loadSkillCatalog: () => [
      {
        name: 'never-observed',
        description: 'Never observed',
        category: 'misc',
        userInvocable: false,
        disableModelInvocation: false,
        always: false,
        requires: {
          bins: [],
          env: [],
        },
        metadata: {
          hybridclaw: {
            tags: [],
            relatedSkills: [],
            install: [],
          },
        },
        filePath: '/tmp/never-observed/SKILL.md',
        baseDir: '/tmp/never-observed',
        source: 'workspace',
        available: true,
        enabled: true,
        missing: [],
      },
    ],
  }));
  vi.doMock('../src/skills/skills-guard.js', () => ({
    guardSkillDirectory: () => ({
      allowed: true,
      result: {
        verdict: 'safe',
        findings: [],
      },
    }),
  }));

  const { checkSkills } = await import('../src/doctor/checks/skills.ts');
  const results = await checkSkills();
  const unusedSkills = results.find(
    (result) => result.label === 'Unused skills',
  );

  expect(unusedSkills?.severity).toBe('warn');
  expect(unusedSkills?.message).toContain('never-observed');
  expect(unusedSkills?.message).toContain('last used never');

  await unusedSkills?.fix?.apply();
  expect(disabledSkills).toEqual(new Set(['never-observed']));
});

test('checkChannels distinguishes intentionally disabled channels from missing setup', async () => {
  vi.doMock('../src/config/config.js', () => ({
    DISCORD_TOKEN: '',
    EMAIL_PASSWORD: '',
    MSTEAMS_APP_ID: '',
    MSTEAMS_APP_PASSWORD: '',
    getConfigSnapshot: () => ({
      discord: {
        guilds: {},
      },
      msteams: {
        enabled: false,
      },
      email: {
        enabled: false,
      },
      whatsapp: {
        dmPolicy: 'disabled',
        groupPolicy: 'disabled',
      },
    }),
  }));
  vi.doMock('../src/channels/whatsapp/auth.js', () => ({
    getWhatsAppAuthStatus: vi.fn(async () => ({
      linked: false,
    })),
  }));

  const { checkChannels } = await import('../src/doctor/checks/channels.ts');
  const [result] = await checkChannels();

  expect(result.severity).toBe('ok');
  expect(result.message).toContain('intentionally disabled');
});

test('runDoctor rolls back prior fixes and skips later fixes after a failure', async () => {
  const applyConfigFix = vi.fn(async () => {});
  const rollbackConfigFix = vi.fn(async () => {});
  const applyDatabaseFix = vi.fn(async () => {
    throw new Error('migration failed');
  });
  const applyDockerFix = vi.fn(async () => {});

  vi.doMock('../src/doctor/checks/index.js', () => ({
    doctorChecks: () => [
      {
        category: 'config',
        label: 'Config',
        run: async () => [
          {
            category: 'config',
            label: 'Config',
            severity: 'warn',
            message: 'Config needs chmod',
            fix: {
              summary: 'Restrict config permissions',
              apply: applyConfigFix,
              rollback: rollbackConfigFix,
            },
          },
        ],
      },
      {
        category: 'database',
        label: 'Database',
        run: async () => [
          {
            category: 'database',
            label: 'Database',
            severity: 'warn',
            message: 'Schema migration available',
            fix: {
              summary: 'Run database migration',
              apply: applyDatabaseFix,
            },
          },
        ],
      },
      {
        category: 'docker',
        label: 'Docker',
        run: async () => [
          {
            category: 'docker',
            label: 'Docker',
            severity: 'warn',
            message: 'Image missing',
            fix: {
              summary: 'Build container image',
              apply: applyDockerFix,
            },
          },
        ],
      },
    ],
  }));

  const { runDoctor } = await import('../src/doctor.ts');
  const report = await runDoctor({
    component: null,
    fix: true,
    json: false,
  });

  expect(applyConfigFix).toHaveBeenCalledTimes(1);
  expect(rollbackConfigFix).toHaveBeenCalledTimes(1);
  expect(applyDatabaseFix).toHaveBeenCalledTimes(1);
  expect(applyDockerFix).not.toHaveBeenCalled();
  expect(report.fixes).toEqual([
    {
      category: 'config',
      label: 'Config',
      status: 'applied',
      message: 'Restrict config permissions',
    },
    {
      category: 'database',
      label: 'Database',
      status: 'failed',
      message: 'migration failed',
    },
    {
      category: 'config',
      label: 'Config',
      status: 'rolled_back',
      message: 'Rolled back after a later fix failed',
    },
    {
      category: 'docker',
      label: 'Docker',
      status: 'skipped',
      message: 'Skipped after previous fix failure',
    },
  ]);
});

test('renderDoctorReport prints the summary and applied fixes', async () => {
  const { renderDoctorReport } = await import('../src/doctor.ts');
  const output = renderDoctorReport({
    generatedAt: '2026-03-17T10:00:00.000Z',
    component: null,
    results: [
      {
        category: 'gateway',
        label: 'Gateway',
        severity: 'ok',
        message: 'PID 12345, uptime 2h 34m, 3 sessions',
        fixable: false,
      },
      {
        category: 'docker',
        label: 'Docker',
        severity: 'warn',
        message:
          'Image hybridclaw-agent not found locally; run: npm run build:container',
        fixable: true,
      },
    ],
    summary: {
      ok: 1,
      warn: 1,
      error: 0,
      exitCode: 0,
    },
    fixes: [
      {
        category: 'docker',
        label: 'Docker',
        status: 'applied',
        message: 'Applied fix for docker',
      },
      {
        category: 'gateway',
        label: 'Gateway',
        status: 'rolled_back',
        message: 'Rolled back after a later fix failed',
      },
      {
        category: 'database',
        label: 'Database',
        status: 'rollback_failed',
        message: 'Rollback failed',
      },
    ],
  });

  expect(output).toContain('HybridClaw Doctor');
  expect(output).toContain('✓ Gateway');
  expect(output).toContain('⚠ Docker');
  expect(output).toContain('✓ Fix Docker');
  expect(output).not.toContain('Rolled back after a later fix failed');
  expect(output).not.toContain('Rollback failed');
  expect(output).toContain('1 ok · 1 warning · 0 errors');
});

test('normalizeComponent keeps the minimal doctor aliases', async () => {
  const { normalizeComponent } = await import('../src/doctor/utils.ts');

  expect(normalizeComponent('local-backends')).toBe('local-backends');
  expect(normalizeComponent('backends')).toBe('local-backends');
  expect(normalizeComponent('db')).toBe('database');
  expect(normalizeComponent('creds')).toBe('credentials');
  expect(normalizeComponent('container')).toBe('docker');

  expect(normalizeComponent('backend')).toBeNull();
  expect(normalizeComponent('local')).toBeNull();
  expect(normalizeComponent('localbackends')).toBeNull();
  expect(normalizeComponent('secrets')).toBeNull();
  expect(normalizeComponent('storage')).toBeNull();
});
