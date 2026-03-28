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
const ORIGINAL_HF_TOKEN = process.env.HF_TOKEN;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-model-catalog-'));
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

async function importFreshCatalog(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
  const discovery = await import('../src/providers/local-discovery.js');
  const catalog = await import('../src/providers/model-catalog.js');
  return { discovery, catalog };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_DISABLE_CONFIG_WATCHER === undefined) {
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  } else {
    process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER =
      ORIGINAL_DISABLE_CONFIG_WATCHER;
  }
  if (ORIGINAL_HYBRIDAI_API_KEY === undefined) {
    delete process.env.HYBRIDAI_API_KEY;
  } else {
    process.env.HYBRIDAI_API_KEY = ORIGINAL_HYBRIDAI_API_KEY;
  }
  if (ORIGINAL_OPENROUTER_API_KEY === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER_API_KEY;
  }
  if (ORIGINAL_HF_TOKEN === undefined) {
    delete process.env.HF_TOKEN;
  } else {
    process.env.HF_TOKEN = ORIGINAL_HF_TOKEN;
  }
});

test('available model catalog falls back to HybridAI /v1/models when /models is unavailable', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDAI_API_KEY = 'hai-model-catalog-test-1234567890';
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });

  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/v1/models')) {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer hai-model-catalog-test-1234567890',
      });
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'hybridai/gpt-5-ultra',
              context_length: 512_000,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (input.endsWith('/models')) {
      return new Response('<html>not found</html>', {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    throw new Error(`Unexpected URL: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { catalog } = await importFreshCatalog(homeDir);
  const choices = await catalog.getAvailableModelChoices(25, {
    includeHybridAI: true,
  });

  expect(choices).toEqual(
    expect.arrayContaining([
      { name: 'hybridai/gpt-5-ultra', value: 'gpt-5-ultra' },
    ]),
  );
  expect(catalog.getAvailableModelList('hybridai')).toContain('gpt-5-ultra');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('available model catalog merges configured and discovered local models', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir, (config) => {
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = true;
    config.local.backends.lmstudio.baseUrl = 'http://127.0.0.1:1234/v1';
    config.local.backends.vllm.enabled = false;
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.endsWith('/api/v1/models')) {
        return new Response(
          JSON.stringify({
            models: [
              {
                key: 'qwen/qwen3.5-9b',
                max_context_length: 131_072,
                loaded_instances: [],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (input.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'qwen/qwen3.5-9b' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${input}`);
    }),
  );

  const { catalog } = await importFreshCatalog(homeDir);
  const choices = await catalog.getAvailableModelChoices(25);

  expect(choices).toEqual(
    expect.arrayContaining([
      { name: 'hybridai/gpt-5-nano', value: 'gpt-5-nano' },
      {
        name: 'lmstudio/qwen/qwen3.5-9b',
        value: 'lmstudio/qwen/qwen3.5-9b',
      },
    ]),
  );
  expect(catalog.getAvailableModelList('local')).toEqual([
    'lmstudio/qwen/qwen3.5-9b',
  ]);
  expect(catalog.getAvailableModelList('hybridai')).toContain('gpt-5-nano');
});

test('available model catalog reloads OpenRouter discovery after 60 minutes', async () => {
  const homeDir = makeTempHome();
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-13T10:00:00Z'));
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = true;
    config.openrouter.models = ['openrouter/anthropic/claude-sonnet-4'];
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });

  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/models')) {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer or-test-key',
        'HTTP-Referer': 'https://github.com/hybridaione/hybridclaw',
        'X-OpenRouter-Title': 'HybridClaw',
        'X-OpenRouter-Categories': 'cli-agent,general-chat',
        'X-Title': 'HybridClaw',
      });
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'zeta/model-b',
              pricing: {
                prompt: '1',
                completion: '1',
              },
            },
            {
              id: 'beta/model-c:free',
              pricing: {
                prompt: '0',
                completion: '0',
                request: '0',
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

  const { catalog } = await importFreshCatalog(homeDir);
  const firstChoices = await catalog.getAvailableModelChoices(25);
  const secondChoices = await catalog.getAvailableModelChoices(25);
  vi.setSystemTime(new Date('2026-03-13T10:59:59Z'));
  const thirdChoices = await catalog.getAvailableModelChoices(25);
  vi.setSystemTime(new Date('2026-03-13T11:00:01Z'));
  const fourthChoices = await catalog.getAvailableModelChoices(25);

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(firstChoices).toEqual(
    expect.arrayContaining([
      {
        name: 'openrouter/anthropic/claude-sonnet-4',
        value: 'openrouter/anthropic/claude-sonnet-4',
      },
      {
        name: 'openrouter/beta/model-c:free',
        value: 'openrouter/beta/model-c:free',
      },
    ]),
  );
  expect(secondChoices).toEqual(firstChoices);
  expect(thirdChoices).toEqual(firstChoices);
  expect(fourthChoices).toEqual(firstChoices);
  expect(catalog.getAvailableModelList()).toEqual(
    expect.arrayContaining([
      'openrouter/anthropic/claude-sonnet-4',
      'openrouter/beta/model-c:free',
    ]),
  );
  expect(catalog.getAvailableModelList('openrouter')).toEqual([
    'openrouter/beta/model-c:free',
    'openrouter/anthropic/claude-sonnet-4',
    'openrouter/zeta/model-b',
  ]);
  expect(catalog.getAvailableModelList('codex')).toEqual(
    expect.arrayContaining(['openai-codex/gpt-5-codex']),
  );
});

