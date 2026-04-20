import { afterEach, describe, expect, test, vi } from 'vitest';

async function importFreshDiscovery() {
  vi.resetModules();
  vi.doMock('../src/config/config.js', () => ({
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENROUTER_ENABLED: true,
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: vi.fn(),
    },
  }));
  vi.doMock('../src/providers/openai-compat-remote.js', () => ({
    readApiKeyForOpenAICompatProvider: vi.fn(() => 'openrouter-test'),
  }));
  return import('../src/providers/openrouter-discovery.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/logger.js');
  vi.doUnmock('../src/providers/openai-compat-remote.js');
  vi.resetModules();
});

describe('openrouter discovery', () => {
  test('logs a warning and returns stale models when discovery refresh fails', async () => {
    const fetchMock = vi
      .fn(async () => {
        throw new Error('network down');
      })
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ id: 'openai/gpt-5', context_length: 400_000 }],
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
    const store = discovery.createOpenRouterDiscoveryStore();

    await expect(store.discoverModels({ force: true })).resolves.toEqual([
      'openrouter/openai/gpt-5',
    ]);
    await expect(store.discoverModels({ force: true })).resolves.toEqual([
      'openrouter/openai/gpt-5',
    ]);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'OpenRouter model discovery failed',
    );
  });
});
