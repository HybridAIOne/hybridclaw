import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { BrowserUseCloudPlaywrightModule } from '../src/browser/browser-use-cloud-provider.js';

let tempRoot = '';
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_MASTER_KEY = process.env.HYBRIDCLAW_MASTER_KEY;
const ORIGINAL_TEST_BROWSER_PASSWORD = process.env.TEST_BROWSER_PASSWORD;
const ORIGINAL_MISSING_BROWSER_SECRET = process.env.MISSING_BROWSER_SECRET;

function makeTempRoot(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-browser-cloud-'));
  return tempRoot;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    text: vi.fn(async () => JSON.stringify(body)),
  };
}

function createMockPlaywright(): {
  playwright: BrowserUseCloudPlaywrightModule;
  connectOverCDP: ReturnType<typeof vi.fn>;
  browser: {
    contexts: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  context: {
    pages: ReturnType<typeof vi.fn>;
    newPage: ReturnType<typeof vi.fn>;
  };
  page: {
    evaluate: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    goto: ReturnType<typeof vi.fn>;
    goBack: ReturnType<typeof vi.fn>;
    goForward: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    click: ReturnType<typeof vi.fn>;
    fill: ReturnType<typeof vi.fn>;
    mouse: { wheel: ReturnType<typeof vi.fn> };
    waitForSelector: ReturnType<typeof vi.fn>;
    locator: ReturnType<typeof vi.fn>;
  };
} {
  const page = {
    evaluate: vi.fn(async (fn: () => unknown) => await fn()),
    screenshot: vi.fn(async () => Buffer.from('cloud-png')),
    goto: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    mouse: { wheel: vi.fn(async () => undefined) },
    waitForSelector: vi.fn(async () => undefined),
    locator: vi.fn(() => ({
      evaluate: vi.fn(async () => undefined),
    })),
  };
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
  };
  const browser = {
    contexts: vi.fn(() => [context]),
    close: vi.fn(async () => undefined),
  };
  const connectOverCDP = vi.fn(async () => browser);
  return {
    playwright: {
      chromium: {
        connectOverCDP,
      },
    },
    connectOverCDP,
    browser,
    context,
    page,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('HYBRIDCLAW_MASTER_KEY', ORIGINAL_MASTER_KEY);
  restoreEnvVar('TEST_BROWSER_PASSWORD', ORIGINAL_TEST_BROWSER_PASSWORD);
  restoreEnvVar('MISSING_BROWSER_SECRET', ORIGINAL_MISSING_BROWSER_SECRET);
});

