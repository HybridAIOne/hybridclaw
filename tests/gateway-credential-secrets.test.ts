import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempHome = useTempDir('hybridclaw-gateway-credential-secrets-');
useCleanMocks({
  resetModules: true,
  restoreAllMocks: true,
  unmock: ['node:dns/promises'],
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});

const GATEWAY_CREDENTIALS = [
  'GATEWAY_API_TOKEN',
  'WEB_API_TOKEN',
  'HYBRIDCLAW_AUTH_SECRET',
  'HYBRIDCLAW_MASTER_KEY',
];
const CREDENTIAL_VALUE = 'operator-credential-value';
const SESSION_ID = 'session-a';
const URL = 'https://api.example.com/v1/items';

// The broadest policy a workspace can write: allow every stored secret
// everywhere. The gateway-credential deny must not depend on it.
function writeAllowAllSecretPolicy(homeDir: string): void {
  const policyPath = path.join(
    homeDir,
    '.hybridclaw',
    'data',
    'agents',
    'main',
    'workspace',
    '.hybridclaw',
    'policy.yaml',
  );
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(
    policyPath,
    ['secret:', '  default: allow', '  rules:', '    - action: allow', ''].join(
      '\n',
    ),
    'utf8',
  );
}

async function loadGateway() {
  const homeDir = makeTempHome();
  vi.stubEnv('HOME', homeDir);
  writeAllowAllSecretPolicy(homeDir);
  vi.doMock('node:dns/promises', () => ({
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
  }));
  const { saveNamedRuntimeSecrets } = await import(
    '../src/security/runtime-secrets.ts'
  );
  saveNamedRuntimeSecrets({
    ...Object.fromEntries(
      GATEWAY_CREDENTIALS.map((name) => [name, CREDENTIAL_VALUE]),
    ),
    EXAMPLE_API_KEY: 'example-api-key',
  });
  const fetchMock = vi.fn(
    async (_url: URL, _init: RequestInit) =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const { handleApiHttpRequest } = await import(
    '../src/gateway/gateway-http-proxy.ts'
  );
  const { handleApiSecretInject } = await import(
    '../src/gateway/gateway-secret-injection.ts'
  );
  return { fetchMock, handleApiHttpRequest, handleApiSecretInject };
}

async function call(
  handler: (req: never, res: never) => Promise<void>,
  body: unknown,
): Promise<{ statusCode: number; body: string }> {
  const req = Object.assign(
    Readable.from([Buffer.from(JSON.stringify(body))]),
    { headers: {} },
  );
  const res = {
    statusCode: 0,
    body: '',
    setHeader: vi.fn(),
    writeHead(statusCode: number) {
      res.statusCode = statusCode;
    },
    end(chunk?: unknown) {
      res.body = String(chunk ?? '');
    },
  };
  await handler(req as never, res as never);
  return res;
}

const HTTP_SINKS: Array<[string, (name: string) => Record<string, unknown>]> = [
  ['a header placeholder', (name) => ({
    headers: { Authorization: `Bearer <secret:${name}>` },
  })],
  ['a JSON body placeholder', (name) => ({ json: { key: `<secret:${name}>` } })],
  ['bearerSecretName', (name) => ({ bearerSecretName: name })],
  ['bearerSecretRef', (name) => ({
    bearerSecretRef: { source: 'store', id: name },
  })],
  ['secretHeaders', (name) => ({
    secretHeaders: [{ name: 'X-Api-Key', secretName: name, prefix: 'none' }],
  })],
];

describe('gateway credentials in stored-secret sinks', () => {
  test.each(
    GATEWAY_CREDENTIALS.flatMap((name) =>
      HTTP_SINKS.map(([sink, build]) => [name, sink, build] as const),
    ),
  )('the HTTP proxy refuses %s via %s and sends nothing', async (name, _sink, build) => {
    const { fetchMock, handleApiHttpRequest } = await loadGateway();

    const failure = await call(handleApiHttpRequest, {
      url: URL,
      method: 'POST',
      sessionId: SESSION_ID,
      ...build(name),
    }).catch((caught: unknown) => caught);

    expect(failure).toMatchObject({ statusCode: 403 });
    expect(String((failure as Error).message)).not.toContain(CREDENTIAL_VALUE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the HTTP proxy still resolves an ordinary stored secret', async () => {
    const { fetchMock, handleApiHttpRequest } = await loadGateway();

    const res = await call(handleApiHttpRequest, {
      url: URL,
      method: 'POST',
      sessionId: SESSION_ID,
      headers: { Authorization: 'Bearer <secret:EXAMPLE_API_KEY>' },
    });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each(GATEWAY_CREDENTIALS)(
    'DOM injection refuses %s',
    async (name) => {
      const { handleApiSecretInject } = await loadGateway();

      const failure = await call(handleApiSecretInject, {
        secretName: name,
        sessionId: SESSION_ID,
        host: 'example.com',
        selector: '#password',
      }).catch((caught: unknown) => caught);

      expect(failure).toMatchObject({ statusCode: 403 });
      expect(String((failure as Error).message)).not.toContain(
        CREDENTIAL_VALUE,
      );
    },
  );
});
