import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { SHELL_RUNTIME_ENV_PATH } from '../container/shared/shell-runtime-env.js';

// Worker credentials through the real gateway request handler. Downstream
// services are stubbed so each runtime route shows the identity it passes on.
// The gateway graph is imported once: loading it per test outruns the timeout
// on a busy machine.

const STUBBED_MODULES = [
  'node:http',
  '../src/auth/google-auth.js',
  '../src/channels/message/tool-actions.js',
  '../src/gateway/gateway-http-proxy.js',
  '../src/gateway/gateway-plugin-service.js',
  '../src/gateway/gateway-secret-injection.js',
  '../src/gateway/interactive-escalation.js',
  '../src/gateway/scheduled-task-tool-service.js',
];

const WORKER_A = { agentId: 'agent-a', sessionId: 'session-a' };

type Handler = (req: unknown, res: unknown) => void;

function writeJson(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function startGateway() {
  vi.stubEnv('GATEWAY_API_TOKEN', 'gateway-token');
  // What each downstream service received, keyed by route.
  const received = new Map<string, unknown>();
  const record =
    (route: string) =>
    (...args: unknown[]) => {
      received.set(route, args.length === 1 ? args[0] : args);
    };
  let handler: Handler | undefined;

  vi.doMock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    const createServer = vi.fn((next: Handler) => {
      handler = next;
      return { on: vi.fn(), listen: vi.fn() };
    });
    return { ...actual, default: { ...actual, createServer }, createServer };
  });
  vi.doMock('../src/gateway/gateway-http-proxy.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    handleApiHttpRequest: async (res: ServerResponse, body: unknown) => {
      record('/api/http/request')(body);
      writeJson(res, { ok: true });
    },
  }));
  vi.doMock(
    '../src/gateway/gateway-secret-injection.js',
    async (importOriginal) => ({
      ...(await importOriginal<object>()),
      handleApiSecretInject: async (res: ServerResponse, body: unknown) => {
        record('/api/secret/inject')(body);
        writeJson(res, { ok: true });
      },
    }),
  );
  vi.doMock(
    '../src/gateway/scheduled-task-tool-service.js',
    async (importOriginal) => ({
      ...(await importOriginal<object>()),
      runScheduledTaskToolAction: (body: unknown) => {
        record('/api/scheduler/task')(body);
        return { ok: true };
      },
    }),
  );
  vi.doMock(
    '../src/gateway/gateway-plugin-service.js',
    async (importOriginal) => ({
      ...(await importOriginal<object>()),
      runGatewayPluginTool: async (params: unknown) => {
        record('/api/plugin/tool')(params);
        return 'ok';
      },
    }),
  );
  vi.doMock(
    '../src/channels/message/tool-actions.js',
    async (importOriginal) => ({
      ...(await importOriginal<object>()),
      runMessageToolAction: async (request: unknown) => {
        record('/api/message/action')(request);
        return { ok: true };
      },
    }),
  );
  vi.doMock(
    '../src/gateway/interactive-escalation.js',
    async (importOriginal) => ({
      ...(await importOriginal<object>()),
      createSuspendedSession: (input: Record<string, unknown>) => {
        record('/api/interactive-escalations')(input);
        return { ...input, sessionId: 'escalation-1' };
      },
      emitInteractionNeededEvent: vi.fn(),
      consumeOperatorReturn: (...args: unknown[]) => {
        record('/api/interactive-escalations/consume')(...args);
        return { kind: 'approved' };
      },
    }),
  );
  vi.doMock('../src/auth/google-auth.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    resolveGoogleWorkspaceRuntimeEnv: async () => ({
      GOG_ACCESS_TOKEN: 'test-key',
    }),
  }));

  const { startGatewayHttpServer } = await import(
    '../src/gateway/gateway-http-server.js'
  );
  startGatewayHttpServer();
  const credentials = await import('../src/security/worker-credentials.js');
  const { logger } = await import('../src/logger.js');
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

  const send = (method: string, url: string, token: string, body?: unknown) =>
    new Promise<{ status: number; json: () => unknown }>((resolve) => {
      const req = Object.assign(
        Readable.from(
          body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
        ),
        {
          method,
          url,
          headers: {
            authorization: `Bearer ${token}`,
            host: '127.0.0.1:9090',
          },
          socket: { remoteAddress: '127.0.0.1' },
        },
      );
      const res = {
        statusCode: 0,
        body: '',
        headersSent: false,
        writableEnded: false,
        setHeader: vi.fn(),
        getHeader: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        writeHead(statusCode: number) {
          res.statusCode = statusCode;
          res.headersSent = true;
          return res;
        },
        write(chunk: unknown) {
          res.body += String(chunk);
          return true;
        },
        end(chunk?: unknown) {
          if (chunk != null) res.body += String(chunk);
          res.writableEnded = true;
          resolve({ status: res.statusCode, json: () => JSON.parse(res.body) });
        },
      };
      handler?.(req, res);
    });

  return {
    credentialFor: (binding = WORKER_A) =>
      credentials.issueWorkerCredential(binding),
    revoke: credentials.revokeWorkerCredential,
    received,
    send,
    warn,
  };
}

let gateway: Awaited<ReturnType<typeof startGateway>>;

beforeAll(async () => {
  vi.resetModules();
  gateway = await startGateway();
}, 120_000);

beforeEach(() => {
  gateway.received.clear();
  gateway.warn.mockClear();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const moduleId of STUBBED_MODULES) vi.doUnmock(moduleId);
  vi.resetModules();
});