test('browser-use cloud provider launches via stored SecretRef and emits audit plus session usage', async () => {
  const root = makeTempRoot();
  process.env.HOME = root;
  process.env.HYBRIDCLAW_MASTER_KEY = 'browser-cloud-test-master-key';
  vi.resetModules();

  const { initDatabase, getRecentStructuredAuditForSession } = await import(
    '../src/memory/db.js'
  );
  const { saveNamedRuntimeSecrets } = await import(
    '../src/security/runtime-secrets.js'
  );
  const { BrowserUseCloudProvider } = await import(
    '../src/browser/browser-use-cloud-provider.js'
  );
  initDatabase({ quiet: true, dbPath: path.join(root, 'usage.db') });
  saveNamedRuntimeSecrets({ BROWSER_USE_API_KEY: 'bu_test_key' });

  const mock = createMockPlaywright();
  const fetchMock = vi.fn(async () =>
    jsonResponse(
      {
        id: 'cloud-session-1',
        status: 'active',
        startedAt: '2026-05-02T10:00:00.000Z',
        timeoutAt: '2026-05-02T11:00:00.000Z',
        liveUrl: 'https://cloud.browser-use.com/sessions/cloud-session-1',
        cdpUrl: 'wss://cdp.browser-use.test/cloud-session-1',
        proxyCost: '0',
        browserCost: '0',
      },
      201,
    ),
  );
  const provider = new BrowserUseCloudProvider({
    apiKeyRef: { source: 'store', id: 'BROWSER_USE_API_KEY' },
    baseUrl: 'https://api.browser-use.test/api/v3',
    browser: {
      timeoutMinutes: 5,
      proxyCountryCode: null,
      enableRecording: false,
    },
    fetch: fetchMock,
    playwright: mock.playwright,
  });

  await provider.launchSession({
    metering: {
      sessionId: 'session-cloud',
      agentId: 'agent-cloud',
      auditRunId: 'run-cloud',
    },
  });

  expect(fetchMock).toHaveBeenCalledWith(
    'https://api.browser-use.test/api/v3/browsers',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'X-Browser-Use-API-Key': 'bu_test_key',
      }),
      body: JSON.stringify({
        proxyCountryCode: null,
        timeout: 5,
        enableRecording: false,
      }),
    }),
  );
  expect(mock.connectOverCDP).toHaveBeenCalledWith(
    'wss://cdp.browser-use.test/cloud-session-1',
  );

  const { getSessionUsageTotals } = await import('../src/memory/db.js');
  const totals = getSessionUsageTotals('session-cloud');
  expect(totals.total_cost_usd).toBeCloseTo(0.001, 6);
  expect(totals.call_count).toBe(1);

  const auditEvents = getRecentStructuredAuditForSession('session-cloud', 10);
  const started = auditEvents.find(
    (event) => event.event_type === 'browser.session_started',
  );
  expect(started).toBeDefined();
  expect(JSON.parse(String(started?.payload))).toMatchObject({
    provider: 'browser-use-cloud',
    providerSessionId: 'cloud-session-1',
    sessionUrl: 'https://cloud.browser-use.com/sessions/cloud-session-1',
  });
});

test('browser-use cloud provider records action usage, resolves fill secrets, and stops cloud sessions', async () => {
  const root = makeTempRoot();
  process.env.HOME = root;
  process.env.HYBRIDCLAW_MASTER_KEY = 'browser-cloud-test-master-key';
  process.env.TEST_BROWSER_PASSWORD = 'secret-password';
  vi.resetModules();

  const { initDatabase, getSessionUsageTotals } = await import(
    '../src/memory/db.js'
  );
  const { BrowserUseCloudProvider } = await import(
    '../src/browser/browser-use-cloud-provider.js'
  );
  initDatabase({ quiet: true, dbPath: path.join(root, 'usage.db') });

  const mock = createMockPlaywright();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse(
        {
          id: 'cloud-session-2',
          status: 'active',
          startedAt: new Date().toISOString(),
          liveUrl: 'https://cloud.browser-use.com/sessions/cloud-session-2',
          cdpUrl: 'wss://cdp.browser-use.test/cloud-session-2',
          proxyCost: '0',
          browserCost: '0',
        },
        201,
      ),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        id: 'cloud-session-2',
        status: 'stopped',
        browserCost: '0.003',
        proxyCost: '0.002',
      }),
    );
  const secretAudit = vi.fn();
  const provider = new BrowserUseCloudProvider({
    apiKeyRef: { source: 'env', id: 'TEST_BROWSER_PASSWORD' },
    fetch: fetchMock,
    playwright: mock.playwright,
    pricing: {
      browserUsdPerMinute: 0.001,
      actionUsd: 0.0005,
    },
    secretAudit,
  });

  const session = await provider.launchSession({
    metering: {
      sessionId: 'session-actions',
      agentId: 'agent-actions',
    },
  });
  await session.navigate('https://example.com/', {
    waitUntil: 'domcontentloaded',
    timeoutMs: 5_000,
  });
  await session.click('#submit');
  await session.fill('#password', {
    source: 'env',
    id: 'TEST_BROWSER_PASSWORD',
  });
  delete process.env.TEST_BROWSER_PASSWORD;
  await provider.closeSession(session);

  expect(mock.page.goto).toHaveBeenCalledWith('https://example.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 5_000,
  });
  expect(mock.page.click).toHaveBeenCalledWith('#submit', {
    timeout: undefined,
  });
  expect(mock.page.fill).toHaveBeenCalledWith('#password', 'secret-password');
  expect(secretAudit).toHaveBeenCalled();
  expect(fetchMock).toHaveBeenLastCalledWith(
    'https://api.browser-use.com/api/v3/browsers/cloud-session-2',
    expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ action: 'stop' }),
    }),
  );
  expect(mock.browser.close).toHaveBeenCalledTimes(1);

  const totals = getSessionUsageTotals('session-actions');
  expect(totals.total_tool_calls).toBe(3);
  expect(totals.total_cost_usd).toBeCloseTo(0.0065, 6);
});

