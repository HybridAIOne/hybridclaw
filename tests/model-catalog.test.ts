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
const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.sig`;
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
  if (ORIGINAL_MISTRAL_API_KEY === undefined) {
    delete process.env.MISTRAL_API_KEY;
  } else {
    process.env.MISTRAL_API_KEY = ORIGINAL_MISTRAL_API_KEY;
  }
  if (ORIGINAL_HF_TOKEN === undefined) {
    delete process.env.HF_TOKEN;
  } else {
    process.env.HF_TOKEN = ORIGINAL_HF_TOKEN;
  }
  if (ORIGINAL_ANTHROPIC_API_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_API_KEY;
  }
  vi.doUnmock('../src/auth/anthropic-auth.js');
});

test('model catalog metadata resolves context and capabilities from static data', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir);
  const { catalog } = await importFreshCatalog(homeDir);

  const metadata = catalog.getModelCatalogMetadata('hybridai/gpt-5-nano');

  expect(metadata.known).toBe(true);
  expect(metadata.contextWindow).toBe(400_000);
  expect(metadata.pricingUsdPerToken).toEqual({ input: null, output: null });
  expect(metadata.capabilities).toEqual({
    vision: true,
    tools: true,
    jsonMode: true,
    reasoning: true,
  });
  expect(metadata.sources).toEqual(
    expect.arrayContaining(['https://developers.openai.com/api/docs/models']),
  );

  const flagship = catalog.getModelCatalogMetadata('hybridai/gpt-5.5');
  expect(flagship.known).toBe(true);
  expect(flagship.contextWindow).toBe(1_000_000);
  expect(flagship.maxTokens).toBe(128_000);
  expect(flagship.pricingUsdPerToken).toEqual({ input: null, output: null });
});

test('static context and vision lookups share versioned metadata', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir);
  const { catalog } = await importFreshCatalog(homeDir);

  expect(
    catalog.getModelCatalogMetadata('hybridai/gpt-5.4').contextWindow,
  ).toBe(1_050_000);
  expect(catalog.isModelVisionCapable('hybridai/gpt-5-nano')).toBe(true);
  expect(
    catalog.getModelCatalogMetadata('hybridai/gpt-5-nano').capabilities.vision,
  ).toBe(true);
});

test('model catalog metadata falls back safely for missing models', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir);
  const { catalog } = await importFreshCatalog(homeDir);

  const metadata = catalog.getModelCatalogMetadata(
    'unknown-provider/not-real-model',
  );

  expect(metadata).toMatchObject({
    known: false,
    pricingUsdPerToken: { input: null, output: null },
    contextWindow: null,
    maxTokens: null,
    capabilities: {
      vision: false,
      tools: false,
      jsonMode: false,
      reasoning: false,
    },
    sources: [],
  });
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
      { name: 'hybridai/gpt-5-ultra', value: 'hybridai/gpt-5-ultra' },
    ]),
  );
  expect(catalog.getAvailableModelList('hybridai')).toContain(
    'hybridai/gpt-5-ultra',
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('available model catalog merges the current default model with discovered local models', async () => {
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
      { name: 'hybridai/gpt-4.1-mini', value: 'hybridai/gpt-4.1-mini' },
      {
        name: 'lmstudio/qwen/qwen3.5-9b',
        value: 'lmstudio/qwen/qwen3.5-9b',
      },
    ]),
  );
  expect(catalog.getAvailableModelList('local')).toEqual([
    'lmstudio/qwen/qwen3.5-9b',
  ]);
  expect(
    catalog.getModelCatalogMetadata('lmstudio/qwen/qwen3.5-9b')
      .pricingUsdPerToken,
  ).toEqual({ input: 0, output: 0 });
  expect(catalog.getAvailableModelList('hybridai')).toContain(
    'hybridai/gpt-4.1-mini',
  );
});

test('available model catalog prefixes HybridAI provider-family models', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDAI_API_KEY = 'hai-model-catalog-provider-prefix';
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'mistral-small',
              provider: 'mistral',
              context_length: 131_072,
              pricing: {
                prompt: '0.000001',
                completion: '0.000002',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );

  const { catalog } = await importFreshCatalog(homeDir);
  const choices = await catalog.getAvailableModelChoices(25, {
    includeHybridAI: true,
  });

  expect(choices).toEqual(
    expect.arrayContaining([
      {
        name: 'hybridai/mistral/mistral-small',
        value: 'hybridai/mistral/mistral-small',
      },
    ]),
  );
  expect(catalog.getAvailableModelList('hybridai')).toContain(
    'hybridai/mistral/mistral-small',
  );
  expect(
    catalog.getModelCatalogMetadata('hybridai/mistral/mistral-small')
      .pricingUsdPerToken,
  ).toEqual({ input: 0.000001, output: 0.000002 });
});

test('model catalog selects the cheapest model matching capability flags', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDAI_API_KEY = 'hai-model-catalog-cheap-selector';
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'gpt-5',
              context_length: 400_000,
              pricing: {
                prompt: '0.00001',
                completion: '0.00003',
              },
            },
            {
              id: 'gpt-5-nano',
              context_length: 400_000,
              pricing: {
                prompt: '0.000001',
                completion: '0.000002',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );

  const { catalog } = await importFreshCatalog(homeDir);
  await catalog.refreshAvailableModelCatalogs({ includeHybridAI: true });

  expect(catalog.findCheapestModelMeetingCapabilities({ jsonMode: true })).toBe(
    'hybridai/gpt-5-nano',
  );
  expect(
    catalog
      .selectModelsByCapabilityAndCost({ jsonMode: true })
      .map((selection) => selection.model)
      .slice(0, 2),
  ).toEqual(['hybridai/gpt-5-nano', 'hybridai/gpt-5']);
});

test('available model catalog reloads OpenRouter discovery after 60 minutes', async () => {
  const homeDir = makeTempHome();
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-13T10:00:00Z'));
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = true;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });

  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.startsWith('https://openrouter.ai/api/v1/models')) {
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
        name: 'openrouter/beta/model-c:free',
        value: 'openrouter/beta/model-c:free',
      },
    ]),
  );
  expect(secondChoices).toEqual(firstChoices);
  expect(thirdChoices).toEqual(firstChoices);
  expect(fourthChoices).toEqual(firstChoices);
  expect(catalog.getAvailableModelList()).toEqual(
    expect.arrayContaining(['openrouter/beta/model-c:free']),
  );
  expect(catalog.getAvailableModelList('openrouter')).toEqual([
    'openrouter/beta/model-c:free',
    'openrouter/zeta/model-b',
  ]);
  expect(
    catalog.getModelCatalogMetadata('openrouter/zeta/model-b')
      .pricingUsdPerToken,
  ).toEqual({ input: 1, output: 1 });
  expect(catalog.getAvailableModelList('codex')).toEqual([]);
});

test('available model catalog discovers Codex models from the models endpoint', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });

  const { saveCodexAuthStore, extractExpiresAtFromJwt } = await import(
    '../src/auth/codex-auth.ts'
  );
  const accessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 600,
    chatgpt_account_id: 'acct_catalog',
  });
  saveCodexAuthStore(
    {
      version: 1,
      credentials: {
        accessToken,
        refreshToken: 'refresh_catalog',
        accountId: 'acct_catalog',
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

  const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    if (
      url.origin === 'https://chatgpt.com' &&
      url.pathname === '/backend-api/codex/models'
    ) {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'gpt-5-codex', context_window: 400_000 },
            { id: 'gpt-5.4', context_window: 400_000 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected URL: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { catalog } = await importFreshCatalog(homeDir);
  const choices = await catalog.getAvailableModelChoices(25);

  expect(choices).toEqual(
    expect.arrayContaining([
      {
        name: 'openai-codex/gpt-5-codex',
        value: 'openai-codex/gpt-5-codex',
      },
      {
        name: 'openai-codex/gpt-5.4',
        value: 'openai-codex/gpt-5.4',
      },
      {
        name: 'openai-codex/gpt-5.4-mini',
        value: 'openai-codex/gpt-5.4-mini',
      },
    ]),
  );
  expect(catalog.getAvailableModelList('codex')).toEqual([
    'openai-codex/gpt-5-codex',
    'openai-codex/gpt-5.1-codex-max',
    'openai-codex/gpt-5.1-codex-mini',
    'openai-codex/gpt-5.2-codex',
    'openai-codex/gpt-5.3-codex',
    'openai-codex/gpt-5.3-codex-spark',
    'openai-codex/gpt-5.4',
    'openai-codex/gpt-5.4-mini',
    'openai-codex/gpt-5.5',
  ]);
  const codexRequest = fetchMock.mock.calls
    .map(([input, init]) => ({
      url: new URL(String(input)),
      init: init as RequestInit | undefined,
    }))
    .find(
      ({ url }) =>
        url.origin === 'https://chatgpt.com' &&
        url.pathname === '/backend-api/codex/models',
    );
  expect(codexRequest).toBeDefined();
  expect(codexRequest?.url.searchParams.get('client_version')).toBeTruthy();
  expect(codexRequest?.init?.headers).toMatchObject({
    Authorization: `Bearer ${accessToken}`,
    'Chatgpt-Account-Id': 'acct_catalog',
    'OpenAI-Beta': 'responses=experimental',
  });
  expect(
    catalog.getModelCatalogMetadata('openai-codex/gpt-5-codex')
      .pricingUsdPerToken,
  ).toEqual({ input: 0, output: 0 });
});

test('available model catalog discovers Anthropic models from /v1/models', async () => {
  const homeDir = makeTempHome();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-model-catalog-test';
  writeRuntimeConfig(homeDir, (config) => {
    config.anthropic.enabled = true;
    config.anthropic.method = 'api-key';
    config.anthropic.models = ['anthropic/old-configured-model'];
  });

  const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    if (
      url.origin === 'https://api.anthropic.com' &&
      url.pathname === '/v1/models'
    ) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'claude-opus-4-20250514',
              max_input_tokens: 200_000,
              max_tokens: 32_000,
              pricing: { input_per_million: 15, output_per_million: 75 },
              capabilities: { vision: true },
            },
            {
              id: 'claude-sonnet-4-20250514',
              max_input_tokens: 200_000,
              max_tokens: 64_000,
            },
          ],
          has_more: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected URL: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { catalog } = await importFreshCatalog(homeDir);
  await catalog.refreshAvailableModelCatalogs();
  const models = catalog.getAvailableModelList('anthropic');

  expect(models).toEqual([
    'anthropic/claude-opus-4-20250514',
    'anthropic/claude-sonnet-4-20250514',
  ]);
  expect(catalog.isModelVisionCapable('anthropic/claude-opus-4-20250514')).toBe(
    true,
  );
  expect(
    catalog.getModelCatalogMetadata('anthropic/claude-opus-4-20250514')
      .pricingUsdPerToken,
  ).toEqual({ input: 15 / 1_000_000, output: 75 / 1_000_000 });
  const anthropicRequest = fetchMock.mock.calls
    .map(([input, init]) => ({
      url: new URL(String(input)),
      init: init as RequestInit | undefined,
    }))
    .find(
      ({ url }) =>
        url.origin === 'https://api.anthropic.com' &&
        url.pathname === '/v1/models',
    );
  expect(anthropicRequest?.init?.headers).toMatchObject({
    'x-api-key': 'sk-ant-model-catalog-test',
    'anthropic-version': '2023-06-01',
  });
});

test('available model catalog uses bearer auth for Anthropic OAuth tokens in api-key mode', async () => {
  const homeDir = makeTempHome();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-oat-model-catalog-test';
  writeRuntimeConfig(homeDir, (config) => {
    config.anthropic.enabled = true;
    config.anthropic.method = 'api-key';
    config.anthropic.models = ['anthropic/old-configured-model'];
  });

  const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    if (
      url.origin === 'https://api.anthropic.com' &&
      url.pathname === '/v1/models'
    ) {
      return new Response(
        JSON.stringify({
          data: [{ id: 'claude-sonnet-4-6' }],
          has_more: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected URL: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { catalog } = await importFreshCatalog(homeDir);
  await catalog.refreshAvailableModelCatalogs();

  expect(catalog.getAvailableModelList('anthropic')).toEqual([
    'anthropic/claude-sonnet-4-6',
  ]);
  expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
    Authorization: 'Bearer sk-ant-oat-model-catalog-test',
    'anthropic-version': '2023-06-01',
    'x-app': 'cli',
  });
  expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('x-api-key');
});

test('available model catalog falls back to configured Anthropic models when discovery fails', async () => {
  const homeDir = makeTempHome();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-model-catalog-test';
  writeRuntimeConfig(homeDir, (config) => {
    config.anthropic.enabled = true;
    config.anthropic.method = 'api-key';
    config.anthropic.models = ['anthropic/claude-sonnet-4-6'];
  });

  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (
      url.origin === 'https://api.anthropic.com' &&
      url.pathname === '/v1/models'
    ) {
      return new Response(JSON.stringify({ error: 'unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected URL: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { catalog } = await importFreshCatalog(homeDir);
  await catalog.refreshAvailableModelCatalogs();

  expect(catalog.getAvailableModelList('anthropic')).toEqual([
    'anthropic/claude-sonnet-4-6',
  ]);
  expect(catalog.getAvailableModelList()).toContain(
    'anthropic/claude-sonnet-4-6',
  );
});

test('available model catalog uses Claude CLI auth for Anthropic model discovery', async () => {
  const homeDir = makeTempHome();
  vi.doMock('../src/auth/anthropic-auth.js', () => ({
    requireAnthropicApiKey: vi.fn(() => {
      throw new Error('unexpected api-key auth');
    }),
    requireAnthropicClaudeCliCredential: vi.fn(() => ({
      type: 'oauth' as const,
      provider: 'anthropic' as const,
      accessToken: 'sk-ant-oat-model-catalog-test',
      refreshToken: 'refresh-test',
      expiresAt: Date.now() + 60_000,
      source: 'claude-cli-file' as const,
    })),
  }));
  writeRuntimeConfig(homeDir, (config) => {
    config.anthropic.enabled = true;
    config.anthropic.method = 'claude-cli';
    config.anthropic.models = ['anthropic/claude-sonnet-4-6'];
  });

  const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    if (
      url.origin === 'https://api.anthropic.com' &&
      url.pathname === '/v1/models'
    ) {
      return new Response(
        JSON.stringify({
          data: [{ id: 'claude-sonnet-4-6' }, { id: 'claude-opus-4-1' }],
          has_more: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected URL: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { catalog } = await importFreshCatalog(homeDir);
  await catalog.refreshAvailableModelCatalogs();
  const models = catalog.getAvailableModelList('anthropic');

  expect(models).toEqual([
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-opus-4-1',
  ]);
  expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
    Authorization: 'Bearer sk-ant-oat-model-catalog-test',
    'anthropic-version': '2023-06-01',
    'x-app': 'cli',
  });
});

test('available model catalog discovers Codex models from the current models payload', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  writeRuntimeConfig(homeDir, (config) => {
    config.openrouter.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });

  const { saveCodexAuthStore, extractExpiresAtFromJwt } = await import(
    '../src/auth/codex-auth.ts'
  );
  const accessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 600,
    chatgpt_account_id: 'acct_catalog_current_shape',
  });
  saveCodexAuthStore(
    {
      version: 1,
      credentials: {
        accessToken,
        refreshToken: 'refresh_catalog_current_shape',
        accountId: 'acct_catalog_current_shape',
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

  const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    if (
      url.origin === 'https://chatgpt.com' &&
      url.pathname === '/backend-api/codex/models'
    ) {
      return new Response(
        JSON.stringify({
          models: [
            {
              slug: 'gpt-5.2-codex',
              display_name: 'gpt-5.2-codex',
              supported_in_api: true,
              context_window: 272_000,
            },
            {
              display_name: 'GPT-5.2 Codex (Preview)',
              supported_in_api: true,
              context_window: 272_000,
            },
            {
              slug: 'internal-preview',
              display_name: 'internal-preview',
              supported_in_api: false,
              context_window: 1,
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
  const choices = await catalog.getAvailableModelChoices(25);

  expect(choices).toEqual(
    expect.arrayContaining([
      {
        name: 'openai-codex/gpt-5.2-codex',
        value: 'openai-codex/gpt-5.2-codex',
      },
      {
        name: 'openai-codex/gpt-5.3-codex',
        value: 'openai-codex/gpt-5.3-codex',
      },
      {
        name: 'openai-codex/gpt-5.3-codex-spark',
        value: 'openai-codex/gpt-5.3-codex-spark',
      },
      {
        name: 'openai-codex/gpt-5.4',
        value: 'openai-codex/gpt-5.4',
      },
      {
        name: 'openai-codex/gpt-5.4-mini',
        value: 'openai-codex/gpt-5.4-mini',
      },
    ]),
  );
  expect(catalog.getAvailableModelList('codex')).toEqual([
    'openai-codex/gpt-5.1-codex-max',
    'openai-codex/gpt-5.1-codex-mini',
    'openai-codex/gpt-5.2-codex',
    'openai-codex/gpt-5.3-codex',
    'openai-codex/gpt-5.3-codex-spark',
    'openai-codex/gpt-5.4',
    'openai-codex/gpt-5.4-mini',
    'openai-codex/gpt-5.5',
  ]);
  expect(catalog.getAvailableModelList('codex')).not.toContain(
    'openai-codex/GPT-5.2 Codex (Preview)',
  );
  const codexRequest = fetchMock.mock.calls
    .map(([input, init]) => ({
      url: new URL(String(input)),
      init: init as RequestInit | undefined,
    }))
    .find(
      ({ url }) =>
        url.origin === 'https://chatgpt.com' &&
        url.pathname === '/backend-api/codex/models',
    );
  expect(codexRequest).toBeDefined();
  expect(codexRequest?.url.searchParams.get('client_version')).toBeTruthy();
  expect(codexRequest?.init?.headers).toMatchObject({
    Authorization: `Bearer ${accessToken}`,
    'Chatgpt-Account-Id': 'acct_catalog_current_shape',
    'OpenAI-Beta': 'responses=experimental',
  });
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
  expect(catalog.getAvailableModelList('huggingface')).toEqual(
    catalog.getAvailableModelList('huggingface'),
  );
});

test('available model catalog requires Mistral discovery data', async () => {
  const homeDir = makeTempHome();
  writeRuntimeConfig(homeDir, (config) => {
    config.mistral.enabled = true;
    config.mistral.models = [
      'mistral/mistral-large-latest',
      'mistral/codestral-latest',
    ];
    config.openrouter.enabled = false;
    config.huggingface.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });

  const { catalog } = await importFreshCatalog(homeDir);

  expect(catalog.getAvailableModelList('mistral')).toEqual([]);
});

test('available model catalog merges discovered Mistral models from /models', async () => {
  const homeDir = makeTempHome();
  process.env.MISTRAL_API_KEY = 'mistral-model-catalog-test';
  writeRuntimeConfig(homeDir, (config) => {
    config.mistral.enabled = true;
    config.openrouter.enabled = false;
    config.huggingface.enabled = false;
    config.local.backends.ollama.enabled = false;
    config.local.backends.lmstudio.enabled = false;
    config.local.backends.vllm.enabled = false;
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/models')) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer mistral-model-catalog-test',
        });
        return new Response(
          JSON.stringify([
            {
              id: 'codestral-2501',
              deprecation: '2026-05-31T12:00:00Z',
              max_context_length: 256_000,
            },
            {
              id: 'pixtral-large-latest',
              name: 'pixtral-large-2411',
              aliases: ['pixtral-large-2411'],
              archived: true,
              max_context_length: 131_072,
              capabilities: {
                vision: true,
              },
            },
            {
              id: 'mistral-medium-latest',
              name: 'mistral-medium-2508',
              aliases: ['mistral-medium-2508', 'mistral-medium'],
              max_context_length: 131_072,
              pricing: { prompt: '0.000002', completion: '0.000006' },
            },
            {
              id: 'mistral-medium-2508',
              name: 'mistral-medium-2508',
              aliases: ['mistral-medium-latest', 'mistral-medium'],
              max_context_length: 131_072,
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${input}`);
    }),
  );

  const { catalog } = await importFreshCatalog(homeDir);
  await catalog.refreshAvailableModelCatalogs();

  expect(catalog.getAvailableModelList('mistral')).toEqual([
    'mistral/mistral-medium-2508',
  ]);
  expect(catalog.getAvailableModelList('mistral')).not.toContain(
    'mistral/codestral-2501',
  );
  expect(catalog.getAvailableModelList('mistral')).not.toContain(
    'mistral/pixtral-large-2411',
  );
  expect(catalog.getAvailableModelList('mistral')).not.toContain(
    'mistral/pixtral-large-latest',
  );
  expect(catalog.getAvailableModelList('mistral')).not.toContain(
    'mistral/mistral-medium-latest',
  );
  expect(
    catalog.getModelCatalogMetadata('mistral/mistral-medium-2508')
      .pricingUsdPerToken,
  ).toEqual({ input: 0.000002, output: 0.000006 });
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
                    pricing: {
                      input_per_million: 0.07,
                      output_per_million: 0.21,
                    },
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
  expect(
    discovery.getDiscoveredHuggingFaceModelPricingUsdPerToken(
      'huggingface/XiaomiMiMo/MiMo-V2-Flash',
    ),
  ).toEqual({ input: 0.07 / 1_000_000, output: 0.21 / 1_000_000 });
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