test('available model catalog returns the full Hugging Face discovery list', async () => {
  const homeDir = makeTempHome();
  process.env.HF_TOKEN = 'hf-test-key';
  writeRuntimeConfig(homeDir, (config) => {
    config.huggingface.enabled = true;
    config.huggingface.models = ['huggingface/Qwen/Qwen3.5-397B-A17B'];
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/models')) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer hf-test-key',
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
    }),
  );

  const { catalog } = await importFreshCatalog(homeDir);
  await catalog.refreshAvailableModelCatalogs();

  expect(catalog.getAvailableModelList('huggingface')).toEqual([
    'huggingface/deepseek-ai/DeepSeek-V3.2',
    'huggingface/Qwen/Qwen3.5-27B-FP8',
    'huggingface/Qwen/Qwen3.5-397B-A17B',
    'huggingface/zeta/custom-model',
  ]);
  expect(
    catalog.getAvailableModelListWithOptions('huggingface', {
      expanded: true,
    }),
  ).toEqual(catalog.getAvailableModelList('huggingface'));
});

test('available model catalog reads Hugging Face provider-level context windows', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HF_TOKEN = 'hf-test-key';
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  writeRuntimeConfig(homeDir, (config) => {
    config.huggingface.enabled = true;
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });
  vi.resetModules();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.endsWith('/models')) {
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
      throw new Error(`Unexpected URL: ${input}`);
    }),
  );

  const discovery = await import('../src/providers/huggingface-discovery.ts');

  await expect(
    discovery.discoverHuggingFaceModels({ force: true }),
  ).resolves.toEqual(['huggingface/XiaomiMiMo/MiMo-V2-Flash']);
  expect(
    discovery.getDiscoveredHuggingFaceModelContextWindow(
      'huggingface/XiaomiMiMo/MiMo-V2-Flash',
    ),
  ).toBe(262_144);
});

test('available model catalog does not cap the default Hugging Face list', async () => {
  const homeDir = makeTempHome();
  process.env.HF_TOKEN = 'hf-test-key';
  writeRuntimeConfig(homeDir, (config) => {
    config.huggingface.enabled = true;
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });

  const discoveredIds = [
    'Qwen/Qwen2.5-Coder-32B-Instruct',
    'Qwen/Qwen2.5-Coder-7B-Instruct',
    'Qwen/Qwen2.5-72B-Instruct',
    'Qwen/Qwen2.5-32B-Instruct',
    'Qwen/Qwen2.5-14B-Instruct',
    'Qwen/Qwen2.5-7B-Instruct',
    'Qwen/Qwen2.5-3B-Instruct',
    'Qwen/Qwen2.5-1.5B-Instruct',
    'Qwen/Qwen2.5-VL-7B-Instruct',
    'Qwen/Qwen2.5-VL-3B-Instruct',
    'meta-llama/Llama-3.3-70B-Instruct',
    'meta-llama/Llama-3.1-405B-Instruct',
    'meta-llama/Llama-3.1-70B-Instruct',
    'meta-llama/Llama-3.1-8B-Instruct',
    'meta-llama/Llama-3.2-90B-Vision-Instruct',
    'meta-llama/Llama-3.2-11B-Vision-Instruct',
    'meta-llama/Llama-4-Scout-17B-16E-Instruct',
    'google/gemma-3-27b-it',
    'google/gemma-3-12b-it',
    'google/gemma-3-4b-it',
    'google/gemma-3-1b-it',
    'mistralai/Mistral-Small-24B-Instruct-2501',
    'mistralai/Mistral-Nemo-Instruct-2407',
    'mistralai/Mistral-7B-Instruct-v0.3',
    'mistralai/Mixtral-8x7B-Instruct-v0.1',
    'deepseek-ai/DeepSeek-V3',
    'deepseek-ai/DeepSeek-R1',
    'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B',
    'CohereForAI/c4ai-command-r-plus-08-2024',
    'CohereForAI/c4ai-command-r-08-2024',
    'CohereForAI/aya-expanse-32b',
    'moonshotai/Kimi-K2-Instruct-0905',
  ];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: discoveredIds.map((id) => ({ id })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${input}`);
    }),
  );

  const { catalog } = await importFreshCatalog(homeDir);
  await catalog.refreshAvailableModelCatalogs();

  expect(catalog.getAvailableModelList('huggingface')).toHaveLength(32);
  expect(
    catalog.getAvailableModelListWithOptions('huggingface', {
      expanded: true,
    }),
  ).toHaveLength(32);
});

test('vision fallback ignores OpenRouter models with image output only', async () => {
  const homeDir = makeTempHome();
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = true;
    config.openrouter.models = [];
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'acme/text-to-image',
                architecture: { modality: 'text->image' },
              },
              {
                id: 'zeus/vision-chat',
                architecture: { modality: 'text+image->text' },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${input}`);
    }),
  );

  const { catalog } = await importFreshCatalog(homeDir);
  await catalog.refreshAvailableModelCatalogs();

  expect(catalog.isModelVisionCapable('openrouter/acme/text-to-image')).toBe(
    false,
  );
  expect(catalog.isModelVisionCapable('openrouter/zeus/vision-chat')).toBe(
    true,
  );
  expect(catalog.findVisionCapableModel('openrouter/acme/text-to-image')).toBe(
    'openrouter/zeus/vision-chat',
  );
});

