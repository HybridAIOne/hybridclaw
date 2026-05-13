import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import conciergeRouterPlugin from '../plugins/concierge-router/src/index.js';
import {
  createPendingStore,
  resolvePendingStatePath,
} from '../plugins/concierge-router/src/routing.js';

function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeApi(homeDir: string, pluginConfig: Record<string, unknown> = {}) {
  const api = {
    pluginId: 'concierge-router',
    pluginDir: path.join(homeDir, 'readonly-plugin-dir'),
    runtime: {
      homeDir,
      cwd: path.join(homeDir, 'workspace'),
    },
    config: {},
    pluginConfig,
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    resolvePath(relative: string) {
      return path.join(api.pluginDir, relative);
    },
    registerMiddleware: vi.fn(),
    registerCommand: vi.fn(),
    registerInboundWebhook: vi.fn(),
    dispatchInboundMessage: vi.fn(async () => ({
      status: 'success',
      result: 'resumed',
      toolsUsed: [],
    })),
  };
  return api;
}

function makeRequest(
  body: unknown,
  authorization?: string,
): Readable & {
  headers: Record<string, string>;
} {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    headers: authorization ? { authorization } : {},
  });
}

function makeResponse() {
  const response = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    writeHead(statusCode: number, headers: Record<string, string>) {
      response.statusCode = statusCode;
      response.headers = headers;
    },
    end(chunk?: unknown) {
      response.body =
        chunk == null
          ? ''
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf-8')
            : String(chunk);
    },
  };
  return response;
}

test('concierge pending store writes under runtime home with async state APIs', async () => {
  const homeDir = await makeTempDir('hybridclaw-concierge-state-');
  const api = makeApi(homeDir);
  const store = createPendingStore(api);

  await store.set('session-1', {
    originalUserContent: 'Create a deck',
    createdAt: '2026-05-13T00:00:00.000Z',
    media: [],
    userId: 'user-1',
    channelId: 'web',
  });

  expect(resolvePendingStatePath(api).startsWith(homeDir)).toBe(true);
  expect(resolvePendingStatePath(api)).not.toContain(api.pluginDir);
  await expect(
    fs.readFile(resolvePendingStatePath(api), 'utf-8'),
  ).resolves.toContain('Create a deck');
  await expect(store.get('session-1')).resolves.toMatchObject({
    originalUserContent: 'Create a deck',
    userId: 'user-1',
    channelId: 'web',
  });
});

test('concierge webhook requires authorization and matching pending user', async () => {
  const homeDir = await makeTempDir('hybridclaw-concierge-webhook-');
  const api = makeApi(homeDir, { webhookSecret: 'test-secret' });
  conciergeRouterPlugin.register(api);
  const webhook = api.registerInboundWebhook.mock.calls[0]?.[0];
  expect(webhook?.name).toBe('choice');

  const store = createPendingStore(api);
  await store.set('session-1', {
    originalUserContent: 'Create a deck',
    createdAt: '2026-05-13T00:00:00.000Z',
    media: [],
    userId: 'user-1',
    channelId: 'web',
  });

  const forbidden = makeResponse();
  await webhook.handler({
    req: makeRequest({
      sessionId: 'session-1',
      userId: 'user-1',
      profile: 'asap',
      channelId: 'web',
    }),
    res: forbidden,
  });
  expect(forbidden.statusCode).toBe(403);
  expect(api.dispatchInboundMessage).not.toHaveBeenCalled();

  const mismatchedUser = makeResponse();
  await webhook.handler({
    req: makeRequest(
      {
        sessionId: 'session-1',
        userId: 'user-2',
        profile: 'asap',
        channelId: 'web',
      },
      'Bearer test-secret',
    ),
    res: mismatchedUser,
  });
  expect(mismatchedUser.statusCode).toBe(403);
  expect(api.dispatchInboundMessage).not.toHaveBeenCalled();

  const accepted = makeResponse();
  await webhook.handler({
    req: makeRequest(
      {
        sessionId: 'session-1',
        userId: 'user-1',
        profile: 'asap',
        channelId: 'web',
      },
      'Bearer test-secret',
    ),
    res: accepted,
  });
  expect(accepted.statusCode).toBe(200);
  expect(api.dispatchInboundMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-1',
      userId: 'user-1',
      content: 'asap',
    }),
  );
});
