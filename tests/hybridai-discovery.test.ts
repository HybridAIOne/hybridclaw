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
  return import('../src/providers/hybridai-discovery.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/auth/hybridai-auth.js');
  vi.doUnmock('../src/config/config.js');
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

    await expect(store.discoverModels()).resolves.toEqual(['gpt-5-ultra']);
    expect(store.getModelContextWindow('gpt-5-ultra')).toBe(512_000);
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

    await expect(store.discoverModels()).resolves.toEqual(['gpt-5-ultra']);
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

    await expect(store.discoverModels()).resolves.toEqual(['gpt-5-ultra']);
  });
});
