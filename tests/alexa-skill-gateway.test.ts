import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const helperPath = path.join(process.cwd(), 'skills', 'alexa', 'alexa.cjs');
const COOKIE_HEADER =
  'session-id=session-1; csrf=csrf-token-1; ubid-main=region-1';
const ENV_COOKIE = 'env-cookie-must-not-be-used';
const closers: Array<() => Promise<void>> = [];

const makeTempHome = useTempDir('hybridclaw-alexa-gateway-');
useCleanMocks({
  cleanup: async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  },
  resetModules: true,
  restoreAllMocks: true,
  unmock: ['node:dns/promises', '../src/audit/audit-events.js'],
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});

type UpstreamCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
};

// A real gateway HTTP proxy in front of a stubbed Amazon: the helper runs as
// its own process and reaches the proxy over HTTP, like it does in a sandbox.
async function startGateway(cookie: string, upstream: Response[]) {
  vi.stubEnv('HOME', makeTempHome());
  vi.doMock('node:dns/promises', () => ({
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
  }));
  const auditMock = vi.fn();
  vi.doMock('../src/audit/audit-events.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    recordAuditEvent: auditMock,
  }));
  const { saveNamedRuntimeSecrets } = await import(
    '../src/security/runtime-secrets.ts'
  );
  saveNamedRuntimeSecrets({
    ALEXA_REFRESH_COOKIE: cookie,
    ALEXA_REFRESH_COOKIE_BOUND_DOMAIN: 'amazon.com',
  });
  const upstreamCalls: UpstreamCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL, init: RequestInit) => {
      upstreamCalls.push({
        url: String(url),
        method: String(init.method),
        headers: init.headers as Record<string, string>,
      });
      const response = upstream.shift();
      if (!response) throw new Error(`unexpected upstream call to ${url}`);
      return response;
    }),
  );
  const { handleApiHttpRequest } = await import(
    '../src/gateway/gateway-http-proxy.ts'
  );
  const { readJsonBody } = await import('../src/gateway/gateway-http-utils.ts');
  const server = http.createServer((req, res) => {
    readJsonBody(req)
      .then((body) => handleApiHttpRequest(res, body))
      .catch((error: { statusCode?: number; message?: string }) => {
        res.writeHead(error.statusCode ?? 500, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: error.message }));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const { port } = server.address() as AddressInfo;
  return { auditMock, upstreamCalls, gatewayUrl: `http://127.0.0.1:${port}` };
}

function runHelper(args: string[], gatewayUrl: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [helperPath, '--format', 'json', ...args],
        {
          env: {
            ...process.env,
            HYBRIDCLAW_GATEWAY_URL: gatewayUrl,
            ALEXA_REFRESH_COOKIE: ENV_COOKIE,
          },
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    },
  );
}

const ANNOUNCE = [
  'run',
  'announce',
  '--device',
  'living-room',
  '--text',
  'Package delivered.',
  '--operator-grant',
  'approve-alexa-write',
];

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Alexa writes reach Amazon with the stored cookie and its csrf via the gateway', async () => {
  const { auditMock, upstreamCalls, gatewayUrl } = await startGateway(
    COOKIE_HEADER,
    [new Response('', { status: 200 })],
  );

  const result = await runHelper(ANNOUNCE, gatewayUrl);

  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    operation: 'announce',
    transport: 'gateway-http-request',
    ok: true,
    outcome: 'accepted',
    status: 200,
    response: {},
  });
  expect(upstreamCalls).toHaveLength(1);
  expect(upstreamCalls[0]).toMatchObject({
    url: 'https://alexa.amazon.com/api/behaviors/preview',
    method: 'POST',
    headers: { Cookie: COOKIE_HEADER, csrf: 'csrf-token-1' },
  });
  expect(JSON.stringify(upstreamCalls)).not.toContain(ENV_COOKIE);
  for (const secret of ['session-1', 'csrf-token-1', ENV_COOKIE]) {
    expect(result.stdout + result.stderr).not.toContain(secret);
  }
  expect(auditMock).toHaveBeenCalledWith(
    expect.objectContaining({
      event: expect.objectContaining({
        type: 'secret.resolved',
        skill: 'alexa',
        secretRef: { source: 'store', id: 'ALEXA_REFRESH_COOKIE' },
        selector: 'csrf',
      }),
    }),
  );
});

test('Alexa reads send only the stored cookie via the gateway', async () => {
  const { upstreamCalls, gatewayUrl } = await startGateway(COOKIE_HEADER, [
    jsonResponse({ devices: [{ accountName: 'Kitchen' }] }),
  ]);

  const result = await runHelper(['run', 'devices'], gatewayUrl);

  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).response).toEqual({
    devices: [{ accountName: 'Kitchen' }],
  });
  expect(upstreamCalls).toMatchObject([
    {
      url: 'https://alexa.amazon.com/api/devices-v2/device',
      method: 'GET',
      headers: { Cookie: COOKIE_HEADER },
    },
  ]);
  expect(upstreamCalls[0]?.headers).not.toHaveProperty('csrf');
});

test('Alexa smart-home status resolves the device and its state via the gateway', async () => {
  const { upstreamCalls, gatewayUrl } = await startGateway(COOKIE_HEADER, [
    jsonResponse({
      data: {
        endpoints: {
          items: [
            {
              legacyAppliance: {
                friendlyName: 'Poolpumpe',
                entityId: 'entity-1',
              },
            },
          ],
        },
      },
    }),
    jsonResponse({
      deviceStates: [
        {
          capabilityStates: [
            {
              namespace: 'Alexa.PowerController',
              name: 'powerState',
              value: 'ON',
            },
          ],
        },
      ],
    }),
  ]);

  const result = await runHelper(
    ['smart-home', 'status', '--name', 'Poolpumpe'],
    gatewayUrl,
  );

  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    name: 'Poolpumpe',
    appliance: { entityId: 'entity-1' },
    state: { powerState: 'ON' },
  });
  expect(upstreamCalls.map((call) => [call.method, call.url])).toEqual([
    ['POST', 'https://alexa.amazon.com/nexus/v1/graphql'],
    ['POST', 'https://alexa.amazon.com/api/phoenix/state'],
  ]);
  for (const call of upstreamCalls) {
    expect(call.headers).toMatchObject({ Cookie: COOKIE_HEADER });
  }
});

test.each([
  [
    'Amazon rejects the cookie',
    COOKIE_HEADER,
    [new Response('<html>denied</html>', { status: 401 })],
    1,
    ['HTTP 401', 'ALEXA_REFRESH_COOKIE'],
  ],
  [
    'Amazon answers with an HTML page',
    COOKIE_HEADER,
    [
      new Response('<html>open the app</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ],
    1,
    ['non-JSON', 'text/html'],
  ],
  [
    'Amazon reports an auth error in a JSON body',
    COOKIE_HEADER,
    [jsonResponse({ message: 'Unauthenticated call' })],
    2,
    ['announce', 'ALEXA_REFRESH_COOKIE'],
  ],
  [
    'the stored cookie has no csrf',
    'session-id=session-1',
    [],
    1,
    ['HTTP 400', 'ALEXA_REFRESH_COOKIE has no csrf cookie'],
  ],
])('Alexa writes fail when %s', async (_label, cookie, upstream, exitCode, stderrParts) => {
  const { gatewayUrl } = await startGateway(cookie, upstream);

  const result = await runHelper(ANNOUNCE, gatewayUrl);

  expect(result.status).toBe(exitCode);
  expect(result.stdout).toBe('');
  for (const part of stderrParts) expect(result.stderr).toContain(part);
  expect(result.stderr).not.toContain('session-1');
});
