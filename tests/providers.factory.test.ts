import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
const ORIGINAL_HYBRIDAI_API_KEY = process.env.HYBRIDAI_API_KEY;
const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const ORIGINAL_HF_TOKEN = process.env.HF_TOKEN;
const ORIGINAL_GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ORIGINAL_DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const ORIGINAL_XAI_API_KEY = process.env.XAI_API_KEY;
const ORIGINAL_ZAI_API_KEY = process.env.ZAI_API_KEY;
const ORIGINAL_KIMI_API_KEY = process.env.KIMI_API_KEY;
const ORIGINAL_MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const ORIGINAL_DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const ORIGINAL_XIAOMI_API_KEY = process.env.XIAOMI_API_KEY;
const ORIGINAL_KILO_API_KEY = process.env.KILO_API_KEY;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-providers-'));
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

async function writeRuntimeSecrets(
  homeDir: string,
  secrets: Record<string, string>,
): Promise<void> {
  process.env.HOME = homeDir;
  vi.resetModules();
  const runtimeSecrets = await import('../src/security/runtime-secrets.ts');
  runtimeSecrets.saveRuntimeSecrets(secrets);
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function importFreshFactory(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
  return import('../src/providers/factory.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar(
    'HYBRIDCLAW_DISABLE_CONFIG_WATCHER',
    ORIGINAL_DISABLE_CONFIG_WATCHER,
  );
  restoreEnvVar('HYBRIDAI_API_KEY', ORIGINAL_HYBRIDAI_API_KEY);
  restoreEnvVar('OPENROUTER_API_KEY', ORIGINAL_OPENROUTER_API_KEY);
  restoreEnvVar('MISTRAL_API_KEY', ORIGINAL_MISTRAL_API_KEY);
  restoreEnvVar('HF_TOKEN', ORIGINAL_HF_TOKEN);
  restoreEnvVar('GEMINI_API_KEY', ORIGINAL_GEMINI_API_KEY);
  restoreEnvVar('DEEPSEEK_API_KEY', ORIGINAL_DEEPSEEK_API_KEY);
  restoreEnvVar('XAI_API_KEY', ORIGINAL_XAI_API_KEY);
  restoreEnvVar('ZAI_API_KEY', ORIGINAL_ZAI_API_KEY);
  restoreEnvVar('KIMI_API_KEY', ORIGINAL_KIMI_API_KEY);
  restoreEnvVar('MINIMAX_API_KEY', ORIGINAL_MINIMAX_API_KEY);
  restoreEnvVar('DASHSCOPE_API_KEY', ORIGINAL_DASHSCOPE_API_KEY);
  restoreEnvVar('XIAOMI_API_KEY', ORIGINAL_XIAOMI_API_KEY);
  restoreEnvVar('KILO_API_KEY', ORIGINAL_KILO_API_KEY);
});

test('provider factory resolves adapters by model family', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = true;
    config.mistral.enabled = true;
    config.huggingface.enabled = true;
    config.gemini.enabled = true;
    config.deepseek.enabled = true;
    config.xai.enabled = true;
    config.zai.enabled = true;
    config.kimi.enabled = true;
    config.minimax.enabled = true;
    config.dashscope.enabled = true;
    config.xiaomi.enabled = true;
    config.kilo.enabled = true;
  });
  const factory = await importFreshFactory(homeDir);

  expect(factory.resolveModelProvider('gpt-5-nano')).toBe('hybridai');
  expect(factory.resolveModelProvider('openai-codex/gpt-5-codex')).toBe(
    'openai-codex',
  );
  expect(
    factory.resolveModelProvider('openrouter/anthropic/claude-sonnet-4'),
  ).toBe('openrouter');
  expect(factory.resolveModelProvider('mistral/mistral-large-latest')).toBe(
    'mistral',
  );
  expect(
    factory.resolveModelProvider(
      'huggingface/meta-llama/Llama-3.1-8B-Instruct',
    ),
  ).toBe('huggingface');
  expect(factory.resolveModelProvider('anthropic/claude-3-7-sonnet')).toBe(
    'anthropic',
  );
  expect(factory.resolveModelProvider('gemini/gemini-2.5-pro')).toBe('gemini');
  expect(factory.resolveModelProvider('deepseek/deepseek-chat')).toBe(
    'deepseek',
  );
  expect(factory.resolveModelProvider('xai/grok-3')).toBe('xai');
  expect(factory.resolveModelProvider('zai/glm-5')).toBe('zai');
  expect(factory.resolveModelProvider('kimi/kimi-k2.5')).toBe('kimi');
  expect(factory.resolveModelProvider('minimax/MiniMax-M2.5')).toBe('minimax');
  expect(factory.resolveModelProvider('dashscope/qwen3-coder-plus')).toBe(
    'dashscope',
  );
  expect(factory.resolveModelProvider('xiaomi/mimo-v2-pro')).toBe('xiaomi');
  expect(factory.resolveModelProvider('kilo/anthropic/claude-sonnet-4.6')).toBe(
    'kilo',
  );

  expect(factory.modelRequiresChatbotId('gpt-5-nano')).toBe(true);
  expect(factory.modelRequiresChatbotId('openai-codex/gpt-5-codex')).toBe(
    false,
  );
  expect(
    factory.modelRequiresChatbotId('openrouter/anthropic/claude-sonnet-4'),
  ).toBe(false);
  expect(factory.modelRequiresChatbotId('mistral/mistral-large-latest')).toBe(
    false,
  );
  expect(
    factory.modelRequiresChatbotId(
      'huggingface/meta-llama/Llama-3.1-8B-Instruct',
    ),
  ).toBe(false);
  expect(factory.modelRequiresChatbotId('anthropic/claude-3-7-sonnet')).toBe(
    false,
  );
  expect(factory.modelRequiresChatbotId('gemini/gemini-2.5-pro')).toBe(false);
  expect(factory.modelRequiresChatbotId('deepseek/deepseek-chat')).toBe(false);
  expect(factory.modelRequiresChatbotId('xai/grok-3')).toBe(false);
  expect(factory.modelRequiresChatbotId('zai/glm-5')).toBe(false);
  expect(factory.modelRequiresChatbotId('kimi/kimi-k2.5')).toBe(false);
  expect(factory.modelRequiresChatbotId('minimax/MiniMax-M2.5')).toBe(false);
  expect(factory.modelRequiresChatbotId('dashscope/qwen3-coder-plus')).toBe(
    false,
  );
  expect(factory.modelRequiresChatbotId('xiaomi/mimo-v2-pro')).toBe(false);
  expect(
    factory.modelRequiresChatbotId('kilo/anthropic/claude-sonnet-4.6'),
  ).toBe(false);
});

