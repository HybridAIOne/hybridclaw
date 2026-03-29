import { Readable } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';

function makeRequest(params: {
  method?: string;
  url: string;
  body?: unknown;
  remoteAddress?: string;
}) {
  const chunks =
    params.body === undefined
      ? []
      : [Buffer.from(JSON.stringify(params.body), 'utf8')];
  return Object.assign(Readable.from(chunks), {
    method: params.method || 'POST',
    url: params.url,
    headers: {
      'content-type': 'application/json',
    },
    socket: {
      remoteAddress: params.remoteAddress || '198.51.100.10',
    },
  });
}

function makeResponse() {
  return {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') {
        this.body += chunk;
      }
      this.writableEnded = true;
      this.headersSent = true;
    },
  };
}

async function importFreshBlueBubblesBackend(options?: {
  allowPrivateNetwork?: boolean;
  password?: string;
  serverUrl?: string;
}) {
  vi.resetModules();
  vi.doMock('../src/config/config.js', () => ({
    IMESSAGE_ALLOW_PRIVATE_NETWORK: options?.allowPrivateNetwork ?? false,
    IMESSAGE_MEDIA_MAX_MB: 20,
    IMESSAGE_PASSWORD: options?.password ?? 'test-password',
    IMESSAGE_SERVER_URL:
      options?.serverUrl ?? 'https://bb.example.com',
    IMESSAGE_TEXT_CHUNK_LIMIT: 4000,
    getConfigSnapshot: vi.fn(() => ({
      imessage: {
        enabled: true,
        backend: 'bluebubbles',
        cliPath: 'imsg',
        dbPath: '/tmp/chat.db',
        pollIntervalMs: 2500,
        serverUrl: options?.serverUrl ?? 'https://bb.example.com',
        password: options?.password ?? 'test-password',
        webhookPath: '/api/imessage/webhook',
        allowPrivateNetwork: options?.allowPrivateNetwork ?? false,
        dmPolicy: 'open',
        groupPolicy: 'disabled',
        allowFrom: [],
        groupAllowFrom: [],
        textChunkLimit: 4000,
        debounceMs: 2500,
        mediaMaxMb: 20,
      },
    })),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  }));
  return await import('../src/channels/imessage/backend-bluebubbles.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/logger.js');
  vi.unstubAllGlobals();
});

describe('bluebubbles iMessage backend', () => {
  test('rejects unauthorized webhook requests', async () => {
    const { createBlueBubblesIMessageBackend } =
      await importFreshBlueBubblesBackend();
    const onInbound = vi.fn(async () => {});
    const backend = createBlueBubblesIMessageBackend({ onInbound });
    const req = makeRequest({
      url: '/api/imessage/webhook?password=wrong',
      body: { type: 'new-message' },
    });
    const res = makeResponse();

    await backend.handleWebhook?.(req as never, res as never);

    expect(res.statusCode).toBe(401);
    expect(onInbound).not.toHaveBeenCalled();
  });

  test('accepts authenticated new-message webhooks and normalizes inbound data', async () => {
    const { createBlueBubblesIMessageBackend } =
      await importFreshBlueBubblesBackend();
    const onInbound = vi.fn(async () => {});
    const backend = createBlueBubblesIMessageBackend({ onInbound });
    const req = makeRequest({
      url: '/api/imessage/webhook?password=test-password',
      body: {
        type: 'new-message',
        data: {
          guid: 'msg-1',
          text: 'hello',
          isFromMe: false,
          handle: {
            address: '+14155551212',
          },
          chats: [
            {
              guid: 'any;-;+14155551212',
              displayName: '',
              participants: [{ address: '+14155551212' }],
            },
          ],
        },
      },
    });
    const res = makeResponse();

    await backend.handleWebhook?.(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(onInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'imessage:+14155551212',
        userId: '+14155551212',
        messageId: 'msg-1',
      }),
    );
  });

  test('blocks private BlueBubbles server urls unless explicitly allowed', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { createBlueBubblesIMessageBackend } =
      await importFreshBlueBubblesBackend({
        serverUrl: 'http://127.0.0.1:1234',
      });
    const backend = createBlueBubblesIMessageBackend({
      onInbound: vi.fn(async () => {}),
    });

    await expect(
      backend.sendText('imessage:+14155551212', 'hello'),
    ).rejects.toThrow(/Blocked BlueBubbles server URL host/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
