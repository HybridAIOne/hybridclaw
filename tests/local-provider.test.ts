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
  config.local.backends.llamacpp.enabled = false;
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
});

describe('local providers', () => {
  test('provider factory resolves explicit provider prefixes without exposing provider internals', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const { factory } = await importFreshModules(homeDir);

    expect(factory.resolveModelProvider('openai-codex/gpt-5.4')).toBe(
      'openai-codex',
    );
    expect(factory.resolveModelProvider('anthropic/claude-sonnet-4')).toBe(
      'anthropic',
    );
    expect(factory.resolveModelProvider('ollama/llama3.2')).toBe('ollama');
    expect(factory.resolveModelProvider('gpt-5-nano')).toBe('hybridai');
  });

  test('explicit ollama model prefixes resolve to the ollama provider', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const { factory } = await importFreshModules(homeDir);

    expect(factory.resolveModelProvider('ollama/llama3.2')).toBe('ollama');
    expect(factory.modelRequiresChatbotId('ollama/llama3.2')).toBe(false);
  });

  test('explicit llamacpp model prefixes resolve to the llamacpp provider', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.local.backends.ollama.enabled = false;
      config.local.backends.llamacpp.enabled = true;
      config.local.backends.llamacpp.baseUrl = 'http://127.0.0.1:8081/v1';
    });
    const { factory } = await importFreshModules(homeDir);

    expect(
      factory.resolveModelProvider('llamacpp/Meta-Llama-3-8B-Instruct'),
    ).toBe('llamacpp');
    expect(
      factory.modelRequiresChatbotId('llamacpp/Meta-Llama-3-8B-Instruct'),
    ).toBe(false);
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
      agentId: 'research',
    });
    expect(credentials.isLocal).toBe(true);
    expect(credentials.agentId).toBe('research');
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

  test('all enabled local provider prefixes remain routable', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.local.backends.ollama.enabled = true;
      config.local.backends.lmstudio.enabled = true;
      config.local.backends.llamacpp.enabled = true;
      config.local.backends.vllm.enabled = true;
    });
    const { factory } = await importFreshModules(homeDir);

    expect(factory.resolveModelProvider('ollama/llama3.2')).toBe('ollama');
    expect(factory.resolveModelProvider('lmstudio/qwen3.5-9b')).toBe(
      'lmstudio',
    );
    expect(
      factory.resolveModelProvider('llamacpp/Meta-Llama-3-8B-Instruct'),
    ).toBe('llamacpp');
    expect(factory.resolveModelProvider('vllm/granite-3.2')).toBe('vllm');
    expect(factory.resolveModelProvider('gpt-5-nano')).toBe('hybridai');
  });

  test('MLX uses named authenticated loopback discovery and propagates real limits', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.local.backends.ollama.enabled = false;
      config.local.endpoints = [
        {
          name: 'mac-mlx',
          type: 'mlx',
          enabled: true,
          baseUrl: 'http://127.0.0.1:8321/v1',
          apiKey: 'test-key',
          zone: 'local',
        },
      ];
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: 'test-model', context_length: 4096, max_tokens: 1024 },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    const { factory } = await importFreshModules(homeDir);
    expect(factory.resolveModelProvider('mac-mlx/test-model')).toBe('mlx');
    await expect(
      factory.resolveModelRuntimeCredentials({ model: 'mac-mlx/test-model' }),
    ).resolves.toMatchObject({
      provider: 'mlx',
      model: 'mlx/test-model',
      isLocal: true,
      maxTokens: 1024,
      contextWindow: 4096,
      apiKey: 'test-key',
    });
    await expect(
      factory.resolveModelRuntimeCredentials({ model: 'mlx/unconfigured' }),
    ).rejects.toThrow('authenticated named endpoint');
  });

  test('provider factory resolves named local endpoint prefixes', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.local.backends.ollama.enabled = false;
      config.local.endpoints = [
        {
          name: 'haigpu2',
          type: 'vllm',
          enabled: true,
          baseUrl: 'http://haigpu2:8000/v1',
          apiKey: 'gemma-secret-key',
        },
      ];
    });
    const { factory } = await importFreshModules(homeDir);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe('http://haigpu2:8000/v1/models');
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer gemma-secret-key',
        });
        return new Response(
          JSON.stringify({
            data: [{ id: 'google/gemma-3-27b-it', max_model_len: 32_768 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    expect(factory.resolveModelProvider('haigpu2/google/gemma-3-27b-it')).toBe(
      'vllm',
    );
    const credentials = await factory.resolveModelRuntimeCredentials({
      model: 'haigpu2/google/gemma-3-27b-it',
    });

    expect(credentials).toMatchObject({
      provider: 'vllm',
      model: 'vllm/google/gemma-3-27b-it',
      apiKey: 'gemma-secret-key',
      baseUrl: 'http://haigpu2:8000/v1',
      isLocal: true,
      contextWindow: 32_768,
    });
    expect(credentials.modelBehavior).toBeUndefined();
  });

  test('local discovery lists named endpoint model prefixes', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.local.backends.ollama.enabled = false;
      config.local.endpoints = [
        {
          name: 'haigpu2',
          type: 'vllm',
          enabled: true,
          baseUrl: 'http://haigpu2:8000/v1',
          apiKey: 'gemma-secret-key',
        },
      ];
    });
    const { discovery } = await importFreshModules(homeDir);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe('http://haigpu2:8000/v1/models');
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer gemma-secret-key',
        });
        return new Response(
          JSON.stringify({
            data: [{ id: 'google/gemma-3-27b-it', max_model_len: 32_768 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    await discovery.discoverAllLocalModels();

    expect(discovery.getDiscoveredLocalModelNames()).toContain(
      'haigpu2/google/gemma-3-27b-it',
    );
    expect(
      discovery.getLocalModelInfo('haigpu2/google/gemma-3-27b-it'),
    ).toMatchObject({
      backend: 'vllm',
      contextWindow: 32_768,
      endpointName: 'haigpu2',
    });
    expect(
      discovery.getLocalModelInfo('haigpu2/google/gemma-3-27b-it')
        ?.modelBehavior,
    ).toBeUndefined();
  });

  test('unknown models still fall back to HybridAI', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const { factory } = await importFreshModules(homeDir);

    expect(factory.resolveModelProvider('gpt-5-nano')).toBe('hybridai');
  });

  test('lmstudio runtime credentials preserve configured qwen thinking behavior', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.local.backends.ollama.enabled = false;
      config.local.backends.lmstudio.enabled = true;
      config.local.backends.lmstudio.baseUrl = 'http://127.0.0.1:1234/v1';
      config.local.backends.lmstudio.modelBehavior = {
        thinkingFormat: 'qwen',
      };
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
      modelBehavior: { thinkingFormat: 'qwen' },
    });
  });
});

