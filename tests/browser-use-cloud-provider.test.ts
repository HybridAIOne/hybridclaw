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
