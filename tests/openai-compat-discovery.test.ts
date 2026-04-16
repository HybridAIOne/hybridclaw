import { afterEach, describe, expect, test, vi } from 'vitest';

const CONFIG_MOCK_PATH = '../src/config/config.js';
const LOGGER_MOCK_PATH = '../src/logger.js';
const DISCOVERY_MODULE_PATH = '../src/providers/openai-compat-discovery.ts';

/**
 * Build a config.js mock object covering every symbol the openai-compat
 * discovery module and provider registry read from config. Callers override
 * just the flags/keys they care about.
 */
function buildConfigMock(overrides: Record<string, unknown> = {}) {
  return {
    // Enabled flags — default all off; individual tests flip what they need.
    GEMINI_ENABLED: false,
    DEEPSEEK_ENABLED: false,
    XAI_ENABLED: false,
    ZAI_ENABLED: false,
    KIMI_ENABLED: false,
    MINIMAX_ENABLED: false,
    DASHSCOPE_ENABLED: false,
    XIAOMI_ENABLED: false,
    KILO_ENABLED: false,
    // Base URLs — shape doesn't matter for tests; they're only used to build
    // the fetch URL, which we assert via the mock.
    GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
    XAI_BASE_URL: 'https://api.x.ai/v1',
    ZAI_BASE_URL: 'https://api.z.ai/api/paas/v4',
    KIMI_BASE_URL: 'https://api.moonshot.ai/v1',
    MINIMAX_BASE_URL: 'https://api.minimax.io/v1',
    DASHSCOPE_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    XIAOMI_BASE_URL: 'https://api.xiaomimimo.com/v1',
    KILO_BASE_URL: 'https://api.kilo.ai/api/gateway',
    // Config-fallback API keys — default blank, tests set process.env.* when
    // they want an authenticated path.
    GEMINI_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    XAI_API_KEY: '',
    ZAI_API_KEY: '',
    KIMI_API_KEY: '',
    MINIMAX_API_KEY: '',
    DASHSCOPE_API_KEY: '',
    XIAOMI_API_KEY: '',
    KILO_API_KEY: '',
    refreshRuntimeSecretsFromEnv: vi.fn(),
    MissingRequiredEnvVarError: class MissingRequiredEnvVarError extends Error {
      envVar: string;

      constructor(envVar: string) {
        super(`Missing required env var: ${envVar}`);
        this.envVar = envVar;
      }
    },
    ...overrides,
  };
}

function mockModules(configOverrides: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.doMock(CONFIG_MOCK_PATH, () => buildConfigMock(configOverrides));
  vi.doMock(LOGGER_MOCK_PATH, () => ({
    logger: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  }));
}

async function importDiscovery() {
  return import(DISCOVERY_MODULE_PATH);
}

async function importRegistry() {
  return import('../src/providers/openai-compat-remote.ts');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PROVIDER_ENV_VARS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'ZAI_API_KEY',
  'GLM_API_KEY',
  'Z_AI_API_KEY',
  'KIMI_API_KEY',
  'MINIMAX_API_KEY',
  'DASHSCOPE_API_KEY',
  'XIAOMI_API_KEY',
  'KILO_API_KEY',
  'KILOCODE_API_KEY',
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock(CONFIG_MOCK_PATH);
  vi.doUnmock(LOGGER_MOCK_PATH);
  for (const name of PROVIDER_ENV_VARS) {
    delete process.env[name];
  }
  vi.resetModules();
});

