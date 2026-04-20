import { afterEach, describe, expect, test, vi } from 'vitest';

async function importFreshDiscovery() {
  vi.resetModules();
  vi.doMock('../src/auth/codex-auth.js', () => ({
    getCodexAuthStatus: vi.fn(() => ({
      authenticated: true,
      reloginRequired: false,
    })),
    resolveCodexCredentials: vi.fn(async () => ({
      baseUrl: 'https://api.openai.com/v1',
      headers: { Authorization: 'Bearer codex-test' },
    })),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: vi.fn(),
    },
  }));
  return import('../src/providers/codex-discovery.ts');
}

afterEach(() => {
  delete process.env.HYBRIDCLAW_CODEX_BASE_URL;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/auth/codex-auth.js');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
});

describe('codex discovery', () => {
  test('logs a warning and returns stale models when discovery refresh fails', async () => {
    const fetchMock = vi
      .fn(async () => {
        throw new Error('network down');
      })
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ id: 'gpt-5.4', context_window: 400_000 }],
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
    const store = discovery.createCodexDiscoveryStore();

    await expect(store.discoverModels({ force: true })).resolves.toContain(
      'openai-codex/gpt-5.4',
    );
    await expect(store.discoverModels({ force: true })).resolves.toContain(
      'openai-codex/gpt-5.4',
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Codex model discovery failed',
    );
  });
});
