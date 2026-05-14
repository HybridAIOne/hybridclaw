import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

let tempRoot = '';

function makeTempRoot(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-browser-guard-'));
  return tempRoot;
}

function writeTenantPolicy(root: string): string {
  const policyPath = path.join(root, 'tenants.yaml');
  fs.writeFileSync(
    policyPath,
    [
      'tenants:',
      '  tenant-a:',
      '    network:',
      '      default: deny',
      '      rules:',
      '        - action: allow',
      '          host: allowed.example',
      '          port: 443',
      '          methods: ["GET"]',
      '          paths: ["/**"]',
      '          agent: "*"',
      '  tenant-b:',
      '    network:',
      '      default: deny',
      '      rules:',
      '        - action: allow',
      '          host: tenant-b.example',
      '          port: 443',
      '          methods: ["*"]',
      '          paths: ["/**"]',
      '          agent: "*"',
      '',
    ].join('\n'),
    'utf-8',
  );
  return policyPath;
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('server did not return a TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
}

function sendConnect(port: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      );
    });
    let raw = '';
    socket.setEncoding('utf-8');
    socket.on('data', (chunk) => {
      raw += chunk;
    });
    socket.on('end', () => resolve(raw));
    socket.on('close', () => resolve(raw));
    socket.on('error', reject);
  });
}

afterEach(() => {
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
});

test('managed browser guard rejects cross-tenant URLs and unknown hosts before proxy connect', async () => {
  const root = makeTempRoot();
  const policyPath = writeTenantPolicy(root);
  const { evaluateTenantNavigation } = await import(
    '../infra/managed-browser/policy.js'
  );

  expect(
    evaluateTenantNavigation({
      policyPath,
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      url: 'https://allowed.example/path',
    }),
  ).toMatchObject({ verdict: 'allow', reason: null });
  expect(
    evaluateTenantNavigation({
      policyPath,
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      url: 'https://allowed.example/path',
      method: 'POST',
    }),
  ).toMatchObject({
    verdict: 'deny',
    reason: 'host is not allowed for this tenant',
  });
  expect(
    evaluateTenantNavigation({
      policyPath,
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      url: 'https://tenant-b.example/private',
    }),
  ).toMatchObject({
    verdict: 'deny',
    reason: 'URL is in another tenant allowlist scope (tenant-b)',
  });
  expect(
    evaluateTenantNavigation({
      policyPath,
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      url: 'https://outside.example/private',
    }),
  ).toMatchObject({
    verdict: 'deny',
    reason: 'host is not allowed for this tenant',
  });
});

test('managed browser guard proxy denies CONNECT before opening an upstream socket', async () => {
  const root = makeTempRoot();
  const policyPath = writeTenantPolicy(root);
  const { createGuardProxyServer } = await import(
    '../infra/managed-browser/guard-proxy.js'
  );
  const server = createGuardProxyServer({
    policyPath,
    fixedContext: { tenantId: 'tenant-a', agentId: 'agent-a' },
  });
  const port = await listen(server);

  const response = await sendConnect(port, 'tenant-b.example:443');
  await new Promise<void>((resolve) => server.close(() => resolve()));

  expect(response).toContain('HTTP/1.1 403 Forbidden');
  expect(response).toContain('URL is in another tenant allowlist scope');
});

test('managed browser guard proxy validates CONNECT ports before upstream connect', async () => {
  const root = makeTempRoot();
  const policyPath = writeTenantPolicy(root);
  const { createGuardProxyServer } = await import(
    '../infra/managed-browser/guard-proxy.js'
  );
  const server = createGuardProxyServer({
    policyPath,
    fixedContext: { tenantId: 'tenant-a', agentId: 'agent-a' },
  });
  const port = await listen(server);

  const deniedPort = await sendConnect(port, 'allowed.example:444');
  const invalidPort = await sendConnect(port, 'allowed.example:not-a-port');
  await new Promise<void>((resolve) => server.close(() => resolve()));

  expect(deniedPort).toContain('HTTP/1.1 403 Forbidden');
  expect(deniedPort).toContain('host is not allowed for this tenant');
  expect(invalidPort).toContain('HTTP/1.1 403 Forbidden');
  expect(invalidPort).toContain('invalid CONNECT port');
});

test('managed browser pool validates bearer tokens and schedules TTL cleanup', async () => {
  const { isAuthorizedRequest, scheduleLeaseExpiry } = await import(
    '../infra/managed-browser/server.js'
  );

  expect(
    isAuthorizedRequest(
      { headers: { authorization: 'Bearer pool-token' } },
      'pool-token',
    ),
  ).toBe(true);
  expect(
    isAuthorizedRequest(
      { headers: { authorization: 'Bearer wrong-token' } },
      'pool-token',
    ),
  ).toBe(false);
  expect(isAuthorizedRequest({ headers: {} }, 'pool-token')).toBe(false);

  let releaseExpiry: (() => void) | null = null;
  const expired = new Promise<void>((resolve) => {
    releaseExpiry = resolve;
  });
  const release = vi.fn(async () => {
    releaseExpiry?.();
  });
  const lease = {
    leaseId: 'lease-expiring',
    expiresAtMs: Date.now() + 10,
  };
  scheduleLeaseExpiry(lease, release);
  await expired;

  expect(release).toHaveBeenCalledWith('lease-expiring', 'expired');
});

test('managed browser pool warm restart records lost active leases', async () => {
  const root = makeTempRoot();
  const statePath = path.join(root, 'leases.json');
  const auditPath = path.join(root, 'audit.jsonl');
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      nodeId: 'old-node',
      leases: [
        {
          leaseId: 'lease-lost',
          tenantId: 'tenant-a',
          agentId: 'agent-a',
          sessionId: 'session-a',
        },
      ],
    }),
    'utf-8',
  );
  const { loadLostLeases } = await import('../infra/managed-browser/state.js');

  const lost = loadLostLeases({ statePath, auditPath, nodeId: 'node-new' });

  expect(lost).toHaveLength(1);
  const events = fs
    .readFileSync(auditPath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(events).toEqual([
    expect.objectContaining({
      type: 'browser.session_lost',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      sessionId: 'session-a',
      leaseId: 'lease-lost',
      nodeId: 'node-new',
    }),
  ]);
});
