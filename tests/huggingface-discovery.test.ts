import { afterEach, describe, expect, test, vi } from 'vitest';

async function importFreshDiscovery() {
  vi.resetModules();
  vi.doMock('../src/config/config.js', () => ({
    HUGGINGFACE_BASE_URL: 'https://router.huggingface.co/v1',
    HUGGINGFACE_ENABLED: true,
    HUGGINGFACE_API_KEY: '',
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
  return import('../src/providers/huggingface-discovery.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/logger.js');
  delete process.env.HF_TOKEN;
  delete process.env.HUGGINGFACE_API_KEY;
  vi.resetModules();
});

describe('huggingface discovery', () => {
  test('reads Hugging Face context windows from providers[].context_length', async () => {
    process.env.HF_TOKEN = 'hf-discovery-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'XiaomiMiMo/MiMo-V2-Flash',
                  providers: [
                    {
                      provider: 'novita',
                      context_length: 262_144,
                    },
                  ],
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
    const store = discovery.createHuggingFaceDiscoveryStore();

    await expect(store.discoverModels()).resolves.toEqual([
      'huggingface/XiaomiMiMo/MiMo-V2-Flash',
    ]);
    expect(
      store.getModelContextWindow('huggingface/XiaomiMiMo/MiMo-V2-Flash'),
    ).toBe(262_144);
  });

  test('reads Hugging Face context windows from top-level context_length', async () => {
    process.env.HF_TOKEN = 'hf-discovery-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'meta-llama/Llama-3.1-8B-Instruct',
                  context_length: 131_072,
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
    const store = discovery.createHuggingFaceDiscoveryStore();

    await expect(store.discoverModels()).resolves.toEqual([
      'huggingface/meta-llama/Llama-3.1-8B-Instruct',
    ]);
    expect(
      store.getModelContextWindow(
        'huggingface/meta-llama/Llama-3.1-8B-Instruct',
      ),
    ).toBe(131_072);
  });

  test('ignores speculative Hugging Face context window fields', async () => {
    process.env.HF_TOKEN = 'hf-discovery-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'Qwen/Qwen3.5-27B',
                  contextLength: 262_144,
                  max_context_length: 262_144,
                  maxContextLength: 262_144,
                  providers: [{ provider: 'novita', contextLength: 262_144 }],
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
    const store = discovery.createHuggingFaceDiscoveryStore();

    await expect(store.discoverModels()).resolves.toEqual([
      'huggingface/Qwen/Qwen3.5-27B',
    ]);
    expect(
      store.getModelContextWindow('huggingface/Qwen/Qwen3.5-27B'),
    ).toBeNull();
  });

  test('logs a warning and returns stale models when discovery refresh fails', async () => {
    process.env.HF_TOKEN = 'hf-discovery-test';
    const fetchMock = vi
      .fn(async () => {
        throw new Error('network down');
      })
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'meta-llama/Llama-3.1-8B-Instruct',
                  context_length: 131_072,
                },
              ],
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
    const store = discovery.createHuggingFaceDiscoveryStore();

    await expect(store.discoverModels({ force: true })).resolves.toEqual([
      'huggingface/meta-llama/Llama-3.1-8B-Instruct',
    ]);
    await expect(store.discoverModels({ force: true })).resolves.toEqual([
      'huggingface/meta-llama/Llama-3.1-8B-Instruct',
    ]);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'HuggingFace model discovery failed',
    );
  });
});
