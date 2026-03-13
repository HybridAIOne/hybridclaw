import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
const ORIGINAL_AUXILIARY_COMPRESSION_PROVIDER =
  process.env.AUXILIARY_COMPRESSION_PROVIDER;
const ORIGINAL_AUXILIARY_COMPRESSION_MODEL =
  process.env.AUXILIARY_COMPRESSION_MODEL;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-task-routing-'));
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

async function importFreshTaskRouting(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
  return import('../src/providers/task-routing.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../src/logger.js');
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar(
    'HYBRIDCLAW_DISABLE_CONFIG_WATCHER',
    ORIGINAL_DISABLE_CONFIG_WATCHER,
  );
  restoreEnvVar(
    'AUXILIARY_COMPRESSION_PROVIDER',
    ORIGINAL_AUXILIARY_COMPRESSION_PROVIDER,
  );
  restoreEnvVar(
    'AUXILIARY_COMPRESSION_MODEL',
    ORIGINAL_AUXILIARY_COMPRESSION_MODEL,
  );
});

test('resolves configured vision task model policy on the host', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir, (config) => {
    config.local.backends.lmstudio.enabled = true;
    config.local.backends.lmstudio.baseUrl = 'http://127.0.0.1:1234';
    config.auxiliaryModels.vision.model = 'lmstudio/qwen/qwen2.5-vl';
    config.auxiliaryModels.vision.maxTokens = 321;
    config.auxiliaryModels.compression.model = 'lmstudio/qwen/qwen2.5-instruct';
    config.auxiliaryModels.compression.maxTokens = 222;
    config.auxiliaryModels.web_extract.provider = 'lmstudio';
    config.auxiliaryModels.web_extract.model = 'qwen/qwen2.5-instruct';
    config.auxiliaryModels.web_extract.maxTokens = 210;
    config.auxiliaryModels.session_search.provider = 'lmstudio';
    config.auxiliaryModels.session_search.model = 'qwen/qwen2.5-instruct';
    config.auxiliaryModels.session_search.maxTokens = 211;
  });
  const taskRouting = await importFreshTaskRouting(homeDir);

  const taskModels = await taskRouting.resolveTaskModelPolicies({
    agentId: 'main',
    chatbotId: 'bot_123',
  });

  expect(taskModels).toMatchObject({
    vision: {
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234',
      apiKey: '',
      model: 'lmstudio/qwen/qwen2.5-vl',
      chatbotId: '',
      requestHeaders: {},
      isLocal: true,
      maxTokens: 321,
    },
    compression: {
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234',
      apiKey: '',
      model: 'lmstudio/qwen/qwen2.5-instruct',
      chatbotId: '',
      requestHeaders: {},
      isLocal: true,
      maxTokens: 222,
    },
    web_extract: {
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234',
      apiKey: '',
      model: 'lmstudio/qwen/qwen2.5-instruct',
      chatbotId: '',
      requestHeaders: {},
      isLocal: true,
      maxTokens: 210,
    },
    session_search: {
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234',
      apiKey: '',
      model: 'lmstudio/qwen/qwen2.5-instruct',
      chatbotId: '',
      requestHeaders: {},
      isLocal: true,
      maxTokens: 211,
    },
  });
});

test('prefers auxiliary env overrides for provider and model selection', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir, (config) => {
    config.local.backends.lmstudio.enabled = true;
    config.local.backends.lmstudio.baseUrl = 'http://127.0.0.1:1234';
    config.auxiliaryModels.compression.model = '';
    config.auxiliaryModels.compression.maxTokens = 222;
  });
  process.env.AUXILIARY_COMPRESSION_PROVIDER = 'lmstudio';
  process.env.AUXILIARY_COMPRESSION_MODEL = 'qwen/qwen2.5-instruct';

  const taskRouting = await importFreshTaskRouting(homeDir);
  const policy = await taskRouting.resolveTaskModelPolicy('compression', {
    agentId: 'main',
    chatbotId: 'bot_123',
  });

  expect(policy).toMatchObject({
    provider: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234',
    apiKey: '',
    model: 'lmstudio/qwen/qwen2.5-instruct',
    chatbotId: '',
    requestHeaders: {},
    isLocal: true,
    maxTokens: 222,
  });
});