describe('openai-compat discovery — per-provider store', () => {
  test('prepends the provider prefix to discovered OpenAI-shaped ids', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test';
    mockModules({ GEMINI_ENABLED: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          object: 'list',
          data: [
            { id: 'gemini-2.5-pro' },
            { id: 'gemini-2.5-flash' },
            { id: 'gemini-2.0-flash' },
          ],
        }),
      ),
    );

    const discovery = await importDiscovery();
    const { OPENAI_COMPAT_REMOTE_PROVIDERS } = await importRegistry();
    const geminiDef = OPENAI_COMPAT_REMOTE_PROVIDERS.find(
      (d) => d.id === 'gemini',
    );
    if (!geminiDef) throw new Error('gemini provider def missing');
    const store = discovery.createOpenAICompatDiscoveryStore(
      geminiDef,
      () => true,
    );

    await expect(store.discoverModels()).resolves.toEqual([
      'gemini/gemini-2.5-pro',
      'gemini/gemini-2.5-flash',
      'gemini/gemini-2.0-flash',
    ]);
    expect(store.getModelNames()).toEqual([
      'gemini/gemini-2.5-pro',
      'gemini/gemini-2.5-flash',
      'gemini/gemini-2.0-flash',
    ]);
  });

  test('does not double-prefix ids the API already namespaced (kilo proxy case)', async () => {
    process.env.KILO_API_KEY = 'kilo-test';
    mockModules({ KILO_ENABLED: true });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: 'kilo/anthropic/claude-sonnet-4.6' },
          { id: 'openai/gpt-5' },
          { id: 'KILO/google/gemini-2.5-pro' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await importDiscovery();
    const { OPENAI_COMPAT_REMOTE_PROVIDERS } = await importRegistry();
    const kiloDef = OPENAI_COMPAT_REMOTE_PROVIDERS.find(
      (d) => d.id === 'kilo',
    );
    if (!kiloDef) throw new Error('kilo provider def missing');
    const store = discovery.createOpenAICompatDiscoveryStore(
      kiloDef,
      () => true,
    );

    await expect(store.discoverModels()).resolves.toEqual([
      'kilo/anthropic/claude-sonnet-4.6',
      'kilo/openai/gpt-5',
      'KILO/google/gemini-2.5-pro',
    ]);

    // Discovery should resolve to `<baseUrl>/models` for kilo (no override).
    const url = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(url).toBe('https://api.kilo.ai/api/gateway/models');
  });

  test('parses bare-array and {models: []} response shapes', async () => {
    process.env.DEEPSEEK_API_KEY = 'deepseek-test';
    mockModules({ DEEPSEEK_ENABLED: true });

    // First: bare array.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse([{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }]),
      ),
    );
    let discovery = await importDiscovery();
    const { OPENAI_COMPAT_REMOTE_PROVIDERS: regA } = await importRegistry();
    const defA = regA.find((d) => d.id === 'deepseek');
    if (!defA) throw new Error('deepseek def missing');
    const storeA = discovery.createOpenAICompatDiscoveryStore(defA, () => true);
    await expect(storeA.discoverModels()).resolves.toEqual([
      'deepseek/deepseek-chat',
      'deepseek/deepseek-reasoner',
    ]);

    // Second: {models: []} shape on a fresh store.
    vi.unstubAllGlobals();
    vi.resetModules();
    mockModules({ DEEPSEEK_ENABLED: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
        }),
      ),
    );
    discovery = await importDiscovery();
    const { OPENAI_COMPAT_REMOTE_PROVIDERS: regB } = await importRegistry();
    const defB = regB.find((d) => d.id === 'deepseek');
    if (!defB) throw new Error('deepseek def missing');
    const storeB = discovery.createOpenAICompatDiscoveryStore(defB, () => true);
    await expect(storeB.discoverModels()).resolves.toEqual([
      'deepseek/deepseek-chat',
      'deepseek/deepseek-reasoner',
    ]);
  });

  test('returns empty and does not fetch when the provider is disabled', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test';
    mockModules({ GEMINI_ENABLED: false });
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'gemini-2.5-pro' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await importDiscovery();
    const { OPENAI_COMPAT_REMOTE_PROVIDERS } = await importRegistry();
    const geminiDef = OPENAI_COMPAT_REMOTE_PROVIDERS.find(
      (d) => d.id === 'gemini',
    );
    if (!geminiDef) throw new Error('gemini provider def missing');
    const store = discovery.createOpenAICompatDiscoveryStore(
      geminiDef,
      () => false,
    );

    await expect(store.discoverModels()).resolves.toEqual([]);
    expect(store.getModelNames()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('returns empty and does not fetch when the API key is missing', async () => {
    mockModules({ GEMINI_ENABLED: true });
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'gemini-2.5-pro' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await importDiscovery();
    const { OPENAI_COMPAT_REMOTE_PROVIDERS } = await importRegistry();
    const geminiDef = OPENAI_COMPAT_REMOTE_PROVIDERS.find(
      (d) => d.id === 'gemini',
    );
    if (!geminiDef) throw new Error('gemini provider def missing');
    const store = discovery.createOpenAICompatDiscoveryStore(
      geminiDef,
      () => true,
    );

    await expect(store.discoverModels()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('serves a cached result on subsequent calls within the TTL window', async () => {
    process.env.XAI_API_KEY = 'xai-test';
    mockModules({ XAI_ENABLED: true });
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'grok-3' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await importDiscovery();
    const { OPENAI_COMPAT_REMOTE_PROVIDERS } = await importRegistry();
    const xaiDef = OPENAI_COMPAT_REMOTE_PROVIDERS.find((d) => d.id === 'xai');
    if (!xaiDef) throw new Error('xai provider def missing');
    const store = discovery.createOpenAICompatDiscoveryStore(
      xaiDef,
      () => true,
    );

    await store.discoverModels();
    await store.discoverModels();
    await store.discoverModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.getModelNames()).toEqual(['xai/grok-3']);
  });

  test('deduplicates concurrent discoverModels calls to a single fetch', async () => {
    process.env.KIMI_API_KEY = 'kimi-test';
    mockModules({ KIMI_ENABLED: true });
    let resolveFetch: (value: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await importDiscovery();
    const { OPENAI_COMPAT_REMOTE_PROVIDERS } = await importRegistry();
    const kimiDef = OPENAI_COMPAT_REMOTE_PROVIDERS.find(
      (d) => d.id === 'kimi',
    );
    if (!kimiDef) throw new Error('kimi provider def missing');
    const store = discovery.createOpenAICompatDiscoveryStore(
      kimiDef,
      () => true,
    );

    const a = store.discoverModels();
    const b = store.discoverModels();
    const c = store.discoverModels();
    resolveFetch(jsonResponse({ data: [{ id: 'kimi-k2.5' }] }));
    const [ra, rb, rc] = await Promise.all([a, b, c]);

    expect(ra).toEqual(['kimi/kimi-k2.5']);
    expect(rb).toEqual(['kimi/kimi-k2.5']);
    expect(rc).toEqual(['kimi/kimi-k2.5']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('logs a warning and returns stale models when fetch fails', async () => {
    process.env.ZAI_API_KEY = 'zai-test';
    mockModules({ ZAI_ENABLED: true });
    const fetchMock = vi
      .fn(async () => {
        throw new Error('network down');
      })
      .mockImplementationOnce(async () =>
        jsonResponse({ data: [{ id: 'glm-5' }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await importDiscovery();
    const { logger } = await import(LOGGER_MOCK_PATH);
    const { OPENAI_COMPAT_REMOTE_PROVIDERS } = await importRegistry();
    const zaiDef = OPENAI_COMPAT_REMOTE_PROVIDERS.find((d) => d.id === 'zai');
    if (!zaiDef) throw new Error('zai provider def missing');
    const store = discovery.createOpenAICompatDiscoveryStore(
      zaiDef,
      () => true,
    );

    await expect(store.discoverModels({ force: true })).resolves.toEqual([
      'zai/glm-5',
    ]);
    await expect(store.discoverModels({ force: true })).resolves.toEqual([
      'zai/glm-5',
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), provider: 'zai' },
      'OpenAI-compat model discovery failed',
    );
  });

  test('logs 404 responses at debug level, not warn (provider without /v1/models)', async () => {
    process.env.KILO_API_KEY = 'kilo-test';
    mockModules({ KILO_ENABLED: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );

    const discovery = await importDiscovery();
    const { logger } = await import(LOGGER_MOCK_PATH);
    const { OPENAI_COMPAT_REMOTE_PROVIDERS } = await importRegistry();
    const kiloDef = OPENAI_COMPAT_REMOTE_PROVIDERS.find(
      (d) => d.id === 'kilo',
    );
    if (!kiloDef) throw new Error('kilo provider def missing');
    const store = discovery.createOpenAICompatDiscoveryStore(
      kiloDef,
      () => true,
    );

    await expect(store.discoverModels()).resolves.toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({ httpStatus: 404 }),
        provider: 'kilo',
        httpStatus: 404,
      },
      'OpenAI-compat model discovery not supported by provider',
    );
  });

  test('logs 5xx responses at warn level', async () => {
    process.env.DASHSCOPE_API_KEY = 'dashscope-test';
    mockModules({ DASHSCOPE_ENABLED: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );

    const discovery = await importDiscovery();
    const { logger } = await import(LOGGER_MOCK_PATH);
    const { OPENAI_COMPAT_REMOTE_PROVIDERS } = await importRegistry();
    const def = OPENAI_COMPAT_REMOTE_PROVIDERS.find(
      (d) => d.id === 'dashscope',
    );
    if (!def) throw new Error('dashscope provider def missing');
    const store = discovery.createOpenAICompatDiscoveryStore(def, () => true);

    await expect(store.discoverModels()).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  test('silently ignores non-OpenAI-compat response shapes and non-string ids', async () => {
    process.env.MINIMAX_API_KEY = 'minimax-test';
    mockModules({ MINIMAX_ENABLED: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          // Garbage shape: neither `data`, nor `models`, nor a top-level array.
          something_else: [{ id: 'ignored' }],
          data: [
            { id: 'abab6.5s-chat' },
            { id: '' }, // dropped: empty id
            { id: 123 }, // dropped: non-string
            { not_an_id: 'foo' }, // dropped: missing id
            'raw-string', // dropped: not a record
          ],
        }),
      ),
    );

    const discovery = await importDiscovery();
    const { OPENAI_COMPAT_REMOTE_PROVIDERS } = await importRegistry();
    const minimaxDef = OPENAI_COMPAT_REMOTE_PROVIDERS.find(
      (d) => d.id === 'minimax',
    );
    if (!minimaxDef) throw new Error('minimax provider def missing');
    const store = discovery.createOpenAICompatDiscoveryStore(
      minimaxDef,
      () => true,
    );

    await expect(store.discoverModels()).resolves.toEqual([
      'minimax/abab6.5s-chat',
    ]);
  });
});

describe('openai-compat discovery — module-level registry', () => {
  test('Promise.allSettled isolates one provider failure from the others', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test';
    process.env.KILO_API_KEY = 'kilo-test';
    mockModules({
      GEMINI_ENABLED: true,
      KILO_ENABLED: true,
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      // Kilo discovery lives at the marketplace gateway host.
      if (url.includes('api.kilo.ai')) {
        throw new Error('kilo api down');
      }
      return jsonResponse({ data: [{ id: 'gemini-2.5-pro' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await importDiscovery();

    await expect(
      discovery.discoverOpenAICompatRemoteModels(),
    ).resolves.toBeUndefined();

    const names = discovery.getDiscoveredOpenAICompatRemoteModelNames();
    expect(names).toContain('gemini/gemini-2.5-pro');
    expect(names.some((n: string) => n.startsWith('kilo/'))).toBe(false);
  });

  test('skips disabled providers entirely during bulk discovery', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test';
    process.env.KILO_API_KEY = 'kilo-test';
    mockModules({
      GEMINI_ENABLED: true,
      KILO_ENABLED: false,
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'gemini-2.5-pro' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await importDiscovery();
    await discovery.discoverOpenAICompatRemoteModels();

    // Only the gemini endpoint should have been hit; kilo is off.
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes('generativelanguage.googleapis.com')))
      .toBe(true);
    expect(urls.some((u) => u.includes('api.kilo.ai'))).toBe(false);
  });
});
