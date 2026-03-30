import { afterEach, describe, expect, test, vi } from 'vitest';

async function importFreshDiscovery() {
  vi.resetModules();
  vi.doMock('../src/config/config.js', () => ({
    MISTRAL_BASE_URL: 'https://api.mistral.ai/v1',
    MISTRAL_ENABLED: true,
    MISTRAL_API_KEY: '',
    refreshRuntimeSecretsFromEnv: vi.fn(),
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
  return import('../src/providers/mistral-discovery.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/logger.js');
  delete process.env.MISTRAL_API_KEY;
  vi.resetModules();
});

describe('mistral discovery', () => {
  test('reads model ids, context windows, and vision capability from wrapped /models responses', async () => {
    process.env.MISTRAL_API_KEY = 'mistral-discovery-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              object: 'list',
              data: [
                {
                  id: 'mistral-small-latest',
                  max_context_length: 131_072,
                  capabilities: {
                    vision: false,
                  },
                },
                {
                  id: 'pixtral-large-latest',
                  max_context_length: 262_144,
                  capabilities: {
                    vision: true,
                  },
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
    const store = discovery.createMistralDiscoveryStore();

    await expect(store.discoverModels()).resolves.toEqual([
      'mistral/mistral-small-latest',
      'mistral/pixtral-large-latest',
    ]);
    expect(store.getModelContextWindow('mistral/pixtral-large-latest')).toBe(
      262_144,
    );
    expect(store.isModelVisionCapable('mistral/pixtral-large-latest')).toBe(
      true,
    );
    expect(store.isModelVisionCapable('mistral/mistral-small-latest')).toBe(
      false,
    );
  });

  test('collapses alias-bearing Mistral models to their canonical display name', async () => {
    process.env.MISTRAL_API_KEY = 'mistral-discovery-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: 'mistral-medium-latest',
                name: 'mistral-medium-2508',
                aliases: ['mistral-medium-2508', 'mistral-medium'],
                max_context_length: 131_072,
              },
              {
                id: 'mistral-medium-2508',
                name: 'mistral-medium-2508',
                aliases: ['mistral-medium-latest', 'mistral-medium'],
                max_context_length: 131_072,
              },
            ]),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      ),
    );

    const discovery = await importFreshDiscovery();
    const store = discovery.createMistralDiscoveryStore();

    await expect(store.discoverModels()).resolves.toEqual([
      'mistral/mistral-medium-2508',
    ]);
    expect(
      store.resolveCanonicalModelName('mistral/mistral-medium-latest'),
    ).toBe('mistral/mistral-medium-2508');
    expect(store.getModelContextWindow('mistral/mistral-medium')).toBe(131_072);
  });

  test('collapses empty-alias duplicate rows onto their canonical named model', async () => {
    process.env.MISTRAL_API_KEY = 'mistral-discovery-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              object: 'list',
              data: [
                {
                  id: 'mistral-large-2512',
                  name: 'mistral-large-2512',
                  aliases: [],
                  max_context_length: 262_144,
                },
                {
                  id: 'mistral-large-latest',
                  name: 'mistral-large-2512',
                  aliases: [],
                  max_context_length: 262_144,
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
    const store = discovery.createMistralDiscoveryStore();

    await expect(store.discoverModels()).resolves.toEqual([
      'mistral/mistral-large-2512',
    ]);
    expect(
      store.resolveCanonicalModelName('mistral/mistral-large-latest'),
    ).toBe('mistral/mistral-large-2512');
    expect(store.getModelContextWindow('mistral/mistral-large-latest')).toBe(
      262_144,
    );
  });

  test('filters deprecated and archived Mistral models from discovery results', async () => {
    process.env.MISTRAL_API_KEY = 'mistral-discovery-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
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
              },
              {
                id: 'mistral-small-2603',
                max_context_length: 131_072,
              },
            ]),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      ),
    );

    const discovery = await importFreshDiscovery();
    const store = discovery.createMistralDiscoveryStore();

    await expect(store.discoverModels()).resolves.toEqual([
      'mistral/mistral-small-2603',
    ]);
    expect(store.isModelDeprecated('mistral/codestral-2501')).toBe(true);
    expect(store.isModelDeprecated('mistral/pixtral-large-2411')).toBe(true);
  });

  test('logs a warning and returns stale models when discovery refresh fails', async () => {
    process.env.MISTRAL_API_KEY = 'mistral-discovery-test';
    const fetchMock = vi
      .fn(async () => {
        throw new Error('network down');
      })
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: 'mistral-large-latest',
                max_context_length: 131_072,
              },
            ]),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await importFreshDiscovery();
    const { logger } = await import('../src/logger.js');
    const store = discovery.createMistralDiscoveryStore();

    await expect(store.discoverModels({ force: true })).resolves.toEqual([
      'mistral/mistral-large-latest',
    ]);
    await expect(store.discoverModels({ force: true })).resolves.toEqual([
      'mistral/mistral-large-latest',
    ]);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Mistral model discovery failed',
    );
  });
});