test('provider factory resolves HybridAI runtime credentials', async () => {
  const homeDir = makeTempHome();
  process.env.HYBRIDAI_API_KEY = 'hai-provider-test';
  const factory = await importFreshFactory(homeDir);

  const credentials = await factory.resolveModelRuntimeCredentials({
    model: 'gpt-5-nano',
    chatbotId: 'bot_123',
    enableRag: false,
    agentId: 'main',
  });

  expect(credentials).toMatchObject({
    provider: 'hybridai',
    apiKey: 'hai-provider-test',
    chatbotId: 'bot_123',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
  });
});

test('provider factory includes discovered HybridAI context window metadata', async () => {
  const homeDir = makeTempHome();
  process.env.HYBRIDAI_API_KEY = 'hai-provider-test';
  vi.doMock('../src/providers/hybridai-discovery.ts', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/hybridai-discovery.ts')
    >('../src/providers/hybridai-discovery.ts');
    return {
      ...actual,
      discoverHybridAIModels: vi.fn(async () => []),
      getDiscoveredHybridAIModelContextWindow: vi.fn((model: string) =>
        model === 'gpt-5-ultra' ? 512_000 : null,
      ),
      getDiscoveredHybridAIModelMaxTokens: vi.fn(() => null),
    };
  });
  const factory = await importFreshFactory(homeDir);

  const credentials = await factory.resolveModelRuntimeCredentials({
    model: 'gpt-5-ultra',
    chatbotId: 'bot_123',
    agentId: 'main',
  });

  expect(credentials).toMatchObject({
    provider: 'hybridai',
    contextWindow: 512_000,
  });
});

test('provider factory resolves OpenRouter runtime credentials', async () => {
  const homeDir = makeTempHome();
  vi.doMock('../src/providers/openrouter-discovery.ts', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/openrouter-discovery.ts')
    >('../src/providers/openrouter-discovery.ts');
    return {
      ...actual,
      discoverOpenRouterModels: vi.fn(async () => []),
      getDiscoveredOpenRouterModelContextWindow: vi.fn((model: string) =>
        model === 'openrouter/anthropic/claude-sonnet-4' ? 262_144 : null,
      ),
      getDiscoveredOpenRouterModelMaxTokens: vi.fn(() => null),
    };
  });
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = true;
    config.openrouter.baseUrl = 'https://openrouter.ai/api/v1/';
  });
  process.env.OPENROUTER_API_KEY = 'or-provider-test';
  const factory = await importFreshFactory(homeDir);

  const credentials = await factory.resolveModelRuntimeCredentials({
    model: 'openrouter/anthropic/claude-sonnet-4',
    agentId: 'main',
  });

  expect(credentials).toMatchObject({
    provider: 'openrouter',
    apiKey: 'or-provider-test',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {
      'HTTP-Referer': 'https://github.com/hybridaione/hybridclaw',
      'X-OpenRouter-Title': 'HybridClaw',
      'X-OpenRouter-Categories': 'cli-agent,general-chat',
      'X-Title': 'HybridClaw',
    },
    agentId: 'main',
    isLocal: false,
    contextWindow: 262_144,
  });
});

