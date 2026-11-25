import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { describe, expect, test, vi } from 'vitest';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempHome = useTempDir('hybridclaw-events-auth-');
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  restoreAllMocks: true,
  unmock: [
    'node:http',
    '../src/gateway/admin-terminal.js',
    '../src/gateway/gateway-service.js',
  ],
  unstubAllEnvs: true,
});

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const WEB_TOKEN = 'web-test-token';

async function startEventsGateway(): Promise<Handler> {
  vi.resetModules();
  vi.stubEnv('HOME', makeTempHome());
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.stubEnv('WEB_API_TOKEN', WEB_TOKEN);

  let handler: Handler | null = null;
  vi.doMock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    const createServer = vi.fn((next: Handler) => {
      handler = next;
      return { on: vi.fn(), listen: vi.fn(), close: vi.fn() };
    });
    return { ...actual, default: { ...actual, createServer }, createServer };
  });
  vi.doMock('../src/gateway/admin-terminal.js', () => ({
    createAdminTerminalManager: vi.fn(() => ({
      startSession: vi.fn(),
      stopSession: vi.fn(),
      handleUpgrade: vi.fn(),
      broadcastShutdown: vi.fn(),
      dispose: vi.fn(),
    })),
  }));
  vi.doMock('../src/gateway/gateway-service.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getGatewayAdminOverview: vi.fn(async () => ({
      status: {
        status: 'ok',
        version: '0.44.1',
        uptime: 42,
        sessions: 1,
        activeContainers: 0,
      },
      recentSessions: [],
    })),
  }));

  const { startGatewayHttpServer } = await import(
    '../src/gateway/gateway-http-server.js'
  );
  startGatewayHttpServer();
  if (!handler) throw new Error('Gateway HTTP server did not initialize.');
  return handler;
}

async function requestEvents(
  handler: Handler,
  params: {
    url: string;
    headers?: Record<string, string>;
    remoteAddress?: string;
  },
): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}> {
  const req = Object.assign(Readable.from([]), {
    method: 'GET',
    url: params.url,
    headers: {
      host: 'console.example.com',
      ...params.headers,
    },
    socket: { remoteAddress: params.remoteAddress ?? '203.0.113.10' },
  });

  const headers: Record<string, string> = {};
  let statusCode = 0;
  let body = '';
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader(name: string, value: string | string[]) {
      headers[name.toLowerCase()] = Array.isArray(value)
        ? value.join(', ')
        : String(value);
      return res;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    writeHead(status: number, extraHeaders?: Record<string, string>) {
      statusCode = status;
      res.headersSent = true;
      if (extraHeaders) {
        for (const [key, value] of Object.entries(extraHeaders)) {
          headers[key.toLowerCase()] = String(value);
        }
      }
      return res;
    },
    write(chunk: string | Uint8Array) {
      body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    },
    end(chunk?: string | Uint8Array) {
      if (chunk !== undefined) {
        body +=
          typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      }
      res.writableEnded = true;
      return res;
    },
  };

  try {
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    req.emit('close');
  }

  return { statusCode, headers, body };
}

describe('GET /api/events auth', () => {
  test('allows bearer-token auth on a non-loopback host without cookies', async () => {
    const handler = await startEventsGateway();
    const res = await requestEvents(handler, {
      url: '/api/events',
      headers: { authorization: `Bearer ${WEB_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(
      'text/event-stream; charset=utf-8',
    );
    expect(res.body).toContain('event: overview');
    expect(res.body).toContain('event: status');
  });

  test('rejects query-token auth on a non-loopback host', async () => {
    const handler = await startEventsGateway();
    const res = await requestEvents(handler, {
      url: `/api/events?token=${WEB_TOKEN}`,
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
    });
  });

  test('rejects unauthenticated requests on a non-loopback host', async () => {
    const handler = await startEventsGateway();
    const res = await requestEvents(handler, {
      url: '/api/events',
    });

    expect(res.statusCode).toBe(401);
  });
});
