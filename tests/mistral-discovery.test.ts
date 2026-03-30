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
  test('reads model ids, context windows, and vision capability from /models', async () => {
    process.env.MISTRAL_API_KEY = 'mistral-discovery-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
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

  test('accepts object payloads with data arrays for forward compatibility', async () => {
    process.env.MISTRAL_API_KEY = 'mistral-discovery-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'codestral-latest',
                  max_context_length: 256_000,
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
      'mistral/codestral-latest',
    ]);
    expect(store.getModelContextWindow('mistral/codestral-latest')).toBe(
      256_000,
    );
  });

  test('filters deprecated Mistral models from discovery results', async () => {
    process.env.MISTRAL_API_KEY = 'mistral-discovery-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: 'codestral-2501',
                max_context_length: 256_000,
              },
              {
                id: 'mistral-medium-latest',
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
      'mistral/mistral-medium-latest',
    ]);
    expect(store.getModelContextWindow('mistral/codestral-2501')).toBeNull();
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
