import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';
import type { ManagedCloudPlaywrightModule } from '../src/browser/managed-cloud-provider.js';

let tempRoot = '';
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_MASTER_KEY = process.env.HYBRIDCLAW_MASTER_KEY;

function makeTempRoot(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-managed-browser-'));
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

function writeAgentSecretPolicy(
  root: string,
  agentId: string,
  secretId = 'TEST_BROWSER_PASSWORD',
): void {
  const policyDir = path.join(
    root,
    '.hybridclaw',
    'data',
    'agents',
    agentId,
    'workspace',
    '.hybridclaw',
  );
  fs.mkdirSync(policyDir, { recursive: true });
  fs.writeFileSync(
    path.join(policyDir, 'policy.yaml'),
    [
      'secret:',
      '  default: deny',
      '  rules:',
      '    - action: allow',
      '      when:',
      '        predicate: secret_resolve_allowed',
      '        source: store',
      `        id: ${secretId}`,
      '        sink: dom',
      '        skill: managed-login',
      '        host: "*.example"',
      '        selector: "#password"',
      '',
    ].join('\n'),
    'utf-8',
  );
}

async function saveManagedBrowserSecrets(
  secrets: Record<string, string>,
): Promise<void> {
  const { saveNamedRuntimeSecrets } = await import(
    '../src/security/runtime-secrets.js'
  );
  saveNamedRuntimeSecrets(secrets);
}

function createMockPlaywright(): {
  playwright: ManagedCloudPlaywrightModule;
  connectOverCDP: ReturnType<typeof vi.fn>;
  browser: {
    contexts: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  page: {
    screenshot: ReturnType<typeof vi.fn>;
    goto: ReturnType<typeof vi.fn>;
  };
} {
  const page = {
    evaluate: vi.fn(async (fn: () => unknown) => await fn()),
    screenshot: vi.fn(async () => Buffer.from('managed-png')),
    goto: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    url: vi.fn(() => 'https://allowed.example/login'),
    mouse: { wheel: vi.fn(async () => undefined) },
    waitForSelector: vi.fn(async () => undefined),
    locator: vi.fn(() => ({
      fill: vi.fn(async () => undefined),
      pressSequentially: vi.fn(async () => undefined),
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
});

test('managed cloud browser provider leases, navigates, screenshots, audits, meters, and closes', async () => {
  const root = makeTempRoot();
  process.env.HOME = root;
  process.env.HYBRIDCLAW_MASTER_KEY = 'managed-browser-test-master-key';
  vi.resetModules();

  const { initDatabase, getRecentStructuredAuditForSession } = await import(
    '../src/memory/db.js'
  );
  const { getSessionUsageTotals } = await import('../src/memory/db.js');
  const { verifyAuditSessionChain } = await import(
    '../src/audit/audit-trail.js'
  );
  const { ManagedCloudBrowserProvider } = await import(
    '../src/browser/managed-cloud-provider.js'
  );
  initDatabase({ quiet: true, dbPath: path.join(root, 'usage.db') });
  await saveManagedBrowserSecrets({
    MANAGED_BROWSER_POOL_TOKEN: 'pool-token',
  });

  const mock = createMockPlaywright();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse(
        {
          leaseId: 'lease-1',
          nodeId: 'node-a',
          cdpUrl: 'wss://pool.example/lease-1',
          liveUrl: 'https://pool.example/live/lease-1',
          startedAt: '2026-05-14T10:00:00.000Z',
          expiresAt: '2026-05-14T10:01:00.000Z',
          costUsd: 0.001,
        },
        201,
      ),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        verdict: 'allow',
        url: 'https://allowed.example/',
        reason: null,
        matchedRule: { host: 'allowed.example' },
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        leaseId: 'lease-1',
        endedAt: '2026-05-14T10:01:00.000Z',
        costUsd: 0.003,
      }),
    );
  const provider = new ManagedCloudBrowserProvider({
    endpointUrl: 'https://managed-browser.example',
    poolTokenRef: { source: 'store', id: 'MANAGED_BROWSER_POOL_TOKEN' },
    fetch: fetchMock,
    playwright: mock.playwright,
    pricing: {
      actionUsd: 0.0005,
    },
  });

  const session = await provider.launchSession({
    timeoutMs: 60_000,
    metering: {
      sessionId: 'session-managed',
      agentId: 'agent-managed',
      tenantId: 'tenant-a',
      auditRunId: 'run-managed',
    },
  });
  await session.navigate('https://allowed.example/');
  const screenshot = await session.screenshot();
  await provider.closeSession(session);

  expect(screenshot.toString()).toBe('managed-png');
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    'https://managed-browser.example/leases',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer pool-token',
      }),
      body: JSON.stringify({
        tenantId: 'tenant-a',
        agentId: 'agent-managed',
        sessionId: 'session-managed',
        auditRunId: 'run-managed',
        ttlSeconds: 60,
      }),
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    'https://managed-browser.example/leases/lease-1/navigation',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        tenantId: 'tenant-a',
        agentId: 'agent-managed',
        sessionId: 'session-managed',
        url: 'https://allowed.example/',
        method: 'GET',
      }),
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    'https://managed-browser.example/leases/lease-1',
    expect.objectContaining({ method: 'DELETE' }),
  );
  expect(mock.connectOverCDP).toHaveBeenCalledWith(
    'wss://pool.example/lease-1',
    {
      headers: { Authorization: 'Bearer pool-token' },
    },
  );
  expect(mock.page.goto).toHaveBeenCalledWith(
    'https://allowed.example/',
    undefined,
  );
  expect(mock.browser.close).toHaveBeenCalledTimes(1);

  const totals = getSessionUsageTotals('session-managed');
  expect(totals.total_tool_calls).toBe(2);
  expect(totals.total_cost_usd).toBeCloseTo(0.004, 6);

  const auditEvents = getRecentStructuredAuditForSession(
    'session-managed',
    10,
  ).sort((left, right) => left.seq - right.seq);
  expect(auditEvents.map((event) => event.event_type)).toEqual([
    'browser.session_started',
    'browser.navigation',
    'browser.screenshot_taken',
    'browser.session_ended',
  ]);
  expect(JSON.parse(String(auditEvents[0]?.payload))).toMatchObject({
    provider: 'managed-cloud',
    tenantId: 'tenant-a',
    leaseId: 'lease-1',
    poolNodeId: 'node-a',
  });
  expect(JSON.parse(String(auditEvents[1]?.payload))).toMatchObject({
    verdict: 'allow',
    url: 'https://allowed.example/',
  });
  const chain = verifyAuditSessionChain('session-managed');
  expect(chain.ok).toBe(true);
  expect(chain.checkedRecords).toBe(4);
});