// Each runtime route, a body without caller identity, and the identity its
// downstream service must receive.
const RUNTIME_ROUTES: Array<[string, Record<string, unknown>, unknown]> = [
  ['/api/http/request', { url: 'https://example.com' }, WORKER_A],
  ['/api/secret/inject', { secretName: 'EXAMPLE_KEY' }, WORKER_A],
  ['/api/scheduler/task', { action: 'add' }, WORKER_A],
  [
    '/api/plugin/tool',
    { toolName: 'example_tool' },
    { sessionId: 'session-a' },
  ],
  ['/api/message/action', { action: 'send' }, { sessionId: 'session-a' }],
  [
    '/api/interactive-escalations',
    {
      prompt: 'Enter the code.',
      modality: 'totp',
      frameSnapshot: { url: 'https://example.com/login' },
    },
    { agentId: 'agent-a' },
  ],
];

describe('gateway worker credentials', () => {
  test.each([
    ['PUT', '/api/admin/policy'],
    ['DELETE', '/api/admin/policy'],
    ['GET', '/api/admin/approvals'],
    ['PUT', '/api/admin/config'],
    ['POST', '/api/admin/config/reload'],
    ['PUT', '/api/admin/secrets/EXAMPLE_KEY'],
    ['POST', '/api/admin/tokens'],
    ['PUT', '/api/admin/scheduler'],
    ['GET', '/api/admin/audit'],
    ['POST', '/api/command'],
    ['POST', '/api/chat'],
    ['GET', '/api/history?sessionId=session-a'],
    ['POST', '/api/interactive-escalations/resume'],
    ['POST', '/api/discord/action'],
  ])('rejects a worker credential on %s %s', async (method, url) => {
    const credential = gateway.credentialFor();

    const response = await gateway.send(method, url, credential, {
      agentId: 'agent-a',
    });

    expect(response.status).toBe(403);
    expect(gateway.warn).toHaveBeenCalledWith(
      { ...WORKER_A, pathname: new URL(url, 'http://x').pathname },
      'Rejected worker credential outside the runtime routes',
    );
    expect(JSON.stringify(gateway.warn.mock.calls)).not.toContain(credential);
  });

  test('does not accept a worker credential outside /api', async () => {
    const response = await gateway.send(
      'POST',
      '/v1/chat/completions',
      gateway.credentialFor(),
      { model: 'auxiliary/eval_judge', messages: [] },
    );

    expect(response.status).toBe(401);
  });

  test.each(RUNTIME_ROUTES)(
    'POST %s runs as the credential agent and session',
    async (pathname, body, identity) => {
      const response = await gateway.send(
        'POST',
        pathname,
        gateway.credentialFor(),
        body,
      );

      expect(response.status).toBe(200);
      expect(gateway.received.get(pathname)).toMatchObject(
        identity as Record<string, unknown>,
      );
    },
  );

  test.each([
    ...RUNTIME_ROUTES.map(([pathname, body]) => [
      pathname,
      { ...body, agentId: 'agent-b' },
    ]),
    ...RUNTIME_ROUTES.filter(
      ([, , identity]) => (identity as { sessionId?: string }).sessionId,
    ).map(([pathname, body]) => [
      pathname,
      { ...body, sessionId: 'session-b' },
    ]),
    ['/api/browser/tool', { toolName: 'browser_close', agentId: 'agent-b' }],
    [
      '/api/browser/tool',
      { toolName: 'browser_close', sessionId: 'session-b' },
    ],
  ] as Array<[string, Record<string, unknown>]>)(
    'POST %s refuses to act for another agent or session: %j',
    async (pathname, body) => {
      const response = await gateway.send(
        'POST',
        pathname,
        gateway.credentialFor(),
        body,
      );

      expect(response.status).toBe(403);
      expect(gateway.received.has(pathname)).toBe(false);
    },
  );

  test('consumes only escalations the credential agent owns', async () => {
    const response = await gateway.send(
      'POST',
      '/api/interactive-escalations/consume',
      gateway.credentialFor(),
      { sessionId: 'escalation-1' },
    );

    expect(response.status).toBe(200);
    expect(
      gateway.received.get('/api/interactive-escalations/consume'),
    ).toEqual(['escalation-1', 'agent-a']);
  });

  test('closes its own gateway browser session', async () => {
    const response = await gateway.send(
      'POST',
      '/api/browser/tool',
      gateway.credentialFor(),
      { toolName: 'browser_close' },
    );

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ success: true, closed: true });
  });

  test('hands shell credentials to a worker', async () => {
    const response = await gateway.send(
      'POST',
      SHELL_RUNTIME_ENV_PATH,
      gateway.credentialFor(),
    );

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ GOG_ACCESS_TOKEN: 'test-key' });
  });

  test('rejects a revoked credential and an unclaimed warm worker', async () => {
    const revoked = gateway.credentialFor();
    gateway.revoke(revoked);
    const warm = gateway.credentialFor({ agentId: 'agent-a', sessionId: null });

    const revokedResponse = await gateway.send(
      'POST',
      '/api/http/request',
      revoked,
      { url: 'https://example.com' },
    );
    const warmResponse = await gateway.send('POST', '/api/http/request', warm, {
      url: 'https://example.com',
    });

    expect(revokedResponse.status).toBe(401);
    expect(warmResponse.status).toBe(403);
    expect(gateway.received.has('/api/http/request')).toBe(false);
  });

  test('keeps accepting the gateway token on runtime routes', async () => {
    const response = await gateway.send(
      'POST',
      '/api/http/request',
      'gateway-token',
      { url: 'https://example.com', agentId: 'agent-b' },
    );

    expect(response.status).toBe(200);
    expect(gateway.received.get('/api/http/request')).toMatchObject({
      agentId: 'agent-b',
    });
  });
});