test('provider factory resolves Hugging Face runtime credentials', async () => {
  const homeDir = makeTempHome();
  vi.doMock('../src/providers/huggingface-discovery.ts', () => ({
    getDiscoveredHuggingFaceModelContextWindow: vi.fn((model: string) =>
      model === 'huggingface/meta-llama/Llama-3.1-8B-Instruct' ? 131_072 : null,
    ),
  }));
  writeRuntimeConfig(homeDir, (config) => {
    config.huggingface.enabled = true;
    config.huggingface.baseUrl = 'https://router.huggingface.co/v1/';
  });
  process.env.HF_TOKEN = 'hf-provider-test';
  const factory = await importFreshFactory(homeDir);

  const credentials = await factory.resolveModelRuntimeCredentials({
    model: 'huggingface/meta-llama/Llama-3.1-8B-Instruct',
    agentId: 'main',
  });

  expect(credentials).toMatchObject({
    provider: 'huggingface',
    apiKey: 'hf-provider-test',
    baseUrl: 'https://router.huggingface.co/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: false,
    contextWindow: 131_072,
  });
});

test('provider factory resolves Mistral runtime credentials', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir, (config) => {
    config.mistral.enabled = true;
    config.mistral.baseUrl = 'https://api.mistral.ai/v1/';
  });
  process.env.MISTRAL_API_KEY = 'mistral-provider-test';
  const factory = await importFreshFactory(homeDir);

  const credentials = await factory.resolveModelRuntimeCredentials({
    model: 'mistral/mistral-large-latest',
    agentId: 'main',
  });

  expect(credentials).toMatchObject({
    provider: 'mistral',
    apiKey: 'mistral-provider-test',
    baseUrl: 'https://api.mistral.ai/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: false,
  });
});

test('provider factory hot-reloads Hugging Face credentials from runtime secrets', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir, (config) => {
    config.huggingface.enabled = true;
  });
  delete process.env.HF_TOKEN;
  await writeRuntimeSecrets(homeDir, { HF_TOKEN: 'hf-old-token' });
  const factory = await importFreshFactory(homeDir);

  const first = await factory.resolveModelRuntimeCredentials({
    model: 'huggingface/meta-llama/Llama-3.1-8B-Instruct',
    agentId: 'main',
  });
  expect(first).toMatchObject({
    provider: 'huggingface',
    apiKey: 'hf-old-token',
  });

  await writeRuntimeSecrets(homeDir, { HF_TOKEN: 'hf-new-token' });
  const second = await factory.resolveModelRuntimeCredentials({
    model: 'huggingface/meta-llama/Llama-3.1-8B-Instruct',
    agentId: 'main',
  });
  expect(second).toMatchObject({
    provider: 'huggingface',
    apiKey: 'hf-new-token',
  });
});

test.each([
  { providerId: 'gemini', model: 'gemini/gemini-2.5-pro', envVar: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { providerId: 'deepseek', model: 'deepseek/deepseek-chat', envVar: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1' },
  { providerId: 'xai', model: 'xai/grok-3', envVar: 'XAI_API_KEY', baseUrl: 'https://api.x.ai/v1' },
  { providerId: 'zai', model: 'zai/glm-5', envVar: 'ZAI_API_KEY', baseUrl: 'https://api.z.ai/api/paas/v4' },
  { providerId: 'kimi', model: 'kimi/kimi-k2.5', envVar: 'KIMI_API_KEY', baseUrl: 'https://api.kimi.com/coding/v1' },
  { providerId: 'minimax', model: 'minimax/MiniMax-M2.5', envVar: 'MINIMAX_API_KEY', baseUrl: 'https://api.minimax.io/v1' },
  { providerId: 'dashscope', model: 'dashscope/qwen3-coder-plus', envVar: 'DASHSCOPE_API_KEY', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { providerId: 'xiaomi', model: 'xiaomi/mimo-v2-pro', envVar: 'XIAOMI_API_KEY', baseUrl: 'https://api.xiaomimimo.com/v1' },
  { providerId: 'kilo', model: 'kilo/anthropic/claude-sonnet-4.6', envVar: 'KILO_API_KEY', baseUrl: 'https://api.kilocode.ai/v1' },
] as const)(
  'provider factory resolves $providerId runtime credentials',
  async ({ providerId, model, envVar, baseUrl }) => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      (config as Record<string, unknown>)[providerId] = {
        enabled: true,
        baseUrl,
        models: [model],
      };
    });
    process.env[envVar] = `${providerId}-test-key`;
    const factory = await importFreshFactory(homeDir);

    const credentials = await factory.resolveModelRuntimeCredentials({
      model,
      agentId: 'main',
    });

    expect(credentials).toMatchObject({
      provider: providerId,
      apiKey: `${providerId}-test-key`,
      baseUrl,
      chatbotId: '',
      enableRag: false,
      agentId: 'main',
      isLocal: false,
    });
  },
);

test('provider factory fails early for unsupported anthropic runtime execution', async () => {
  const homeDir = makeTempHome();
  const factory = await importFreshFactory(homeDir);

  await expect(
    factory.resolveModelRuntimeCredentials({
      model: 'anthropic/claude-3-7-sonnet',
    }),
  ).rejects.toThrow(
    'Anthropic provider is not implemented yet for model "anthropic/claude-3-7-sonnet".',
  );
});
