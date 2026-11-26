import http from 'node:http';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { BrowserSession } from '../src/browser/provider.js';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();
useCleanMocks({ unstubAllEnvs: true });

const servers: http.Server[] = [];
const mockBrowserClose = vi.fn(async () => undefined);

vi.mock('playwright', () => ({
  chromium: {
    connectOverCDP: vi.fn(async () => ({
      contexts: () => [
        {
          pages: () => [
            {
              url: () => 'about:blank',
              on: vi.fn(),
            },
          ],
          newPage: vi.fn(),
        },
      ],
      close: mockBrowserClose,
    })),
  },
}));

beforeEach(() => {
  vi.stubEnv('HOME', makeTempDir('hybridclaw-browser-shutdown-home-'));
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  mockBrowserClose.mockClear();
  vi.resetModules();
});

afterEach(async () => {
  const {
    closeAllGatewayBrowserSessions,
    resetGatewayBrowserSessionsForTests,
    setBrowserSessionCloseTimeoutForTests,
  } = await import('../src/browser/session-registry.js');
  setBrowserSessionCloseTimeoutForTests(50);
  await closeAllGatewayBrowserSessions();
  resetGatewayBrowserSessionsForTests();
  const { shutdownPluginManager } = await import(
    '../src/plugins/plugin-manager.js'
  );
  await shutdownPluginManager();
  const { clearBrowserProviders } = await import(
    '../src/browser/provider-factory.js'
  );
  clearBrowserProviders();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

async function startFakeServer(
  handler: http.RequestListener,
): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, server };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function setupRuntimeWithPlugins(params: {
  provider: string;
  plugins: RuntimeConfig['plugins']['list'];
}) {
  const dbDir = makeTempDir('hybridclaw-browser-shutdown-db-');
  const { initDatabase } = await import('../src/memory/db.js');
  initDatabase({ quiet: true, dbPath: path.join(dbDir, 'usage.db') });

  const { getRuntimeConfig, saveRuntimeConfig } = await import(
    '../src/config/runtime-config.js'
  );
  const config = structuredClone(getRuntimeConfig());
  config.browser.provider = params.provider;
  config.plugins.list = params.plugins;
  saveRuntimeConfig(config);

  const { ensurePluginManagerInitialized } = await import(
    '../src/plugins/plugin-manager.js'
  );
  const manager = await ensurePluginManagerInitialized();
  return { manager, config };
}

test('Browser Use Cloud sessions receive PATCH stop on gateway shutdown, plugin unload, and plugin reload', async () => {
  vi.stubEnv('BROWSER_USE_API_KEY', 'bu-test-key');
  const requests: Array<{
    method: string;
    url: string;
    apiKey: string | undefined;
    body: Record<string, unknown>;
  }> = [];
  let nextId = 0;

  const { url: baseUrl } = await startFakeServer(async (req, res) => {
    const raw = await readBody(req);
    requests.push({
      method: req.method || '',
      url: req.url || '',
      apiKey:
        typeof req.headers['x-browser-use-api-key'] === 'string'
          ? req.headers['x-browser-use-api-key']
          : undefined,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/browsers') {
      nextId += 1;
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          id: `bu-${nextId}`,
          status: 'active',
          startedAt: new Date().toISOString(),
          cdpUrl: `wss://cdp.browser-use.test/bu-${nextId}`,
        }),
      );
      return;
    }
    if (req.method === 'PATCH' && req.url?.startsWith('/browsers/')) {
      const id = req.url.slice('/browsers/'.length);
      res.end(JSON.stringify({ id, status: 'stopped' }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  await setupRuntimeWithPlugins({
    provider: 'browser-use-cloud',
    plugins: [{ id: 'browser-use-cloud', enabled: true, config: { baseUrl } }],
  });

  const {
    closeAllGatewayBrowserSessions,
    getCachedGatewayBrowserSession,
    getOrCreateGatewayBrowserSession,
    reloadKeepingBrowserSessions,
    resetGatewayBrowserSessionsForTests,
  } = await import('../src/browser/session-registry.js');
  const {
    ensurePluginManagerInitialized,
    reloadPluginManager,
    shutdownPluginManager,
  } = await import('../src/plugins/plugin-manager.js');

  // 1. Gateway shutdown sends PATCH stop and clears cached session.
  await getOrCreateGatewayBrowserSession('chat-shutdown', 'main');
  expect(getCachedGatewayBrowserSession('chat-shutdown')).toBeDefined();

  const closedOnShutdown = await closeAllGatewayBrowserSessions();
  expect(closedOnShutdown).toBe(1);
  expect(getCachedGatewayBrowserSession('chat-shutdown')).toBeUndefined();
  expect(requests).toContainEqual({
    method: 'PATCH',
    url: '/browsers/bu-1',
    apiKey: 'bu-test-key',
    body: { action: 'stop' },
  });
  resetGatewayBrowserSessionsForTests();

  // 2. Explicit plugin reload sends PATCH stop for open cloud sessions.
  await getOrCreateGatewayBrowserSession('chat-reload', 'main');
  await reloadKeepingBrowserSessions(reloadPluginManager, 'close-browsers');
  expect(getCachedGatewayBrowserSession('chat-reload')).toBeUndefined();
  expect(requests).toContainEqual({
    method: 'PATCH',
    url: '/browsers/bu-2',
    apiKey: 'bu-test-key',
    body: { action: 'stop' },
  });

  // 3. Default plugin reload preserves unchanged sessions; changing
  //    browser-use-cloud's own config closes them immediately on reload.
  await getOrCreateGatewayBrowserSession('chat-config', 'main');
  await reloadKeepingBrowserSessions(reloadPluginManager);
  expect(getCachedGatewayBrowserSession('chat-config')).toBeDefined();
  expect(
    requests.filter((entry) => entry.url === '/browsers/bu-3'),
  ).toHaveLength(0);

  const { getRuntimeConfig, saveRuntimeConfig } = await import(
    '../src/config/runtime-config.js'
  );
  const updated = structuredClone(getRuntimeConfig());
  updated.plugins.list = [
    {
      id: 'browser-use-cloud',
      enabled: true,
      config: { baseUrl, browser: { timeoutMinutes: 15 } },
    },
  ];
  saveRuntimeConfig(updated);
  await reloadKeepingBrowserSessions(reloadPluginManager);
  expect(getCachedGatewayBrowserSession('chat-config')).toBeUndefined();
  expect(requests).toContainEqual({
    method: 'PATCH',
    url: '/browsers/bu-3',
    apiKey: 'bu-test-key',
    body: { action: 'stop' },
  });

  // 4. Plugin unload (shutdownPluginManager) sends PATCH stop.
  await ensurePluginManagerInitialized();
  await getOrCreateGatewayBrowserSession('chat-unload', 'main');
  await shutdownPluginManager();
  expect(getCachedGatewayBrowserSession('chat-unload')).toBeUndefined();
  expect(requests).toContainEqual({
    method: 'PATCH',
    url: '/browsers/bu-4',
    apiKey: 'bu-test-key',
    body: { action: 'stop' },
  });
});

test('Managed Cloud leases omit launch ttlSeconds and receive DELETE on shutdown, unload, and reload', async () => {
  vi.stubEnv('MANAGED_BROWSER_POOL_TOKEN', 'pool-secret-token');
  const requests: Array<{
    method: string;
    url: string;
    auth: string | undefined;
    body: Record<string, unknown>;
  }> = [];
  let nextLease = 0;

  const { url: endpointUrl } = await startFakeServer(async (req, res) => {
    const raw = await readBody(req);
    requests.push({
      method: req.method || '',
      url: req.url || '',
      auth: req.headers.authorization,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/leases') {
      nextLease += 1;
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          leaseId: `lease-${nextLease}`,
          nodeId: 'node-1',
          cdpUrl: `wss://pool.example/lease-${nextLease}`,
          startedAt: new Date().toISOString(),
        }),
      );
      return;
    }
    if (req.method === 'DELETE' && req.url?.startsWith('/leases/')) {
      const leaseId = req.url.slice('/leases/'.length);
      res.end(
        JSON.stringify({ leaseId, endedAt: new Date().toISOString(), costUsd: 0 }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  await setupRuntimeWithPlugins({
    provider: 'managed-cloud',
    plugins: [{ id: 'managed-cloud', enabled: true, config: { endpointUrl } }],
  });

  const {
    closeAllGatewayBrowserSessions,
    getCachedGatewayBrowserSession,
    getOrCreateGatewayBrowserSession,
    reloadKeepingBrowserSessions,
    resetGatewayBrowserSessionsForTests,
  } = await import('../src/browser/session-registry.js');
  const { reloadPluginManager, shutdownPluginManager } = await import(
    '../src/plugins/plugin-manager.js'
  );

  // 1. Lease creation must not derive ttlSeconds=60 from gateway launch timeoutMs.
  await getOrCreateGatewayBrowserSession('managed-shutdown', 'main');
  const createRequest = requests.find(
    (entry) => entry.method === 'POST' && entry.url === '/leases',
  );
  expect(createRequest).toBeDefined();
  expect(createRequest?.body).not.toHaveProperty('ttlSeconds');
  expect(createRequest?.auth).toBe('Bearer pool-secret-token');

  // 2. Gateway shutdown sends DELETE /leases/lease-1.
  await closeAllGatewayBrowserSessions();
  expect(getCachedGatewayBrowserSession('managed-shutdown')).toBeUndefined();
  expect(requests).toContainEqual({
    method: 'DELETE',
    url: '/leases/lease-1',
    auth: 'Bearer pool-secret-token',
    body: {},
  });
  resetGatewayBrowserSessionsForTests();

  // 3. Explicit plugin reload sends DELETE /leases/lease-2.
  await getOrCreateGatewayBrowserSession('managed-reload', 'main');
  await reloadKeepingBrowserSessions(reloadPluginManager, 'close-browsers');
  expect(getCachedGatewayBrowserSession('managed-reload')).toBeUndefined();
  expect(requests).toContainEqual({
    method: 'DELETE',
    url: '/leases/lease-2',
    auth: 'Bearer pool-secret-token',
    body: {},
  });

  // 4. Plugin unload sends DELETE /leases/lease-3.
  await getOrCreateGatewayBrowserSession('managed-unload', 'main');
  await shutdownPluginManager();
  expect(getCachedGatewayBrowserSession('managed-unload')).toBeUndefined();
  expect(requests).toContainEqual({
    method: 'DELETE',
    url: '/leases/lease-3',
    auth: 'Bearer pool-secret-token',
    body: {},
  });
});

test.each([
  {
    provider: 'browser-use-cloud',
    envKey: 'BROWSER_USE_API_KEY',
    envValue: 'bu-hang-key',
    configKey: 'baseUrl',
    createMethod: 'POST',
    createPath: '/browsers',
    createBody: {
      id: 'bu-hang',
      status: 'active',
      cdpUrl: 'wss://cdp.browser-use.test/bu-hang',
    },
    closeMethod: 'PATCH',
    closePath: '/browsers/bu-hang',
  },
  {
    provider: 'managed-cloud',
    envKey: 'MANAGED_BROWSER_POOL_TOKEN',
    envValue: 'pool-hang-token',
    configKey: 'endpointUrl',
    createMethod: 'POST',
    createPath: '/leases',
    createBody: {
      leaseId: 'lease-hang',
      nodeId: 'node-1',
      cdpUrl: 'wss://pool.example/lease-hang',
    },
    closeMethod: 'DELETE',
    closePath: '/leases/lease-hang',
  },
])('shutdown completes promptly when $provider hangs past the close timeout', async (spec) => {
  vi.stubEnv(spec.envKey, spec.envValue);
  let closeSawRequest = false;
  let closeAborted = false;

  const { url } = await startFakeServer(async (req, res) => {
    if (req.method === spec.createMethod && req.url === spec.createPath) {
      await readBody(req);
      res.statusCode = 201;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(spec.createBody));
      return;
    }
    if (req.method === spec.closeMethod && req.url === spec.closePath) {
      closeSawRequest = true;
      req.on('close', () => {
        if (!res.writableEnded) closeAborted = true;
      });
      // Intentionally never answer to simulate a hung cloud provider.
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  await setupRuntimeWithPlugins({
    provider: spec.provider,
    plugins: [
      { id: spec.provider, enabled: true, config: { [spec.configKey]: url } },
    ],
  });

  const { logger } = await import('../src/logger.js');
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  const {
    closeAllGatewayBrowserSessions,
    getCachedGatewayBrowserSession,
    getOrCreateGatewayBrowserSession,
    setBrowserSessionCloseTimeoutForTests,
  } = await import('../src/browser/session-registry.js');

  await getOrCreateGatewayBrowserSession(`hang-${spec.provider}`, 'main');
  setBrowserSessionCloseTimeoutForTests(150);

  const startedAt = Date.now();
  await expect(closeAllGatewayBrowserSessions()).resolves.toBe(1);
  const elapsedMs = Date.now() - startedAt;

  expect(closeSawRequest).toBe(true);
  expect(elapsedMs).toBeLessThan(1_500);
  expect(getCachedGatewayBrowserSession(`hang-${spec.provider}`)).toBeUndefined();
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: `hang-${spec.provider}`,
      provider: spec.provider,
      reason: 'shutdown',
      timeoutMs: 150,
    }),
    'Timed out closing cached gateway browser session; continuing',
  );
  // Give the TCP FIN from AbortController a brief tick to reach the fake server.
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(closeAborted).toBe(true);
});

test('a failing closeSession logs a warning without blocking other sessions during shutdown', async () => {
  const { getRuntimeConfig, saveRuntimeConfig } = await import(
    '../src/config/runtime-config.js'
  );
  const config = structuredClone(getRuntimeConfig());
  config.browser.provider = 'custom-cloud';
  saveRuntimeConfig(config);

  const { registerBrowserProvider } = await import(
    '../src/browser/provider-factory.js'
  );
  const closed: string[] = [];
  let count = 0;
  registerBrowserProvider(
    {
      kind: 'custom-cloud',
      create: () => ({
        launchSession: async (opts) =>
          ({
            id: opts.metering?.sessionId || `s-${++count}`,
          }) as unknown as BrowserSession,
        closeSession: async (session) => {
          const id = (session as unknown as { id: string }).id;
          closed.push(id);
          if (id === 'session-fail') {
            throw new Error('provider 503');
          }
        },
      }),
    },
    'custom-cloud:{}',
  );

  const { logger } = await import('../src/logger.js');
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  const {
    closeAllGatewayBrowserSessions,
    getCachedGatewayBrowserSession,
    getOrCreateGatewayBrowserSession,
  } = await import('../src/browser/session-registry.js');

  await getOrCreateGatewayBrowserSession('session-fail', 'main');
  await getOrCreateGatewayBrowserSession('session-ok', 'main');

  await expect(closeAllGatewayBrowserSessions()).resolves.toBe(2);
  expect(closed.sort()).toEqual(['session-fail', 'session-ok']);
  expect(getCachedGatewayBrowserSession('session-fail')).toBeUndefined();
  expect(getCachedGatewayBrowserSession('session-ok')).toBeUndefined();
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-fail',
      provider: 'custom-cloud',
      reason: 'shutdown',
    }),
    'Failed to close cached gateway browser session',
  );
});

test('in-flight launch survives unrelated plugin reload, but closes on explicit reload, provider change, or shutdown', async () => {
  const { getRuntimeConfig, saveRuntimeConfig } = await import(
    '../src/config/runtime-config.js'
  );
  const config = structuredClone(getRuntimeConfig());
  config.browser.provider = 'deferred-cloud';
  saveRuntimeConfig(config);

  const { clearBrowserProviders, registerBrowserProvider } = await import(
    '../src/browser/provider-factory.js'
  );
  const {
    closeAllGatewayBrowserSessions,
    closePluginBrowserSessions,
    getCachedGatewayBrowserSession,
    getOrCreateGatewayBrowserSession,
    reloadKeepingBrowserSessions,
  } = await import('../src/browser/session-registry.js');

  const closedSessions: string[] = [];
  let launchDeferred = createDeferred<BrowserSession>();
  const registerDeferredProvider = (fingerprint: string) => {
    registerBrowserProvider(
      {
        kind: 'deferred-cloud',
        create: () => ({
          launchSession: async () => await launchDeferred.promise,
          closeSession: async (session) => {
            closedSessions.push((session as unknown as { id: string }).id);
          },
        }),
      },
      fingerprint,
    );
  };
  // Mirrors reloadPluginManager: PluginManager.shutdown closes plugin
  // sessions and empties the registry; initialize re-registers providers.
  const fakeReload =
    (fingerprint: string, duringReload?: () => Promise<void>) => async () => {
      await closePluginBrowserSessions();
      clearBrowserProviders();
      await duringReload?.();
      registerDeferredProvider(fingerprint);
    };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  // 1. The launch finishes while an unrelated reload has emptied the registry;
  //    the provider comes back unchanged, so the session is kept.
  registerDeferredProvider('deferred-cloud:v1');
  const unrelatedLaunch = getOrCreateGatewayBrowserSession(
    'chat-unrelated-reload',
    'main',
  );
  const preservedSession = { id: 'preserved-1' } as unknown as BrowserSession;
  await reloadKeepingBrowserSessions(
    fakeReload('deferred-cloud:v1', async () => {
      launchDeferred.resolve(preservedSession);
      await flush();
    }),
  );
  await expect(unrelatedLaunch).resolves.toMatchObject({
    session: preservedSession,
  });
  expect(getCachedGatewayBrowserSession('chat-unrelated-reload')?.session).toBe(
    preservedSession,
  );
  expect(closedSessions).toEqual([]);

  // 2. Explicit reload invalidates an in-flight launch even when the provider
  //    re-registers with the same fingerprint.
  launchDeferred = createDeferred<BrowserSession>();
  const explicitReloadLaunch = getOrCreateGatewayBrowserSession(
    'chat-explicit-reload',
    'main',
  );
  await reloadKeepingBrowserSessions(
    fakeReload('deferred-cloud:v1'),
    'close-browsers',
  );
  expect(closedSessions).toEqual(['preserved-1']);
  launchDeferred.resolve({
    id: 'explicit-reload-1',
  } as unknown as BrowserSession);
  await expect(explicitReloadLaunch).rejects.toThrow(/closed while launching/u);
  expect(getCachedGatewayBrowserSession('chat-explicit-reload')).toBeUndefined();
  expect(closedSessions).toContain('explicit-reload-1');

  // 3. A reload that changes this provider's own fingerprint closes the
  //    in-flight launch once it resolves.
  launchDeferred = createDeferred<BrowserSession>();
  const staleProviderLaunch = getOrCreateGatewayBrowserSession(
    'chat-stale-provider',
    'main',
  );
  await reloadKeepingBrowserSessions(fakeReload('deferred-cloud:v2'));
  launchDeferred.resolve({
    id: 'stale-provider-1',
  } as unknown as BrowserSession);
  await expect(staleProviderLaunch).rejects.toThrow(/closed while launching/u);
  expect(getCachedGatewayBrowserSession('chat-stale-provider')).toBeUndefined();
  expect(closedSessions).toContain('stale-provider-1');

  // 4. Gateway shutdown invalidates an in-flight launch and closes it.
  launchDeferred = createDeferred<BrowserSession>();
  const shutdownLaunch = getOrCreateGatewayBrowserSession(
    'chat-shutdown-race',
    'main',
  );
  await closeAllGatewayBrowserSessions();
  launchDeferred.resolve({ id: 'shutdown-race-1' } as unknown as BrowserSession);
  await expect(shutdownLaunch).rejects.toThrow(/closed while launching/u);
  expect(getCachedGatewayBrowserSession('chat-shutdown-race')).toBeUndefined();
  expect(closedSessions).toContain('shutdown-race-1');
});

test('concurrent getOrCreateGatewayBrowserSession calls for the same sessionId coalesce onto one launch', async () => {
  const { getRuntimeConfig, saveRuntimeConfig } = await import(
    '../src/config/runtime-config.js'
  );
  const config = structuredClone(getRuntimeConfig());
  config.browser.provider = 'coalesce-cloud';
  saveRuntimeConfig(config);

  const { registerBrowserProvider } = await import(
    '../src/browser/provider-factory.js'
  );
  const launchDeferred = createDeferred<BrowserSession>();
  const launchSession = vi.fn(async () => await launchDeferred.promise);
  registerBrowserProvider(
    {
      kind: 'coalesce-cloud',
      create: () => ({
        launchSession,
        closeSession: async () => undefined,
      }),
    },
    'coalesce-cloud:{}',
  );

  const { getOrCreateGatewayBrowserSession } = await import(
    '../src/browser/session-registry.js'
  );
  const first = getOrCreateGatewayBrowserSession('chat-coalesce', 'main');
  const second = getOrCreateGatewayBrowserSession('chat-coalesce', 'main');

  expect(launchSession).toHaveBeenCalledTimes(1);
  const sharedSession = { id: 'shared-1' } as unknown as BrowserSession;
  launchDeferred.resolve(sharedSession);

  const [entry1, entry2] = await Promise.all([first, second]);
  expect(entry1).toBe(entry2);
  expect(entry1.session).toBe(sharedSession);
  expect(launchSession).toHaveBeenCalledTimes(1);
});

test('launch attempted after gateway shutdown is rejected immediately', async () => {
  const { getRuntimeConfig, saveRuntimeConfig } = await import(
    '../src/config/runtime-config.js'
  );
  const config = structuredClone(getRuntimeConfig());
  config.browser.provider = 'post-shutdown-cloud';
  saveRuntimeConfig(config);

  const { registerBrowserProvider } = await import(
    '../src/browser/provider-factory.js'
  );
  const launchSession = vi.fn(
    async () => ({ id: 'never-launched' }) as unknown as BrowserSession,
  );
  registerBrowserProvider(
    {
      kind: 'post-shutdown-cloud',
      create: () => ({
        launchSession,
        closeSession: async () => undefined,
      }),
    },
    'post-shutdown-cloud:{}',
  );

  const {
    closeAllGatewayBrowserSessions,
    getCachedGatewayBrowserSession,
    getOrCreateGatewayBrowserSession,
  } = await import('../src/browser/session-registry.js');

  await closeAllGatewayBrowserSessions();
  await expect(
    getOrCreateGatewayBrowserSession('chat-after-shutdown', 'main'),
  ).rejects.toThrow(/shutting down/u);
  expect(launchSession).not.toHaveBeenCalled();
  expect(getCachedGatewayBrowserSession('chat-after-shutdown')).toBeUndefined();
});

test('concurrent close calls on the same session close the provider only once', async () => {
  const { getRuntimeConfig, saveRuntimeConfig } = await import(
    '../src/config/runtime-config.js'
  );
  const config = structuredClone(getRuntimeConfig());
  config.browser.provider = 'double-close-cloud';
  saveRuntimeConfig(config);

  const { registerBrowserProvider } = await import(
    '../src/browser/provider-factory.js'
  );
  const closeDeferred = createDeferred<void>();
  const closeSession = vi.fn(async () => await closeDeferred.promise);
  let seq = 0;
  registerBrowserProvider(
    {
      kind: 'double-close-cloud',
      create: () => ({
        launchSession: async () =>
          ({ id: `double-${++seq}` }) as unknown as BrowserSession,
        closeSession,
      }),
    },
    'double-close-cloud:{}',
  );

  const {
    closeAllGatewayBrowserSessions,
    closeGatewayBrowserSession,
    getOrCreateGatewayBrowserSession,
  } = await import('../src/browser/session-registry.js');

  await getOrCreateGatewayBrowserSession('chat-double', 'main');
  const firstClose = closeGatewayBrowserSession('chat-double');
  const secondClose = closeGatewayBrowserSession('chat-double');
  closeDeferred.resolve();
  expect(await Promise.all([firstClose, secondClose])).toEqual([true, false]);
  expect(closeSession).toHaveBeenCalledTimes(1);

  closeSession.mockClear();
  const shutdownCloseDeferred = createDeferred<void>();
  closeSession.mockImplementationOnce(
    async () => await shutdownCloseDeferred.promise,
  );
  await getOrCreateGatewayBrowserSession('chat-race-shutdown', 'main');
  const explicitClose = closeGatewayBrowserSession('chat-race-shutdown');
  const shutdownSweep = closeAllGatewayBrowserSessions();
  shutdownCloseDeferred.resolve();
  expect(await explicitClose).toBe(true);
  expect(await shutdownSweep).toBe(0);
  expect(closeSession).toHaveBeenCalledTimes(1);
});

test('PluginManager.shutdown closes browser sessions before gateway_stop hooks and service.stop', async () => {
  const fs = await import('node:fs');
  const pluginRoot = makeTempDir('hybridclaw-browser-shutdown-order-plugin-');
  const pluginDir = path.join(pluginRoot, 'order-browser');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    'id: order-browser\nname: Order Browser\nversion: 1.0.0\n',
  );
  const events: string[] = [];
  (globalThis as Record<string, unknown>).__hybridclawShutdownOrderEvents =
    events;
  fs.writeFileSync(
    path.join(pluginDir, 'index.js'),
    [
      'export default {',
      "  id: 'order-browser',",
      '  register(api) {',
      '    const events = globalThis.__hybridclawShutdownOrderEvents;',
      '    api.registerBrowserProvider({',
      "      kind: 'order-browser',",
      '      create: () => ({',
      '        launchSession: async () => ({}),',
      '        closeSession: async () => {',
      "          events.push('browser.closeSession');",
      '        },',
      '      }),',
      '    });',
      "    api.on('gateway_stop', () => {",
      "      events.push('hook.gateway_stop');",
      '    });',
      '    api.registerService({',
      "      id: 'order-service',",
      '      stop: () => {',
      "        events.push('service.stop');",
      '      },',
      '    });',
      '  },',
      '};',
    ].join('\n'),
  );

  try {
    const { getRuntimeConfig, saveRuntimeConfig } = await import(
      '../src/config/runtime-config.js'
    );
    const config = structuredClone(getRuntimeConfig());
    config.browser.provider = 'order-browser';
    config.plugins.list = [
      { id: 'order-browser', enabled: true, path: pluginDir, config: {} },
    ];
    saveRuntimeConfig(config);

    const { ensurePluginManagerInitialized, shutdownPluginManager } =
      await import('../src/plugins/plugin-manager.js');
    const { getOrCreateGatewayBrowserSession } = await import(
      '../src/browser/session-registry.js'
    );

    await ensurePluginManagerInitialized();
    await getOrCreateGatewayBrowserSession('chat-order', 'main');
    await shutdownPluginManager();

    expect(events).toEqual([
      'browser.closeSession',
      'hook.gateway_stop',
      'service.stop',
    ]);
  } finally {
    delete (globalThis as Record<string, unknown>)
      .__hybridclawShutdownOrderEvents;
  }
});
