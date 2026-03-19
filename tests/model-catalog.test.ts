import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

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
  if (ORIGINAL_OPENROUTER_API_KEY === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER_API_KEY;
  }
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
      { name: 'gpt-5-nano', value: 'gpt-5-nano' },
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