test('managed cloud browser provider returns guard denials before page navigation', async () => {
  const root = makeTempRoot();
  process.env.HOME = root;
  process.env.HYBRIDCLAW_MASTER_KEY = 'managed-browser-test-master-key';
  vi.resetModules();

  const { initDatabase, getRecentStructuredAuditForSession } = await import(
    '../src/memory/db.js'
  );
  const { ManagedCloudBrowserProvider } = await import(
    '../src/browser/managed-cloud-provider.js'
  );
  initDatabase({ quiet: true, dbPath: path.join(root, 'usage.db') });

  const mock = createMockPlaywright();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse({
        leaseId: 'lease-deny',
        nodeId: 'node-a',
        cdpUrl: 'wss://pool.example/lease-deny',
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        verdict: 'deny',
        url: 'https://tenant-b.example/',
        reason: 'host belongs to tenant-b',
      }),
    );
  const provider = new ManagedCloudBrowserProvider({
    fetch: fetchMock,
    playwright: mock.playwright,
  });
  const session = await provider.launchSession({
    metering: {
      sessionId: 'session-deny',
      agentId: 'agent-a',
      tenantId: 'tenant-a',
    },
  });

  await expect(session.navigate('https://tenant-b.example/')).rejects.toThrow(
    /host belongs to tenant-b/u,
  );
  expect(mock.page.goto).not.toHaveBeenCalled();
  const navigation = getRecentStructuredAuditForSession(
    'session-deny',
    10,
  ).find((event) => event.event_type === 'browser.navigation');
  expect(JSON.parse(String(navigation?.payload))).toMatchObject({
    verdict: 'deny',
    tenantId: 'tenant-a',
    url: 'https://tenant-b.example/',
  });
});