test('available model catalog cache invalidates when source lists change', async () => {
  let discoveredHuggingFaceModels = [
    'huggingface/meta-llama/Llama-3.1-8B-Instruct',
  ];

  vi.doMock('../src/config/config.js', () => ({
    CONFIGURED_MODELS: ['gpt-5-nano'],
  }));
  vi.doMock('../src/providers/factory.js', () => ({
    resolveModelProvider: vi.fn(() => 'hybridai'),
  }));
  vi.doMock('../src/providers/huggingface-discovery.js', () => ({
    discoverHuggingFaceModels: vi.fn(),
    getDiscoveredHuggingFaceModelNames: vi.fn(
      () => discoveredHuggingFaceModels,
    ),
  }));
  vi.doMock('../src/providers/huggingface-utils.js', () => ({
    HUGGINGFACE_MODEL_PREFIX: 'huggingface/',
  }));
  vi.doMock('../src/providers/hybridai-discovery.js', () => ({
    discoverHybridAIModels: vi.fn(),
    getDiscoveredHybridAIModelNames: vi.fn(() => []),
  }));
  vi.doMock('../src/providers/hybridai-models.js', () => ({
    isStaticModelVisionCapable: vi.fn(() => false),
  }));
  vi.doMock('../src/providers/local-discovery.js', () => ({
    discoverAllLocalModels: vi.fn(),
    getDiscoveredLocalModelNames: vi.fn(() => []),
  }));
  vi.doMock('../src/providers/model-names.js', () => ({
    formatModelForDisplay: vi.fn((model: string) => model),
  }));
  vi.doMock('../src/providers/openai.js', () => ({
    OPENAI_CODEX_MODEL_PREFIX: 'openai-codex/',
  }));
  vi.doMock('../src/providers/openrouter-discovery.js', () => ({
    discoverOpenRouterModels: vi.fn(),
    getDiscoveredOpenRouterModelNames: vi.fn(() => []),
    isDiscoveredOpenRouterModelFree: vi.fn(() => false),
    isDiscoveredOpenRouterModelVisionCapable: vi.fn(() => false),
  }));
  vi.doMock('../src/providers/openrouter-utils.js', () => ({
    OPENROUTER_MODEL_PREFIX: 'openrouter/',
  }));

  vi.resetModules();
  const catalog = await import('../src/providers/model-catalog.ts');

  const first = catalog.getAvailableModelList();
  first.push('poisoned-local-copy');
  expect(catalog.getAvailableModelList()).not.toContain('poisoned-local-copy');

  discoveredHuggingFaceModels = [
    'huggingface/meta-llama/Llama-3.1-8B-Instruct',
    'huggingface/Qwen/Qwen3.5-27B-FP8',
  ];
  expect(catalog.getAvailableModelList()).toContain(
    'huggingface/Qwen/Qwen3.5-27B-FP8',
  );

  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/providers/factory.js');
  vi.doUnmock('../src/providers/huggingface-discovery.js');
  vi.doUnmock('../src/providers/huggingface-utils.js');
  vi.doUnmock('../src/providers/hybridai-discovery.js');
  vi.doUnmock('../src/providers/hybridai-models.js');
  vi.doUnmock('../src/providers/local-discovery.js');
  vi.doUnmock('../src/providers/model-names.js');
  vi.doUnmock('../src/providers/openai.js');
  vi.doUnmock('../src/providers/openrouter-discovery.js');
  vi.doUnmock('../src/providers/openrouter-utils.js');
});
