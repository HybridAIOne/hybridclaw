import { afterEach, describe, expect, test, vi } from 'vitest';

const logger = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../src/logger.js', () => ({ logger }));

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
  return import('../src/providers/hybridai-discovery.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/auth/hybridai-auth.js');
  vi.doUnmock('../src/config/config.js');
  logger.warn.mockClear();
  vi.resetModules();
});

describe('hybridai discovery', () => {
  test('binds exact destination IDs and refuses unbound requests after discovery failure', async () => {
    const destination = {
      protocol: 'hybridai-destination-v1',
      id: 'example-eu',
      zone: 'region',
      operator: 'Example operator',
      region: 'EU',
      retention: 'none',
      fallback: 'deny',
      apiBaseUrl: 'https://hybridai.one',
    };
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'example-model', zone: 'region', destination }],
          }),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    const { createHybridAIDiscoveryStore } = await importFreshDiscovery();
    const store = createHybridAIDiscoveryStore();
    await store.discoverModels({ force: true });
    expect(store.getModelDestination('hybridai/example-model')).toEqual(
      destination,
    );
    expect(store.getModelDestination('other/example-model')).toBeNull();
    expect(store.getModelZone('example-model')).toBe('region');
    fetch.mockImplementation(
      async () => new Response('unavailable', { status: 503 }),
    );
    await store.discoverModels({ force: true });
    expect(() => store.getModelDestination('hybridai/example-model')).toThrow(
      'refusing an unbound request',
    );
  });

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
                  max_output_tokens: 16_000,
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
    expect(store.getModelMaxTokens('mistral-small')).toBe(16_000);
  });

  test('keeps ambiguous unprefixed HybridAI tail lookups unresolved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'mistral/small',
                  context_length: 128_000,
                },
                {
                  id: 'anthropic/small',
                  context_length: 256_000,
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

    await store.discoverModels({ force: true });

    expect(store.getModelContextWindow('small')).toBeNull();
    expect(store.getModelContextWindow('mistral/small')).toBe(128_000);
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
    const store = discovery.createHybridAIDiscoveryStore();

    await expect(store.discoverModels({ force: true })).resolves.toEqual([
      'hybridai/gpt-5-ultra',
    ]);
    await expect(store.discoverModels({ force: true })).resolves.toEqual([
      'hybridai/gpt-5-ultra',
    ]);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { error: 'network down' },
      'HybridAI model discovery failed',
    );
  });
});
