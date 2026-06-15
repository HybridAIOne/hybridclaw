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
      debug: vi.fn(),
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

  test('force-refreshes Codex credentials and retries once when discovery is unauthorized', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: 'gpt-5.5', context_window: 500_000 }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await importFreshDiscovery();
    const auth = await import('../src/auth/codex-auth.js');
    vi.mocked(auth.resolveCodexCredentials).mockImplementation(
      async (opts?: { forceRefresh?: boolean }) => ({
        baseUrl: 'https://api.openai.com/v1',
        headers: {
          Authorization: opts?.forceRefresh
            ? 'Bearer codex-refreshed'
            : 'Bearer codex-stale',
        },
      }),
    );
    const { logger } = await import('../src/logger.js');
    const store = discovery.createCodexDiscoveryStore();

    await expect(store.discoverModels({ force: true })).resolves.toContain(
      'openai-codex/gpt-5.5',
    );

    expect(auth.resolveCodexCredentials).toHaveBeenCalledTimes(2);
    expect(auth.resolveCodexCredentials).toHaveBeenNthCalledWith(2, {
      allowCodexCliImportFallback: true,
      forceRefresh: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer codex-stale',
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer codex-refreshed',
    });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  test('does not warn or cache empty models when Codex credential refresh requires relogin', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: 'gpt-5.5', context_window: 500_000 }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const discovery = await importFreshDiscovery();
    const auth = await import('../src/auth/codex-auth.js');
    const reloginError = new Error('relogin required') as Error & {
      reloginRequired: boolean;
    };
    reloginError.name = 'CodexAuthError';
    reloginError.reloginRequired = true;
    vi.mocked(auth.resolveCodexCredentials).mockImplementation(
      async (opts?: { forceRefresh?: boolean }) => {
        if (opts?.forceRefresh) throw reloginError;
        return {
          baseUrl: 'https://api.openai.com/v1',
          headers: { Authorization: 'Bearer codex-stale' },
        };
      },
    );
    const { logger } = await import('../src/logger.js');
    const store = discovery.createCodexDiscoveryStore();

    await expect(store.discoverModels({ force: true })).resolves.toEqual([]);
    expect(store.getModelNames()).toEqual([]);
    await expect(store.discoverModels()).resolves.toContain(
      'openai-codex/gpt-5.5',
    );

    expect(auth.resolveCodexCredentials).toHaveBeenCalledTimes(3);
    expect(auth.resolveCodexCredentials).toHaveBeenNthCalledWith(2, {
      allowCodexCliImportFallback: true,
      forceRefresh: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Codex model discovery skipped because credentials were rejected',
    );
  });
});
