import { Readable } from 'node:stream';

import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempHome = useTempDir('hybridclaw-http-secret-headers-');
useCleanMocks({
  resetModules: true,
  restoreAllMocks: true,
  unmock: ['node:dns/promises', '../src/audit/audit-events.js'],
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});

const COOKIE_SECRET = 'EXAMPLE_SESSION_COOKIE';
const COOKIE_BINDING = `${COOKIE_SECRET}_BOUND_DOMAIN`;
const COOKIE_HEADER = 'session-id=session-1; csrf=csrf-token-1; theme=dark';
const SESSION_ID = 'session-a';

type ProxyHandler =
  typeof import('../src/gateway/gateway-http-proxy.ts')['handleApiHttpRequest'];

async function loadProxy(secrets: Record<string, string>) {
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
  saveNamedRuntimeSecrets(secrets);
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
  const { withResolvedSecretLeakRules } = await import(
    '../src/security/secret-leak-corpus.ts'
  );
  return {
    auditMock,
    fetchMock,
    handleApiHttpRequest,
    withResolvedSecretLeakRules,
  };
}

async function callProxy(handler: ProxyHandler, body: unknown) {
  const req = Object.assign(
    Readable.from([Buffer.from(JSON.stringify(body))]),
    { headers: {} },
  );
  const res = {
    statusCode: 0,
    body: '',
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

function cookieRequest(csrfHeader: Record<string, unknown>) {
  return {
    url: 'https://api.example.com/v1/items',
    method: 'POST',
    sessionId: SESSION_ID,
    secretHeaders: [
      { name: 'Cookie', secretName: COOKIE_SECRET, prefix: 'none' },
      { name: 'csrf', secretName: COOKIE_SECRET, prefix: 'none', ...csrfHeader },
    ],
    json: { item: 'milk' },
  };
}

describe('secretHeaders cookie scoping', () => {
  test.each([
    ['empty', ''],
    ['with =', 'csrf='],
    ['with space', 'csrf token'],
    ['with ;', 'csrf;session-id'],
    ['number', 42],
    ['null', null],
  ])('rejects a %s cookie name', async (_label, cookie) => {
    const { normalizeSecretHeaderCookie } = await import(
      '../src/gateway/gateway-http-secret-headers.ts'
    );

    expect(() => normalizeSecretHeaderCookie(cookie)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  test('derives the exact named cookie and nothing else', async () => {
    const { normalizeSecretHeaderCookie, secretHeaderValue } = await import(
      '../src/gateway/gateway-http-secret-headers.ts'
    );
    const header = {
      name: 'csrf',
      secretName: COOKIE_SECRET,
      prefix: '',
      cookie: normalizeSecretHeaderCookie('csrf'),
    };

    expect(normalizeSecretHeaderCookie(undefined)).toBeUndefined();
    expect(
      secretHeaderValue('xcsrf=a; CSRF=b; csrf=c; csrf=d', header, SESSION_ID),
    ).toBe('c');
    expect(
      secretHeaderValue(COOKIE_HEADER, { ...header, cookie: undefined }),
    ).toBe(COOKIE_HEADER);
    for (const secret of ['session-id=session-1', 'session-id=s; csrf=']) {
      expect(() => secretHeaderValue(secret, header)).toThrow(
        expect.objectContaining({
          statusCode: 400,
          message: `Stored secret ${COOKIE_SECRET} has no csrf cookie.`,
        }),
      );
    }
  });

  test('sends the whole cookie and only the named cookie in the derived header', async () => {
    const {
      auditMock,
      fetchMock,
      handleApiHttpRequest,
      withResolvedSecretLeakRules,
    } = await loadProxy({
      [COOKIE_SECRET]: COOKIE_HEADER,
      [COOKIE_BINDING]: 'api.example.com',
    });

    const res = await callProxy(
      handleApiHttpRequest,
      cookieRequest({ cookie: 'csrf' }),
    );

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Cookie: COOKIE_HEADER,
      csrf: 'csrf-token-1',
    });
    expect(res.body).not.toContain('session-1');
    expect(res.body).not.toContain('csrf-token-1');
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'secret.resolved',
          secretRef: { source: 'store', id: COOKIE_SECRET },
          selector: 'csrf',
        }),
      }),
    );
    expect(
      withResolvedSecretLeakRules(SESSION_ID, { rules: [] }).rules.map(
        (rule) => rule.literal,
      ),
    ).toEqual(expect.arrayContaining([COOKIE_HEADER, 'csrf-token-1']));
  });

  test.each([
    [
      'the secret lacks the cookie',
      {
        [COOKIE_SECRET]: 'session-id=session-1',
        [COOKIE_BINDING]: 'api.example.com',
      },
      { cookie: 'csrf' },
      { statusCode: 400, message: expect.stringContaining('has no csrf') },
    ],
    [
      'the cookie name is invalid',
      { [COOKIE_SECRET]: COOKIE_HEADER },
      { cookie: 'csrf=csrf-token-1' },
      { statusCode: 400 },
    ],
    [
      'the secret is bound to another host',
      { [COOKIE_SECRET]: COOKIE_HEADER, [COOKIE_BINDING]: 'other.example.com' },
      { cookie: 'csrf' },
      { statusCode: 403 },
    ],
  ])('sends nothing when %s', async (_label, secrets, csrfHeader, error) => {
    const { fetchMock, handleApiHttpRequest } = await loadProxy(secrets);

    const failure = await callProxy(
      handleApiHttpRequest,
      cookieRequest(csrfHeader),
    ).catch((caught: unknown) => caught);

    expect(failure).toMatchObject(error);
    expect(String((failure as Error).message)).not.toContain('session-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