test('browser-use cloud provider records estimated close usage when cloud stop fails', async () => {
  const root = makeTempRoot();
  process.env.HOME = root;
  process.env.HYBRIDCLAW_MASTER_KEY = 'browser-cloud-test-master-key';
  process.env.TEST_BROWSER_PASSWORD = 'api-key';
  vi.resetModules();

  const { initDatabase, getSessionUsageTotals } = await import(
    '../src/memory/db.js'
  );
  const { BrowserUseCloudProvider } = await import(
    '../src/browser/browser-use-cloud-provider.js'
  );
  initDatabase({ quiet: true, dbPath: path.join(root, 'usage.db') });

  const mock = createMockPlaywright();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse(
        {
          id: 'cloud-session-stop-fail',
          status: 'active',
          startedAt: '2026-05-01T00:00:00.000Z',
          liveUrl: 'https://cloud.browser-use.com/sessions/stop-fail',
          cdpUrl: 'wss://cdp.browser-use.test/stop-fail',
          proxyCost: '0',
          browserCost: '0',
        },
        201,
      ),
    )
    .mockRejectedValueOnce(new Error('stop failed'));
  const provider = new BrowserUseCloudProvider({
    apiKeyRef: { source: 'env', id: 'TEST_BROWSER_PASSWORD' },
    fetch: fetchMock,
    playwright: mock.playwright,
  });

  const session = await provider.launchSession({
    metering: {
      sessionId: 'session-stop-fail',
      agentId: 'agent-stop-fail',
    },
  });

  await expect(provider.closeSession(session)).rejects.toThrow(/stop failed/u);

  expect(mock.browser.close).toHaveBeenCalledTimes(1);
  const totals = getSessionUsageTotals('session-stop-fail');
  expect(totals.call_count).toBe(2);
  expect(totals.total_cost_usd).toBeGreaterThan(0.001);

  await expect(provider.closeSession(session)).rejects.toThrow(
    /session is not active/u,
  );
});

test('browser-use cloud provider reports both stop and browser close failures', async () => {
  const root = makeTempRoot();
  process.env.HOME = root;
  process.env.HYBRIDCLAW_MASTER_KEY = 'browser-cloud-test-master-key';
  process.env.TEST_BROWSER_PASSWORD = 'api-key';
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.js');
  const { BrowserUseCloudProvider } = await import(
    '../src/browser/browser-use-cloud-provider.js'
  );
  initDatabase({ quiet: true, dbPath: path.join(root, 'usage.db') });

  const mock = createMockPlaywright();
  mock.browser.close.mockRejectedValueOnce(new Error('cdp close failed'));
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse(
        {
          id: 'cloud-session-double-fail',
          status: 'active',
          startedAt: '2026-05-01T00:00:00.000Z',
          cdpUrl: 'wss://cdp.browser-use.test/double-fail',
        },
        201,
      ),
    )
    .mockRejectedValueOnce(new Error('stop failed'));
  const provider = new BrowserUseCloudProvider({
    apiKeyRef: { source: 'env', id: 'TEST_BROWSER_PASSWORD' },
    fetch: fetchMock,
    playwright: mock.playwright,
  });

  const session = await provider.launchSession({
    metering: {
      sessionId: 'session-double-fail',
      agentId: 'agent-double-fail',
    },
  });

  await expect(provider.closeSession(session)).rejects.toThrow(AggregateError);
  await expect(provider.closeSession(session)).rejects.toThrow(
    /session is not active/u,
  );
  expect(mock.browser.close).toHaveBeenCalledTimes(1);
});

