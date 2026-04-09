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
const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

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
  vi.doUnmock('../src/providers/factory.js');
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
  restoreEnvVar('OPENROUTER_API_KEY', ORIGINAL_OPENROUTER_API_KEY);
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
    },
    compression: {
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234',
      apiKey: '',
      model: 'lmstudio/qwen/qwen2.5-instruct',
      chatbotId: '',
      requestHeaders: {},
      isLocal: true,
    },
    web_extract: {
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234',
      apiKey: '',
      model: 'lmstudio/qwen/qwen2.5-instruct',
      chatbotId: '',
      requestHeaders: {},
      isLocal: true,
    },
    session_search: {
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234',
      apiKey: '',
      model: 'lmstudio/qwen/qwen2.5-instruct',
      chatbotId: '',
      requestHeaders: {},
      isLocal: true,
    },
  });
  expect(taskModels?.vision?.maxTokens).toBeUndefined();
  expect(taskModels?.compression?.maxTokens).toBeUndefined();
  expect(taskModels?.web_extract?.maxTokens).toBeUndefined();
  expect(taskModels?.session_search?.maxTokens).toBeUndefined();
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
  });
  expect(policy?.maxTokens).toBeUndefined();
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
  });
  expect(policy?.maxTokens).toBeUndefined();
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

test('discovers OpenRouter vision models before choosing a fallback on cold start', async () => {
  const homeDir = makeTempHome();
  process.env.OPENROUTER_API_KEY = 'or-task-routing-test';
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = true;
    config.openrouter.models = [];
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
    config.auxiliaryModels.vision.model = '';
    config.auxiliaryModels.vision.provider = 'auto';
    config.auxiliaryModels.vision.maxTokens = 654;
  });

  const fetchMock = vi.fn(async (input: string) => {
    if (input.endsWith('/models')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'acme/text-only',
              architecture: { modality: 'text->text' },
            },
            {
              id: 'zeus/vision-chat',
              architecture: { modality: 'text+image->text' },
              context_length: 262_144,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected URL: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const taskRouting = await importFreshTaskRouting(homeDir);
  const policy = await taskRouting.resolveTaskModelPolicy('vision', {
    agentId: 'main',
    sessionModel: 'openrouter/acme/text-only',
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(policy).toMatchObject({
    provider: 'openrouter',
    apiKey: 'or-task-routing-test',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/zeus/vision-chat',
    chatbotId: '',
    requestHeaders: {
      'HTTP-Referer': 'https://github.com/hybridaione/hybridclaw',
      'X-OpenRouter-Title': 'HybridClaw',
      'X-OpenRouter-Categories': 'cli-agent,general-chat',
      'X-Title': 'HybridClaw',
    },
    isLocal: false,
    contextWindow: 262_144,
  });
});

test('uses discovered OpenRouter Anthropic max tokens instead of configured task max tokens', async () => {
  const homeDir = makeTempHome();
  process.env.OPENROUTER_API_KEY = 'or-task-routing-test';
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = true;
    config.openrouter.models = ['openrouter/anthropic/claude-sonnet-4'];
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
    config.auxiliaryModels.compression.provider = 'openrouter';
    config.auxiliaryModels.compression.model = 'anthropic/claude-sonnet-4';
    config.auxiliaryModels.compression.maxTokens = 222;
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'anthropic/claude-sonnet-4',
                context_length: 262_144,
                top_provider: {
                  max_completion_tokens: 64_000,
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${input}`);
    }),
  );

  const taskRouting = await importFreshTaskRouting(homeDir);
  const policy = await taskRouting.resolveTaskModelPolicy('compression', {
    agentId: 'main',
  });

  expect(policy).toMatchObject({
    provider: 'openrouter',
    model: 'openrouter/anthropic/claude-sonnet-4',
    contextWindow: 262_144,
    maxTokens: 64_000,
  });
});

test('omits max tokens for non-Anthropic HybridAI task models', async () => {
  const homeDir = makeTempHome();
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  writeRuntimeConfig(homeDir, (config) => {
    config.auxiliaryModels.compression.provider = 'hybridai';
    config.auxiliaryModels.compression.model = 'gpt-5-nano';
    config.auxiliaryModels.compression.maxTokens = 222;
  });

  vi.doMock('../src/providers/factory.js', () => ({
    resolveModelRuntimeCredentials: vi.fn(async () => ({
      provider: 'hybridai' as const,
      apiKey: 'test-key',
      baseUrl: 'https://api.hybridai.example',
      chatbotId: 'bot_123',
      enableRag: false,
      requestHeaders: {},
      agentId: 'main',
      maxTokens: 999,
    })),
  }));

  const taskRouting = await importFreshTaskRouting(homeDir);
  const policy = await taskRouting.resolveTaskModelPolicy('compression', {
    agentId: 'main',
    chatbotId: 'bot_123',
  });

  expect(policy).toMatchObject({
    provider: 'hybridai',
    model: 'gpt-5-nano',
  });
  expect(policy?.maxTokens).toBeUndefined();
});

test('warns when no vision fallback is available after OpenRouter discovery refresh', async () => {
  const homeDir = makeTempHome();
  process.env.OPENROUTER_API_KEY = 'or-task-routing-test';
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = true;
    config.openrouter.models = ['openrouter/acme/text-only'];
    config.hybridai.defaultModel = 'gpt-5-nano';
    config.hybridai.models = ['gpt-5-nano'];
    config.codex.models = ['openai-codex/gpt-5.3-codex-spark'];
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
    config.auxiliaryModels.vision.model = '';
    config.auxiliaryModels.vision.provider = 'auto';
  });

  const warn = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn,
      info: vi.fn(),
    },
  }));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'acme/text-only',
                architecture: { modality: 'text->text' },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${input}`);
    }),
  );

  const taskRouting = await importFreshTaskRouting(homeDir);
  const policy = await taskRouting.resolveTaskModelPolicy('vision', {
    agentId: 'main',
    sessionModel: 'openrouter/acme/text-only',
  });

  expect(policy).toMatchObject({
    provider: 'openrouter',
    model: 'openrouter/acme/text-only',
    error:
      'Session model "openrouter/acme/text-only" does not support vision/image inputs, and no vision-capable fallback model is available.',
  });
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'vision',
      sessionModel: 'openrouter/acme/text-only',
      openrouterDiscoveredModels: 1,
    }),
    'Session model lacks vision support and no capable fallback model is available',
  );
});

test('returns a deferred policy error when fallback credential resolution fails', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = false;
    config.hybridai.defaultModel = 'gpt-5-nano';
    config.hybridai.models = ['gpt-5-nano'];
    config.codex.models = ['openai-codex/gpt-5.1-codex-max'];
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
    config.auxiliaryModels.vision.model = '';
    config.auxiliaryModels.vision.provider = 'auto';
  });

  const warn = vi.fn();
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn,
      info: vi.fn(),
    },
  }));

  const taskRouting = await importFreshTaskRouting(homeDir);
  const policy = await taskRouting.resolveTaskModelPolicy('vision', {
    agentId: 'main',
    sessionModel: 'gpt-5-nano',
  });

  expect(policy).toMatchObject({
    provider: undefined,
    model: 'gpt-5-nano',
    error:
      'Session model "gpt-5-nano" does not support vision/image inputs, and no vision-capable fallback model is available.',
  });
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'vision',
      sessionModel: 'gpt-5-nano',
      openrouterDiscoveredModels: 0,
    }),
    'Session model lacks vision support and no capable fallback model is available',
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