test('captures env overrides at module load', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir, (config) => {
    config.local.backends.lmstudio.enabled = true;
    config.local.backends.lmstudio.baseUrl = 'http://127.0.0.1:1234';
    config.local.backends.ollama.enabled = true;
    config.local.backends.ollama.baseUrl = 'http://127.0.0.1:11434';
    config.auxiliaryModels.compression.model = '';
    config.auxiliaryModels.compression.maxTokens = 222;
  });
  process.env.AUXILIARY_COMPRESSION_PROVIDER = 'lmstudio';
  process.env.AUXILIARY_COMPRESSION_MODEL = 'qwen/qwen2.5-instruct';

  const taskRouting = await importFreshTaskRouting(homeDir);

  process.env.AUXILIARY_COMPRESSION_PROVIDER = 'ollama';
  process.env.AUXILIARY_COMPRESSION_MODEL = 'qwen2.5:latest';

  const policy = await taskRouting.resolveTaskModelPolicy('compression', {
    agentId: 'main',
    chatbotId: 'bot_123',
  });

  expect(policy).toMatchObject({
    provider: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234',
    model: 'lmstudio/qwen/qwen2.5-instruct',
    maxTokens: 222,
  });
});

test('captures unsupported vision task model config as a deferred policy error', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir, (config) => {
    config.auxiliaryModels.vision.model = 'anthropic/claude-3-7-sonnet';
    config.auxiliaryModels.vision.maxTokens = 512;
    config.auxiliaryModels.compression.model = 'anthropic/claude-3-7-sonnet';
    config.auxiliaryModels.compression.maxTokens = 256;
  });
  const taskRouting = await importFreshTaskRouting(homeDir);

  const taskModels = await taskRouting.resolveTaskModelPolicies({
    agentId: 'main',
    chatbotId: 'bot_123',
  });

  expect(taskModels).toMatchObject({
    vision: {
      model: 'anthropic/claude-3-7-sonnet',
      maxTokens: 512,
      error: expect.stringContaining(
        'Anthropic provider is not implemented yet',
      ),
    },
    compression: {
      model: 'anthropic/claude-3-7-sonnet',
      maxTokens: 256,
      error: expect.stringContaining(
        'Anthropic provider is not implemented yet',
      ),
    },
  });
});

test('warns when task model policy resolution fails and returns a deferred error', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir, (config) => {
    config.auxiliaryModels.vision.model = 'anthropic/claude-3-7-sonnet';
    config.auxiliaryModels.vision.maxTokens = 512;
  });
  const warn = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn,
    },
  }));

  const taskRouting = await importFreshTaskRouting(homeDir);
  const policy = await taskRouting.resolveTaskModelPolicy('vision', {
    agentId: 'main',
    chatbotId: 'bot_123',
  });

  expect(policy).toMatchObject({
    model: 'anthropic/claude-3-7-sonnet',
    maxTokens: 512,
    error: expect.stringContaining('Anthropic provider is not implemented yet'),
  });
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'vision',
      provider: 'auto',
      model: 'anthropic/claude-3-7-sonnet',
      err: expect.any(Error),
    }),
    'Failed to resolve auxiliary task model policy',
  );
});

test('normalizes max token values consistently', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir);
  const taskRouting = await importFreshTaskRouting(homeDir);

  expect(taskRouting.normalizeMaxTokens(42.9)).toBe(42);
  expect(taskRouting.normalizeMaxTokens(0)).toBeUndefined();
  expect(taskRouting.normalizeMaxTokens(undefined)).toBeUndefined();
  expect(taskRouting.normalizeMaxTokens('42')).toBeUndefined();
});
