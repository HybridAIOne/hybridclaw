import { afterEach, describe, expect, test, vi } from 'vitest';

async function importFreshDiscovery() {
  vi.resetModules();
  vi.doMock('../src/auth/hybridai-auth.js', () => ({
    getHybridAIApiKey: vi.fn(() => 'hai-discovery-test'),
  }));
  vi.doMock('../src/config/config.js', () => ({
    HYBRIDAI_BASE_URL: 'https://hybridai.one',
    MissingRequiredEnvVarError: class MissingRequiredEnvVarError extends Error {
      envVar: string;

      constructor(envVar: string) {
        super(`Missing required env var: ${envVar}`);
        this.envVar = envVar;
      }
    },
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: vi.fn(),
    },
  }));
  return import('../src/providers/hybridai-discovery.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/auth/hybridai-auth.js');
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
});

describe('hybridai discovery', () => {
  test('reads HybridAI context windows from context_length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ id: 'gpt-5-ultra', context_length: 512_000 }],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      ),
    );

    const discovery = await importFreshDiscovery();
    const store = discovery.createHybridAIDiscoveryStore();

    await expect(store.discoverModels()).resolves.toEqual([
      'hybridai/gpt-5-ultra',
    ]);
    expect(store.getModelContextWindow('gpt-5-ultra')).toBe(512_000);
    expect(store.getModelContextWindow('hybridai/gpt-5-ultra')).toBe(512_000);
  });

  test('ignores speculative HybridAI context window fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'gpt-5-ultra',
                  max_context_length: 512_000,
                  limits: { context_window: 256_000 },
                },
              ],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      ),
    );

    const discovery = await importFreshDiscovery();
    const store = discovery.createHybridAIDiscoveryStore();

    await expect(store.discoverModels()).resolves.toEqual([
      'hybridai/gpt-5-ultra',
    ]);
    expect(store.getModelContextWindow('gpt-5-ultra')).toBeNull();
  });

  test('ignores speculative HybridAI model identifier fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: 'gpt-5-ultra' },
                { model: 'gpt-5-mini' },
                { name: 'gpt-5-nano' },
                { key: 'gpt-5.4' },
              ],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      ),
    );

    const discovery = await importFreshDiscovery();
    const store = discovery.createHybridAIDiscoveryStore();

    await expect(store.discoverModels()).resolves.toEqual([
      'hybridai/gpt-5-ultra',
    ]);
  });

  test('prefixes provider-family HybridAI models for the catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'mistral-small',
                  provider: 'mistral',
                  context_length: 128_000,
                },
              ],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      ),
    );

    const discovery = await importFreshDiscovery();
    const store = discovery.createHybridAIDiscoveryStore();

    await expect(store.discoverModels()).resolves.toEqual([
      'hybridai/mistral/mistral-small',
    ]);
    expect(store.getModelContextWindow('hybridai/mistral/mistral-small')).toBe(
      128_000,
    );
    expect(store.getModelContextWindow('mistral-small')).toBe(128_000);
  });

  test('logs a warning and returns stale models when discovery refresh fails', async () => {
    const fetchMock = vi
      .fn(async () => {
        throw new Error('network down');
      })
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ id: 'gpt-5-ultra', context_length: 512_000 }],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await importFreshDiscovery();
    const { logger } = await import('../src/logger.js');
    const store = discovery.createHybridAIDiscoveryStore();

    await expect(store.discoverModels({ force: true })).resolves.toEqual([
      'hybridai/gpt-5-ultra',
    ]);
    await expect(store.discoverModels({ force: true })).resolves.toEqual([
      'hybridai/gpt-5-ultra',
    ]);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'HybridAI model discovery failed',
    );
  });
});
