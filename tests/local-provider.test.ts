import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
const ORIGINAL_HYBRIDAI_API_KEY = process.env.HYBRIDAI_API_KEY;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-local-provider-'));
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
  config.local.backends.ollama.enabled = true;
  config.local.backends.ollama.baseUrl = 'http://127.0.0.1:11434/v1/';
  config.local.backends.lmstudio.enabled = false;
  config.local.backends.vllm.enabled = false;
  mutator?.(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

async function importFreshModules(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  process.env.HYBRIDAI_API_KEY = 'hybridai-test-key';
  vi.resetModules();
  const discovery = await import('../src/providers/local-discovery.js');
  const factory = await import('../src/providers/factory.js');
  return { discovery, factory };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  const discovery = await import('../src/providers/local-discovery.js');
  discovery.resetLocalDiscoveryState();
});

describe('local providers', () => {
  test('provider factory registers local providers before HybridAI fallback', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const { factory } = await importFreshModules(homeDir);

    expect(factory.getAIProviders().map((provider) => provider.id)).toEqual([
      'openai-codex',
      'anthropic',
      'ollama',
      'hybridai',
    ]);
  });

  test('explicit ollama model prefixes resolve to the ollama provider', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const { factory } = await importFreshModules(homeDir);

    expect(factory.resolveModelProvider('ollama/llama3.2')).toBe('ollama');
    expect(factory.modelRequiresChatbotId('ollama/llama3.2')).toBe(false);
    expect(factory.resolveAgentIdForModel('ollama/llama3.2', '')).toBe(
      'ollama',
    );
  });

  test('discovered bare model names resolve to the local backend', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const { discovery, factory } = await importFreshModules(homeDir);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.endsWith('/api/tags')) {
          return new Response(
            JSON.stringify({
              models: [{ name: 'llama3.2', details: {}, size: 1 }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (input.endsWith('/api/show')) {
          const body = JSON.parse(String(init?.body || '{}')) as Record<
            string,
            string
          >;
          return new Response(
            JSON.stringify({
              model_info: {
                'llama.context_length':
                  body.model === 'llama3.2' ? 32_768 : 8_192,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected URL: ${input}`);
      }),
    );

    await discovery.discoverAllLocalModels();

    expect(factory.resolveModelProvider('llama3.2')).toBe('ollama');
    const credentials = await factory.resolveModelRuntimeCredentials({
      model: 'llama3.2',
    });
    expect(credentials).toMatchObject({
      provider: 'ollama',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434',
      chatbotId: '',
      enableRag: false,
      isLocal: true,
      contextWindow: 32_768,
    });
  });

  test('ollamaProvider.resolveRuntimeCredentials returns isLocal: true', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const { factory } = await importFreshModules(homeDir);

    const credentials = await factory.resolveModelRuntimeCredentials({
      model: 'ollama/some-model',
    });
    expect(credentials.isLocal).toBe(true);
  });

  test('ollamaProvider.resolveRuntimeCredentials returns empty apiKey', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const { factory } = await importFreshModules(homeDir);

    const credentials = await factory.resolveModelRuntimeCredentials({
      model: 'ollama/some-model',
    });
    expect(credentials.apiKey).toBe('');
  });

  test('factory provider order: local providers appear after anthropic, before hybridai fallback', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.local.backends.ollama.enabled = true;
      config.local.backends.lmstudio.enabled = true;
      config.local.backends.vllm.enabled = true;
    });
    const { factory } = await importFreshModules(homeDir);

    const providerIds = factory.getAIProviders().map((p) => p.id);
    const anthropicIndex = providerIds.indexOf('anthropic');
    const ollamaIndex = providerIds.indexOf('ollama');
    const lmstudioIndex = providerIds.indexOf('lmstudio');
    const vllmIndex = providerIds.indexOf('vllm');
    const hybridaiIndex = providerIds.indexOf('hybridai');

    expect(anthropicIndex).toBeLessThan(ollamaIndex);
    expect(ollamaIndex).toBeLessThan(hybridaiIndex);
    expect(lmstudioIndex).toBeLessThan(hybridaiIndex);
    expect(vllmIndex).toBeLessThan(hybridaiIndex);
    // hybridai is always last
    expect(hybridaiIndex).toBe(providerIds.length - 1);
  });

  test('unknown models still fall back to HybridAI', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const { factory } = await importFreshModules(homeDir);

    expect(factory.resolveModelProvider('gpt-5-nano')).toBe('hybridai');
  });

  test('lmstudio runtime credentials mark qwen models with qwen thinking format', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.local.backends.ollama.enabled = false;
      config.local.backends.lmstudio.enabled = true;
      config.local.backends.lmstudio.baseUrl = 'http://127.0.0.1:1234/v1';
    });
    const { discovery, factory } = await importFreshModules(homeDir);

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ id: 'qwen/qwen3.5-9b' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    await discovery.discoverAllLocalModels();

    const credentials = await factory.resolveModelRuntimeCredentials({
      model: 'lmstudio/qwen/qwen3.5-9b',
    });
    expect(credentials).toMatchObject({
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      isLocal: true,
      thinkingFormat: 'qwen',
    });
  });
});