test('browser-use cloud provider rejects local profile path hints', async () => {
  const { BrowserUseCloudProvider } = await import(
    '../src/browser/browser-use-cloud-provider.js'
  );
  const mock = createMockPlaywright();
  const provider = new BrowserUseCloudProvider({
    fetch: vi.fn(),
    playwright: mock.playwright,
  });

  await expect(
    provider.launchSession({
      profileDirHint: '/tmp/browser-profiles',
    }),
  ).rejects.toThrow(/does not accept local profileDirHint/u);
  expect(mock.connectOverCDP).not.toHaveBeenCalled();
});

test('browser-use cloud provider refuses to start unmetered sessions', async () => {
  const { BrowserUseCloudProvider } = await import(
    '../src/browser/browser-use-cloud-provider.js'
  );
  const mock = createMockPlaywright();
  const fetchMock = vi.fn();
  const provider = new BrowserUseCloudProvider({
    apiKeyRef: { source: 'env', id: 'TEST_BROWSER_PASSWORD' },
    fetch: fetchMock,
    playwright: mock.playwright,
  });

  await expect(provider.launchSession({})).rejects.toThrow(
    /requires metering\.sessionId and metering\.agentId/u,
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mock.connectOverCDP).not.toHaveBeenCalled();
});

test('browser-use cloud provider rejects non-websocket CDP URLs and stops the cloud session', async () => {
  const { BrowserUseCloudProvider } = await import(
    '../src/browser/browser-use-cloud-provider.js'
  );
  process.env.TEST_BROWSER_PASSWORD = 'api-key';
  const mock = createMockPlaywright();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse(
        {
          id: 'cloud-session-bad-cdp',
          status: 'active',
          cdpUrl: 'https://cdp.browser-use.test/bad-cdp',
        },
        201,
      ),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        id: 'cloud-session-bad-cdp',
        status: 'stopped',
      }),
    );
  const provider = new BrowserUseCloudProvider({
    apiKeyRef: { source: 'env', id: 'TEST_BROWSER_PASSWORD' },
    fetch: fetchMock,
    playwright: mock.playwright,
  });

  await expect(
    provider.launchSession({
      metering: {
        sessionId: 'session-bad-cdp',
        agentId: 'agent-bad-cdp',
      },
    }),
  ).rejects.toThrow(/expected a ws:\/\/ or wss:\/\//u);
  expect(mock.connectOverCDP).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenLastCalledWith(
    'https://api.browser-use.com/api/v3/browsers/cloud-session-bad-cdp',
    expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ action: 'stop' }),
    }),
  );
});

test('browser-use cloud provider stops cloud session when CDP connection fails', async () => {
  const { BrowserUseCloudProvider } = await import(
    '../src/browser/browser-use-cloud-provider.js'
  );
  process.env.TEST_BROWSER_PASSWORD = 'api-key';
  const mock = createMockPlaywright();
  mock.connectOverCDP.mockRejectedValueOnce(new Error('cdp unavailable'));
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse(
        {
          id: 'cloud-session-connect-fail',
          status: 'active',
          cdpUrl: 'wss://cdp.browser-use.test/connect-fail',
        },
        201,
      ),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        id: 'cloud-session-connect-fail',
        status: 'stopped',
      }),
    );
  const provider = new BrowserUseCloudProvider({
    apiKeyRef: { source: 'env', id: 'TEST_BROWSER_PASSWORD' },
    fetch: fetchMock,
    playwright: mock.playwright,
  });

  await expect(
    provider.launchSession({
      metering: {
        sessionId: 'session-connect-fail',
        agentId: 'agent-connect-fail',
      },
    }),
  ).rejects.toThrow(/cdp unavailable/u);
  expect(fetchMock).toHaveBeenLastCalledWith(
    'https://api.browser-use.com/api/v3/browsers/cloud-session-connect-fail',
    expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ action: 'stop' }),
    }),
  );
  expect(mock.browser.close).not.toHaveBeenCalled();
});

