import http from 'node:http';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

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
  const { closeAllGatewayBrowserSessions } = await import(
    '../src/browser/session-registry.js'
  );
  await closeAllGatewayBrowserSessions('shutdown', 50);
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
  } = await import('../src/browser/session-registry.js');
  const {
    ensurePluginManagerInitialized,
    reloadPluginManager,
    shutdownPluginManager,
  } = await import('../src/plugins/plugin-manager.js');

  // 1. Gateway shutdown sends PATCH stop and clears cached session.
  await getOrCreateGatewayBrowserSession('chat-shutdown', 'main');
  expect(getCachedGatewayBrowserSession('chat-shutdown')).toBeDefined();

  const closedOnShutdown = await closeAllGatewayBrowserSessions('shutdown');
  expect(closedOnShutdown).toBe(1);
  expect(getCachedGatewayBrowserSession('chat-shutdown')).toBeUndefined();
  expect(requests).toContainEqual({
    method: 'PATCH',
    url: '/browsers/bu-1',
    apiKey: 'bu-test-key',
    body: { action: 'stop' },
  });

  // 2. Explicit plugin reload sends PATCH stop for open cloud sessions.
  await getOrCreateGatewayBrowserSession('chat-reload', 'main');
  await reloadPluginManager();
  expect(getCachedGatewayBrowserSession('chat-reload')).toBeUndefined();
  expect(requests).toContainEqual({
    method: 'PATCH',
    url: '/browsers/bu-2',
    apiKey: 'bu-test-key',
    body: { action: 'stop' },
  });

  // 3. Unrelated plugin config reload preserves unchanged sessions; changing
  //    browser-use-cloud's own config closes them immediately on reload.
  await getOrCreateGatewayBrowserSession('chat-config', 'main');
  await reloadPluginManager({ preserveUnchangedBrowserSessions: true });
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
  await reloadPluginManager({ preserveUnchangedBrowserSessions: true });
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
  await closeAllGatewayBrowserSessions('shutdown');
  expect(getCachedGatewayBrowserSession('managed-shutdown')).toBeUndefined();
  expect(requests).toContainEqual({
    method: 'DELETE',
    url: '/leases/lease-1',
    auth: 'Bearer pool-secret-token',
    body: {},
  });

  // 3. Plugin reload sends DELETE /leases/lease-2.
  await getOrCreateGatewayBrowserSession('managed-reload', 'main');
  await reloadPluginManager();
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
])('shutdown completes promptly when $provider hangs past the dispose timeout', async (spec) => {
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
  } = await import('../src/browser/session-registry.js');

  await getOrCreateGatewayBrowserSession(`hang-${spec.provider}`, 'main');

  const startedAt = Date.now();
  await expect(
    closeAllGatewayBrowserSessions('shutdown', 150),
  ).resolves.toBe(1);
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

test('a failing dispose hook logs a warning without blocking other sessions during shutdown', async () => {
  const { getRuntimeConfig, saveRuntimeConfig } = await import(
    '../src/config/runtime-config.js'
  );
  const config = structuredClone(getRuntimeConfig());
  config.browser.provider = 'custom-cloud';
  saveRuntimeConfig(config);

  const { registerBrowserProvider } = await import(
    '../src/browser/provider-factory.js'
  );
  const disposed: string[] = [];
  let count = 0;
  registerBrowserProvider(
    {
      kind: 'custom-cloud',
      create: () => ({
        launchSession: async (opts) =>
          ({
            id: opts.metering?.sessionId || `s-${++count}`,
          }) as unknown as import('../src/browser/provider.js').BrowserSession,
        closeSession: async () => undefined,
      }),
      dispose: async ({ session }) => {
        const id = (session as unknown as { id: string }).id;
        disposed.push(id);
        if (id === 'session-fail') {
          throw new Error('provider 503');
        }
      },
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

  await expect(closeAllGatewayBrowserSessions('shutdown')).resolves.toBe(2);
  expect(disposed.sort()).toEqual(['session-fail', 'session-ok']);
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
