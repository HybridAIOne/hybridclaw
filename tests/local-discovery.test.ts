import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-local-discovery-'));
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
  config.local.enabled = true;
  mutator?.(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

async function importFreshDiscovery(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
  return import('../src/providers/local-discovery.js');
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
  const discovery = await import('../src/providers/local-discovery.js');
  discovery.resetLocalDiscoveryState();
});

describe('local discovery', () => {
  test('resolveOllamaApiBase strips trailing slash and /v1 suffix', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const discovery = await importFreshDiscovery(homeDir);

    expect(discovery.resolveOllamaApiBase('http://127.0.0.1:11434/v1/')).toBe(
      'http://127.0.0.1:11434',
    );
    expect(discovery.resolveOllamaApiBase()).toBe('http://127.0.0.1:11434');
  });

  test('discoverOllamaModels reads tags and show metadata with concurrency', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.local.backends.ollama.baseUrl = 'http://127.0.0.1:11434/v1/';
    });
    const discovery = await importFreshDiscovery(homeDir);

    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: 'llama3.2',
                size: 1234,
                details: {
                  family: 'llama',
                  parameter_size: '8B',
                },
              },
              {
                name: 'deepseek-r1',
                size: 5678,
                details: {
                  family: 'deepseek',
                  parameter_size: '14B',
                },
              },
            ],
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
                body.model === 'deepseek-r1' ? 131_072 : 8_192,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const models = await discovery.discoverOllamaModels(
      'http://127.0.0.1:11434/v1/',
      {
        maxModels: 2,
        concurrency: 2,
      },
    );

    expect(models).toEqual([
      expect.objectContaining({
        id: 'llama3.2',
        backend: 'ollama',
        contextWindow: 8_192,
        family: 'llama',
        parameterSize: '8B',
        isReasoning: false,
      }),
      expect.objectContaining({
        id: 'deepseek-r1',
        backend: 'ollama',
        contextWindow: 131_072,
        family: 'deepseek',
        parameterSize: '14B',
        isReasoning: true,
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('discoverLmStudioModels parses OpenAI-compatible /models output', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const discovery = await importFreshDiscovery(homeDir);

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ id: 'qwen2.5-coder:7b' }, { id: 'mistral-nemo' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    const models = await discovery.discoverLmStudioModels(
      'http://127.0.0.1:1234/v1',
    );

    expect(models.map((model) => [model.backend, model.id])).toEqual([
      ['lmstudio', 'qwen2.5-coder:7b'],
      ['lmstudio', 'mistral-nemo'],
    ]);
    expect(models[0]?.thinkingFormat).toBe('qwen');
    expect(models[1]?.thinkingFormat).toBeUndefined();
  });

  test('discoverVllmModels sends bearer auth only when configured', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const discovery = await importFreshDiscovery(homeDir);

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'granite-3.2' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await discovery.discoverVllmModels('http://127.0.0.1:8000/v1', 'secret');
    await discovery.discoverVllmModels('http://127.0.0.1:8000/v1', '');

    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject(
      {
        Authorization: 'Bearer secret',
      },
    );
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toEqual({});
  });

  test('discoverAllLocalModels caches discovered names for prefixed selection', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.local.backends.ollama.enabled = true;
      config.local.backends.lmstudio.enabled = false;
      config.local.backends.vllm.enabled = false;
    });
    const discovery = await importFreshDiscovery(homeDir);

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
                  body.model === 'llama3.2' ? 16_384 : 8_192,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected URL: ${input}`);
      }),
    );

    await discovery.discoverAllLocalModels();

    expect(discovery.getDiscoveredLocalModelNames()).toEqual([
      'ollama/llama3.2',
    ]);
    expect(discovery.getLocalModelInfo('llama3.2')).toMatchObject({
      backend: 'ollama',
      contextWindow: 16_384,
    });
  });
});
