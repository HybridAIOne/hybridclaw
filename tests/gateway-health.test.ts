import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, test, vi } from 'vitest';

function makeTempDocsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-health-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Docs</h1>', 'utf8');
  fs.writeFileSync(path.join(dir, 'chat.html'), '<h1>Chat</h1>', 'utf8');
  return dir;
}

function makeRequest(params: {
  method?: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  remoteAddress?: string;
}) {
  const chunks =
    params.body === undefined
      ? []
      : [
          Buffer.from(
            typeof params.body === 'string'
              ? params.body
              : JSON.stringify(params.body),
          ),
        ];
  return Object.assign(Readable.from(chunks), {
    method: params.method || 'GET',
    url: params.url,
    headers: params.headers || {},
    socket: {
      remoteAddress: params.remoteAddress || '127.0.0.1',
    },
  });
}

function makeResponse() {
  const response = {
    writableEnded: false,
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(statusCode: number, headers: Record<string, string>) {
      response.statusCode = statusCode;
      response.headers = headers;
    },
    write(chunk: unknown) {
      response.body += Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : String(chunk);
      return true;
    },
    end(chunk?: unknown) {
      if (chunk != null) {
        response.body += Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk);
      }
      response.writableEnded = true;
    },
  };
  return response;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function importFreshHealth(options?: {
  docsDir?: string;
  webApiToken?: string;
  gatewayApiToken?: string;
}) {
  vi.resetModules();

  const docsDir = options?.docsDir || makeTempDocsDir();
  let handler:
    | ((
        req: Parameters<Parameters<typeof createServer>[0]>[0],
        res: Parameters<Parameters<typeof createServer>[0]>[1],
      ) => void)
    | null = null;
  let listenArgs: { port: number; host: string } | null = null;

  const createServer = vi.fn((nextHandler) => {
    handler = nextHandler;
    return {
      listen: vi.fn((port: number, host: string, callback?: () => void) => {
        listenArgs = { port, host };
        callback?.();
      }),
    };
  });

  const getGatewayStatus = vi.fn(() => ({ status: 'ok', sessions: 2 }));
  const getGatewayHistory = vi.fn(() => [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
  ]);
  const handleGatewayMessage = vi.fn(async () => ({
    status: 'success' as const,
    result: '__MESSAGE_SEND_HANDLED__',
    toolsUsed: [],
    toolExecutions: [
      {
        name: 'message',
        arguments: JSON.stringify({ action: 'send' }),
        result: '',
        isError: false,
      },
    ],
    artifacts: [],
  }));
  const handleGatewayCommand = vi.fn(async () => ({
    kind: 'plain' as const,
    text: 'ok',
  }));
  const runDiscordToolAction = vi.fn(async () => ({ ok: true }));
  const normalizeDiscordToolAction = vi.fn((value: string) =>
    value === 'reply' ? 'send' : null,
  );
  const claimQueuedProactiveMessages = vi.fn(() => [
    { id: 1, text: 'queued message' },
  ]);

  vi.doMock('node:http', () => ({
    default: { createServer },
    createServer,
  }));
  vi.doMock('../src/config/config.ts', () => ({
    GATEWAY_API_TOKEN: options?.gatewayApiToken || '',
    HEALTH_HOST: '127.0.0.1',
    HEALTH_PORT: 9090,
    WEB_API_TOKEN: options?.webApiToken || '',
  }));
  vi.doMock('../src/infra/install-root.js', () => ({
    resolveInstallPath: vi.fn(() => docsDir),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  }));
  vi.doMock('../src/memory/db.js', () => ({
    claimQueuedProactiveMessages,
  }));
  vi.doMock('../src/gateway/gateway-service.js', () => ({
    getGatewayHistory,
    getGatewayStatus,
    handleGatewayCommand,
    handleGatewayMessage,
  }));
  vi.doMock('../src/channels/discord/runtime.js', () => ({
    runDiscordToolAction,
  }));
  vi.doMock('../src/channels/discord/tool-actions.js', () => ({
    normalizeDiscordToolAction,
  }));

  const health = await import('../src/gateway/health.js');
  health.startHealthServer();

  if (!handler || !listenArgs) {
    throw new Error('Health server did not initialize.');
  }

  return {
    handler,
    listenArgs,
    getGatewayStatus,
    getGatewayHistory,
    handleGatewayMessage,
    handleGatewayCommand,
    runDiscordToolAction,
    normalizeDiscordToolAction,
    claimQueuedProactiveMessages,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('node:http');
  vi.doUnmock('../src/config/config.ts');
  vi.doUnmock('../src/infra/install-root.js');
  vi.doUnmock('../src/logger.js');
  vi.doUnmock('../src/memory/db.js');
  vi.doUnmock('../src/gateway/gateway-service.js');
  vi.doUnmock('../src/channels/discord/runtime.js');
  vi.doUnmock('../src/channels/discord/tool-actions.js');
  vi.resetModules();
});

describe('gateway health server', () => {
  test('starts the HTTP server and serves the health endpoint without auth', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/health' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(state.listenArgs).toEqual({ host: '127.0.0.1', port: 9090 });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', sessions: 2 });
  });

  test('rejects unauthorized API requests from non-loopback addresses', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/status',
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
    });
  });

  test('serves static docs files from the install docs directory', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('<h1>Docs</h1>');
  });

  test('returns history for authorized loopback API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/history?sessionId=s1&limit=2' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayHistory).toHaveBeenCalledWith('s1', 2);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      sessionId: 's1',
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ],
    });
  });

  test('normalizes silent message-send chat responses', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: { content: 'send this' },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.handleGatewayMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'web',
        content: 'send this',
        sessionId: 'web:default',
        userId: 'web-user',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'success',
      result: 'Message sent.',
    });
  });

  test('normalizes Discord action payloads before dispatching tool actions', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/discord/action',
      body: {
        action: 'reply',
        channelId: '123',
        content: 'hello',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.normalizeDiscordToolAction).toHaveBeenCalledWith('reply');
    expect(state.runDiscordToolAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'send',
        channelId: '123',
        content: 'hello',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});
