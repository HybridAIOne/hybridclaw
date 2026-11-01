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
  test.each<[Record<string, unknown>, boolean | null]>([
    [{ architecture: { modality: 'text->text' } }, false],
    [{ architecture: { modality: 'text->image' } }, false],
    [{ architecture: { modality: 'text+image->text' } }, true],
    [{ architecture: { input_modalities: ['text', 'image'] } }, true],
    [{ architecture: { input_modalities: ['text', ' Image '] } }, true],
    [{ architecture: { input_modalities: ['text'] } }, false],
    [{ capabilities: ['vision'] }, true],
    [{ capabilities: ['tools'] }, null],
    [{ architecture: { input_modalities: [] } }, null],
    [{ architecture: { modality: 42, input_modalities: [null] } }, null],
    [{ context_length: 200_000 }, null],
  ])(
    'preserves explicit and unknown visual capability: %j',
    async (metadata, expected) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                data: [{ id: 'example/model', ...metadata }],
              }),
            ),
        ),
      );
      const { createOpenRouterDiscoveryStore } = await importFreshDiscovery();
      const store = createOpenRouterDiscoveryStore();
      await store.discoverModels();
      expect(store.getModelVisionCapability('example/model')).toBe(expected);
      expect(store.getModelVisionCapability('openrouter/example/model')).toBe(
        expected,
      );
      expect(store.getModelVisionCapability('example/missing')).toBeNull();
      expect(store.isModelVisionCapable('example/model')).toBe(
        expected === true,
      );
    },
  );

  test('normalizes model ids when checking whether a discovered model is free', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'anthropic/claude-3.5-sonnet',
                  pricing: {
                    prompt: '0',
                    completion: '0',
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
    const store = discovery.createOpenRouterDiscoveryStore();

    await expect(store.discoverModels({ force: true })).resolves.toEqual([
      'openrouter/anthropic/claude-3.5-sonnet',
    ]);
    expect(store.isModelFree('anthropic/claude-3.5-sonnet')).toBe(true);
    expect(store.isModelFree('openrouter/anthropic/claude-3.5-sonnet')).toBe(
      true,
    );
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