test('managed cloud browser provider rejects unmetered sessions', async () => {
  const { ManagedCloudBrowserProvider } = await import(
    '../src/browser/managed-cloud-provider.js'
  );
  const mock = createMockPlaywright();
  const fetchMock = vi.fn();
  const provider = new ManagedCloudBrowserProvider({
    fetch: fetchMock,
    playwright: mock.playwright,
  });

  await expect(provider.launchSession({})).rejects.toThrow(
    /requires metering\.sessionId, metering\.agentId/u,
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test('managed cloud browser provider keeps F13 credential injection opaque', async () => {
  const root = makeTempRoot();
  process.env.HOME = root;
  process.env.HYBRIDCLAW_MASTER_KEY = 'managed-browser-test-master-key';
  writeAgentSecretPolicy(root, 'agent-secret');
  vi.resetModules();

  const { initDatabase, getRecentStructuredAuditForSession } = await import(
    '../src/memory/db.js'
  );
  const { ManagedCloudBrowserProvider } = await import(
    '../src/browser/managed-cloud-provider.js'
  );
  initDatabase({ quiet: true, dbPath: path.join(root, 'usage.db') });
  await saveManagedBrowserSecrets({
    TEST_BROWSER_PASSWORD: 'opaque-managed-password',
  });

  const mock = createMockPlaywright();
  const fetchMock = vi.fn().mockResolvedValueOnce(
    jsonResponse({
      leaseId: 'lease-secret',
      nodeId: 'node-a',
      cdpUrl: 'wss://pool.example/lease-secret',
    }),
  );
  const provider = new ManagedCloudBrowserProvider({
    fetch: fetchMock,
    playwright: mock.playwright,
  });
  const session = await provider.launchSession({
    metering: {
      sessionId: 'session-secret',
      agentId: 'agent-secret',
      tenantId: 'tenant-a',
      skillName: 'managed-login',
      auditRunId: 'run-secret',
    },
  });

  await session.fill('#password', {
    source: 'store',
    id: 'TEST_BROWSER_PASSWORD',
  });

  expect(mock.page.fill).not.toHaveBeenCalled();
  const locator = mock.page.locator.mock.results[0]?.value;
  expect(locator.fill).toHaveBeenCalledWith('');
  expect(locator.pressSequentially).toHaveBeenCalledWith(
    'opaque-managed-password',
  );
  const payloads = getRecentStructuredAuditForSession('session-secret', 10).map(
    (entry) => JSON.parse(entry.payload),
  );
  expect(payloads).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'browser.credential_filled',
        secretRef: { source: 'store', id: 'TEST_BROWSER_PASSWORD' },
        selector: '#password',
      }),
    ]),
  );
  expect(JSON.stringify(payloads)).not.toContain('opaque-managed-password');
});

test('managed cloud browser provider advertises F13 and F14 hook parity', async () => {
  const { ManagedCloudBrowserProvider } = await import(
    '../src/browser/managed-cloud-provider.js'
  );
  const capabilities = new ManagedCloudBrowserProvider().getCapabilities();
  expect(capabilities).toEqual({
    credentialInjection: 'opaque-handle',
    waypointEvents: ['browser_await_two_factor', 'browser_resume_interaction'],
  });
});