test('browser-use cloud provider rejects unresolved fill SecretRefs', async () => {
  const root = makeTempRoot();
  process.env.HOME = root;
  process.env.HYBRIDCLAW_MASTER_KEY = 'browser-cloud-test-master-key';
  process.env.TEST_BROWSER_PASSWORD = 'api-key';
  delete process.env.MISSING_BROWSER_SECRET;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.js');
  const { BrowserUseCloudProvider } = await import(
    '../src/browser/browser-use-cloud-provider.js'
  );
  initDatabase({ quiet: true, dbPath: path.join(root, 'usage.db') });

  const mock = createMockPlaywright();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse(
        {
          id: 'cloud-session-missing-fill-secret',
          status: 'active',
          cdpUrl: 'wss://cdp.browser-use.test/missing-fill-secret',
        },
        201,
      ),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        id: 'cloud-session-missing-fill-secret',
        status: 'stopped',
        browserCost: '0.001',
      }),
    );
  const provider = new BrowserUseCloudProvider({
    apiKeyRef: { source: 'env', id: 'TEST_BROWSER_PASSWORD' },
    fetch: fetchMock,
    playwright: mock.playwright,
  });
  const session = await provider.launchSession({
    metering: {
      sessionId: 'session-missing-fill-secret',
      agentId: 'agent-missing-fill-secret',
    },
  });

  await expect(
    session.fill('#password', {
      source: 'env',
      id: 'MISSING_BROWSER_SECRET',
    }),
  ).rejects.toThrow(/environment variable MISSING_BROWSER_SECRET/u);
  expect(mock.page.fill).not.toHaveBeenCalled();

  await provider.closeSession(session);
});

test('browser-use cloud provider closes CDP handle and stops cloud session when no context is exposed', async () => {
  const { BrowserUseCloudProvider } = await import(
    '../src/browser/browser-use-cloud-provider.js'
  );
  process.env.TEST_BROWSER_PASSWORD = 'api-key';
  const mock = createMockPlaywright();
  mock.browser.contexts.mockReturnValueOnce([]);
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse(
        {
          id: 'cloud-session-no-context',
          status: 'active',
          cdpUrl: 'wss://cdp.browser-use.test/no-context',
        },
        201,
      ),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        id: 'cloud-session-no-context',
        status: 'stopped',
      }),
    );
  const provider = new BrowserUseCloudProvider({
    apiKeyRef: { source: 'env', id: 'TEST_BROWSER_PASSWORD' },
    fetch: fetchMock,
    playwright: mock.playwright,
  });

  await expect(
    provider.launchSession({
      metering: {
        sessionId: 'session-no-context',
        agentId: 'agent-no-context',
      },
    }),
  ).rejects.toThrow(/did not expose a browser context/u);
  expect(mock.browser.close).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenLastCalledWith(
    'https://api.browser-use.com/api/v3/browsers/cloud-session-no-context',
    expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ action: 'stop' }),
    }),
  );
});

test('browser-use cloud provider rejects malformed successful API payloads', async () => {
  const { BrowserUseCloudProvider } = await import(
    '../src/browser/browser-use-cloud-provider.js'
  );
  process.env.TEST_BROWSER_PASSWORD = 'api-key';
  const mock = createMockPlaywright();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ status: 'active' }));
  const provider = new BrowserUseCloudProvider({
    apiKeyRef: { source: 'env', id: 'TEST_BROWSER_PASSWORD' },
    fetch: fetchMock,
    playwright: mock.playwright,
  });

  await expect(
    provider.launchSession({
      metering: {
        sessionId: 'session-malformed',
        agentId: 'agent-malformed',
      },
    }),
  ).rejects.toThrow(/without a valid id/u);
  expect(mock.connectOverCDP).not.toHaveBeenCalled();
});
