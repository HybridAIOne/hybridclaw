import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, test, vi } from 'vitest';

const tempDirs: string[] = [];

function makeTempDocsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-health-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Docs</h1>', 'utf8');
  fs.writeFileSync(path.join(dir, 'chat.html'), '<h1>Chat</h1>', 'utf8');
  return dir;
}

function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-health-data-'));
  tempDirs.push(dir);
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
    headersSent: false,
    destroyed: false,
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(statusCode: number, headers: Record<string, string>) {
      response.statusCode = statusCode;
      response.headers = headers;
      response.headersSent = true;
    },
    write(chunk: unknown) {
      response.headersSent = true;
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
      response.headersSent = true;
    },
    destroy() {
      response.destroyed = true;
      response.writableEnded = true;
    },
  };
  return response;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForResponse(
  response: ReturnType<typeof makeResponse>,
  predicate: (response: ReturnType<typeof makeResponse>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate(response)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for response state.');
}

async function importFreshHealth(options?: {
  docsDir?: string;
  dataDir?: string;
  webApiToken?: string;
  gatewayApiToken?: string;
}) {
  vi.resetModules();

  const docsDir = options?.docsDir || makeTempDocsDir();
  const dataDir = options?.dataDir || makeTempDataDir();
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
    DATA_DIR: dataDir,
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
    dataDir,
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
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

  test('serves office artifacts from the agent data root with query-token auth', async () => {
    const dataDir = makeTempDataDir();
    const artifactPath = path.join(
      dataDir,
      'agents',
      'agent-1',
      'workspace',
      'quarterly-update.docx',
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, 'docx payload', 'utf8');

    const state = await importFreshHealth({
      dataDir,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: `/api/artifact?path=${encodeURIComponent(artifactPath)}&token=web-token`,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(res.headers['Content-Disposition']).toContain(
      'quarterly-update.docx',
    );
    expect(res.headers['Content-Length']).toBe(String('docx payload'.length));
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.body).toBe('docx payload');
  });

  test('forces active artifact types to download with defensive headers', async () => {
    const dataDir = makeTempDataDir();
    const artifactPath = path.join(
      dataDir,
      'agents',
      'agent-1',
      'workspace',
      'dashboard.html',
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, '<script>window.pwned = true;</script>', 'utf8');

    const state = await importFreshHealth({
      dataDir,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: `/api/artifact?path=${encodeURIComponent(artifactPath)}&token=web-token`,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/octet-stream');
    expect(res.headers['Content-Disposition']).toContain(
      'attachment; filename="dashboard.html"',
    );
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Content-Security-Policy']).toBe(
      "sandbox; default-src 'none'",
    );
    expect(res.body).toContain('window.pwned');
  });

  test('mentions query-token auth in artifact auth failures', async () => {
    const dataDir = makeTempDataDir();
    const artifactPath = path.join(
      dataDir,
      'agents',
      'agent-1',
      'workspace',
      'quarterly-update.docx',
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, 'docx payload', 'utf8');

    const state = await importFreshHealth({
      dataDir,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: `/api/artifact?path=${encodeURIComponent(artifactPath)}`,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error:
        'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>` or pass `?token=<WEB_API_TOKEN>`.',
    });
  });

  test('rejects symlinked artifact paths that escape the allowed roots', async () => {
    const dataDir = makeTempDataDir();
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-health-outside-'),
    );
    tempDirs.push(outsideDir);
    const outsideFilePath = path.join(outsideDir, 'secret.docx');
    fs.writeFileSync(outsideFilePath, 'top secret', 'utf8');

    const symlinkPath = path.join(
      dataDir,
      'agents',
      'agent-1',
      'workspace',
      'secret-link.docx',
    );
    fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
    fs.symlinkSync(outsideFilePath, symlinkPath);

    const state = await importFreshHealth({
      dataDir,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: `/api/artifact?path=${encodeURIComponent(symlinkPath)}&token=web-token`,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Artifact not found.',
    });
  });

  test('returns 500 when artifact streaming fails before headers are sent', async () => {
    const dataDir = makeTempDataDir();
    const artifactPath = path.join(
      dataDir,
      'agents',
      'agent-1',
      'workspace',
      'broken.docx',
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, 'broken payload', 'utf8');

    const createReadStreamSpy = vi
      .spyOn(fs, 'createReadStream')
      .mockImplementationOnce(() => {
        const stream = new Readable({
          read() {
            this.destroy(new Error('boom'));
          },
        });
        return stream as unknown as fs.ReadStream;
      });

    const state = await importFreshHealth({
      dataDir,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: `/api/artifact?path=${encodeURIComponent(artifactPath)}&token=web-token`,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Failed to read artifact.',
    });
    createReadStreamSpy.mockRestore();
  });
});