test.each([false, true])('MLX refreshes an empty cached endpoint after startup (same model on another endpoint: %s)', async (otherEndpoint) => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir, (config) => {
    config.local.backends.ollama.enabled = false;
    config.local.discovery.intervalMs = 3_600_000;
    config.local.endpoints = [{ name: 'mac-mlx', type: 'mlx', enabled: true, baseUrl: 'http://127.0.0.1:8321/v1', apiKey: 'test-key', zone: 'local' }];
    if (otherEndpoint) config.local.endpoints.push({ name: 'gpu', type: 'vllm', enabled: true, baseUrl: 'http://127.0.0.1:8331/v1', zone: 'hai' });
  });
  let running = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const mlx = url === 'http://127.0.0.1:8321/v1/models';
    if (mlx) {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
      if (!running) throw new Error('Connection refused');
    }
    return new Response(JSON.stringify({ data: [{ id: 'test-model', context_length: mlx ? 4096 : 65536, max_tokens: mlx ? 1024 : 4096 }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const { discovery, factory } = await importFreshModules(homeDir);
  await discovery.discoverAllLocalModels();
  expect(discovery.getLocalModelInfo('mac-mlx/test-model')).toBeNull();
  if (otherEndpoint) expect(discovery.getLocalModelInfo('test-model')?.backend).toBe('vllm');
  running = true;
  const credentials = await factory.resolveModelRuntimeCredentials({ model: 'mac-mlx/test-model' });
  expect(credentials).toMatchObject({ provider: 'mlx', contextWindow: 4096, maxTokens: 1024, model: 'mlx/test-model' });
  expect(fetchMock.mock.calls.filter(([url]) => url.includes(':8321/'))).toHaveLength(2);
});

test.each(['offline', 'unauthorized', 'missing-limits'])('MLX still fails closed after fresh discovery when %s', async (failure) => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir, (config) => {
    config.local.backends.ollama.enabled = false;
    config.local.endpoints = [{ name: 'mac-mlx', type: 'mlx', enabled: true, baseUrl: 'http://127.0.0.1:8321/v1', apiKey: 'test-key', zone: 'local' }];
  });
  const fetchMock = vi.fn(async () => {
    if (failure === 'offline') throw new Error('Connection refused');
    return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), { status: failure === 'unauthorized' ? 401 : 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const { discovery, factory } = await importFreshModules(homeDir);
  await discovery.discoverAllLocalModels();
  await expect(factory.resolveModelRuntimeCredentials({ model: 'mac-mlx/test-model' })).rejects.toThrow('MLX model is unavailable');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
