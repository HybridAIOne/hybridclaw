import { afterEach, describe, expect, test, vi } from 'vitest';

async function importFreshIMessageRuntime(options?: {
  sendTextRefs?: Array<{
    channelId?: string | null;
    messageId?: string | null;
    text?: string | null;
  }>;
  agents?: {
    defaultAgentId?: string;
    list?: Array<{
      id: string;
      name?: string;
      displayName?: string;
    }>;
  };
  sessionAgentId?: string | null;
}) {
  vi.resetModules();
  const start = vi.fn(async () => {});
  const sendText = vi.fn(async () => options?.sendTextRefs || []);
  const backendFactory = vi.fn(() => ({
    start,
    sendText,
    sendMedia: vi.fn(async () => null),
    shutdown: vi.fn(async () => {}),
  }));
  vi.doMock('../src/config/config.js', () => ({
    getConfigSnapshot: vi.fn(() => ({
      imessage: {
        enabled: true,
        backend: 'local',
        cliPath: 'imsg',
        dbPath: '/tmp/chat.db',
        pollIntervalMs: 2500,
        serverUrl: '',
        password: '',
        webhookPath: '/api/imessage/webhook',
        allowPrivateNetwork: false,
        dmPolicy: 'open',
        groupPolicy: 'disabled',
        allowFrom: [],
        groupAllowFrom: [],
        textChunkLimit: 4000,
        debounceMs: 2500,
        mediaMaxMb: 20,
      },
      agents: {
        defaultAgentId: options?.agents?.defaultAgentId || 'main',
        list: options?.agents?.list || [],
      },
    })),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
    },
  }));
  vi.doMock('../src/memory/memory-service.js', () => ({
    memoryService: {
      getSessionById: vi.fn((sessionId: string) =>
        options?.sessionAgentId
          ? {
              id: sessionId,
              agent_id: options.sessionAgentId,
            }
          : undefined,
      ),
    },
  }));
  vi.doMock('../src/channels/channel-registry.js', () => ({
    registerChannel: vi.fn(),
  }));
  vi.doMock('../src/channels/imessage/backend-local.js', () => ({
    createLocalIMessageBackend: backendFactory,
  }));
  vi.doMock('../src/channels/imessage/backend-bluebubbles.js', () => ({
    createBlueBubblesIMessageBackend: vi.fn(),
  }));

  const runtimeModule = await import('../src/channels/imessage/runtime.js');
  return {
    ...runtimeModule,
    backendFactory,
    start,
    sendText,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/logger.js');
  vi.doUnmock('../src/memory/memory-service.js');
  vi.doUnmock('../src/channels/channel-registry.js');
  vi.doUnmock('../src/channels/imessage/backend-local.js');
  vi.doUnmock('../src/channels/imessage/backend-bluebubbles.js');
});

describe('iMessage runtime', () => {
  test('returns 404 for webhook requests when the active backend does not implement webhooks', async () => {
    const { createIMessageRuntime } = await importFreshIMessageRuntime();
    const runtime = createIMessageRuntime();
    const handler = vi.fn(async () => {});

    await runtime.initIMessage(handler);

    const req = {} as never;
    const res = {
      headersSent: false,
      statusCode: 200,
      end: vi.fn(),
    } as unknown as import('node:http').ServerResponse;

    await expect(runtime.handleIMessageWebhook(req, res)).resolves.toBe(false);
    expect(res.statusCode).toBe(404);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  test('drops duplicate inbound events that reuse the same message id', async () => {
    const { createIMessageRuntime, backendFactory, start } =
      await importFreshIMessageRuntime();
    const runtime = createIMessageRuntime();
    const handler = vi.fn(async () => {});

    await runtime.initIMessage(handler);
    expect(start).toHaveBeenCalledTimes(1);

    const backend = backendFactory.mock.results[0]?.value as {
      start: () => Promise<void>;
    };
    const onInbound = backendFactory.mock.calls[0]?.[0]
      ?.onInbound as (message: {
      sessionId: string;
      guildId: null;
      channelId: string;
      userId: string;
      username: string;
      content: string;
      media: [];
      messageId: string;
      conversationId: string;
      handle: string;
      isGroup: boolean;
      backend: 'local';
      rawEvent: unknown;
    }) => Promise<void>;
    void backend;

    const inbound = {
      sessionId: 'session-1',
      guildId: null,
      channelId: 'imessage:+14155551212',
      userId: '+14155551212',
      username: 'Alice',
      content: '/stop',
      media: [],
      messageId: 'msg-1',
      conversationId: 'any;-;+14155551212',
      handle: '+14155551212',
      isGroup: false,
      backend: 'local' as const,
      rawEvent: { rowid: 1 },
    };

    await onInbound(inbound);
    await onInbound(inbound);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('drops reflected local self-chat duplicates after the first inbound copy', async () => {
    const { createIMessageRuntime, backendFactory } =
      await importFreshIMessageRuntime();
    const runtime = createIMessageRuntime();
    const handler = vi.fn(async () => {});

    await runtime.initIMessage(handler);

    const onInbound = backendFactory.mock.calls[0]?.[0]
      ?.onInbound as (message: {
      sessionId: string;
      guildId: null;
      channelId: string;
      userId: string;
      username: string;
      content: string;
      media: [];
      messageId: string;
      conversationId: string;
      handle: string;
      isGroup: boolean;
      backend: 'local';
      rawEvent: unknown;
    }) => Promise<void>;

    await onInbound({
      sessionId: 'session-1',
      guildId: null,
      channelId: 'imessage:+14155551212',
      userId: '+14155551212',
      username: 'Alice',
      content: '/stop',
      media: [],
      messageId: 'local:101',
      conversationId: 'any;-;+14155551212',
      handle: '+14155551212',
      isGroup: false,
      backend: 'local',
      rawEvent: {
        rowid: 101,
        isFromMe: 1,
        handle: '+14155551212',
        chatIdentifier: '+14155551212',
        messageDate: 123456789,
      },
    });
    await onInbound({
      sessionId: 'session-1',
      guildId: null,
      channelId: 'imessage:+14155551212',
      userId: '+14155551212',
      username: 'Alice',
      content: '/stop',
      media: [],
      messageId: 'local:102',
      conversationId: 'any;-;+14155551212',
      handle: '+14155551212',
      isGroup: false,
      backend: 'local',
      rawEvent: {
        rowid: 102,
        isFromMe: 0,
        handle: '+14155551212',
        chatIdentifier: '+14155551212',
        messageDate: 123456789,
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      'session-1',
      null,
      'imessage:+14155551212',
      '+14155551212',
      'Alice',
      '/stop',
      [],
      expect.any(Function),
      expect.objectContaining({
        inbound: expect.objectContaining({
          backend: 'local',
          handle: '+14155551212',
        }),
      }),
    );
  });

  test('drops mirrored local self-chat user prompts when the second copy arrives with opposite isFromMe', async () => {
    const { createIMessageRuntime, backendFactory } =
      await importFreshIMessageRuntime();
    const runtime = createIMessageRuntime();
    const handler = vi.fn(async () => {});

    await runtime.initIMessage(handler);

    const onInbound = backendFactory.mock.calls[0]?.[0]
      ?.onInbound as (message: {
      sessionId: string;
      guildId: null;
      channelId: string;
      userId: string;
      username: string;
      content: string;
      media: [];
      messageId: string;
      conversationId: string;
      handle: string;
      isGroup: boolean;
      backend: 'local';
      rawEvent: unknown;
    }) => Promise<void>;

    await onInbound({
      sessionId: 'session-mirror-1',
      guildId: null,
      channelId: 'imessage:+14155551212',
      userId: '+14155551212',
      username: 'Alice',
      content: '/pause',
      media: [],
      messageId: 'local:151',
      conversationId: 'any;-;+14155551212',
      handle: '+14155551212',
      isGroup: false,
      backend: 'local',
      rawEvent: {
        rowid: 151,
        isFromMe: 0,
        handle: '+14155551212',
        chatIdentifier: '+14155551212',
        messageDate: 223344551,
      },
    });
    await onInbound({
      sessionId: 'session-mirror-1',
      guildId: null,
      channelId: 'imessage:+14155551212',
      userId: '+14155551212',
      username: 'Alice',
      content: '/pause',
      media: [],
      messageId: 'local:152',
      conversationId: 'any;-;+14155551212',
      handle: '+14155551212',
      isGroup: false,
      backend: 'local',
      rawEvent: {
        rowid: 152,
        isFromMe: 1,
        handle: '+14155551212',
        chatIdentifier: '+14155551212',
        messageDate: 223344559,
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('drops local self-chat agent echoes reflected back with SQLite row ids', async () => {
    const { createIMessageRuntime, backendFactory } =
      await importFreshIMessageRuntime({
        sendTextRefs: [
          {
            channelId: 'imessage:+14155551212',
            text: 'Hello from agent',
          },
        ],
      });
    const runtime = createIMessageRuntime();
    const handler = vi.fn(async () => {});

    await runtime.initIMessage(handler);
    await runtime.sendToIMessageChat(
      'imessage:+14155551212',
      'Hello from agent',
    );

    const onInbound = backendFactory.mock.calls[0]?.[0]
      ?.onInbound as (message: {
      sessionId: string;
      guildId: null;
      channelId: string;
      userId: string;
      username: string;
      content: string;
      media: [];
      messageId: string;
      conversationId: string;
      handle: string;
      isGroup: boolean;
      backend: 'local';
      rawEvent: unknown;
    }) => Promise<void>;

    await onInbound({
      sessionId: 'session-2',
      guildId: null,
      channelId: 'imessage:+14155551212',
      userId: '+14155551212',
      username: 'Alice',
      content: 'Hello from agent',
      media: [],
      messageId: 'local:201',
      conversationId: 'any;-;+14155551212',
      handle: '+14155551212',
      isGroup: false,
      backend: 'local',
      rawEvent: {
        rowid: 201,
        isFromMe: 1,
        handle: '+14155551212',
        chatIdentifier: '+14155551212',
        messageDate: 987654321,
      },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  test('prefixes local self-chat replies with [hybridclaw]', async () => {
    const { createIMessageRuntime, backendFactory, sendText } =
      await importFreshIMessageRuntime({
        sendTextRefs: [
          {
            channelId: 'imessage:+14155551212',
            text: '[hybridclaw] hello from the bot',
          },
        ],
      });
    const runtime = createIMessageRuntime();
    const handler = vi.fn(async (...args: unknown[]) => {
      const reply = args[7] as (content: string) => Promise<void>;
      await reply('hello from the bot');
    });

    await runtime.initIMessage(handler);

    const onInbound = backendFactory.mock.calls[0]?.[0]
      ?.onInbound as (message: {
      sessionId: string;
      guildId: null;
      channelId: string;
      userId: string;
      username: string;
      content: string;
      media: [];
      messageId: string;
      conversationId: string;
      handle: string;
      isGroup: boolean;
      backend: 'local';
      rawEvent: unknown;
    }) => Promise<void>;

    await onInbound({
      sessionId: 'session-3',
      guildId: null,
      channelId: 'imessage:+14155551212',
      userId: '+14155551212',
      username: 'Alice',
      content: '/stop',
      media: [],
      messageId: 'local:300',
      conversationId: 'any;-;+14155551212',
      handle: '+14155551212',
      isGroup: false,
      backend: 'local',
      rawEvent: {
        rowid: 300,
        isFromMe: 1,
        handle: '+14155551212',
        chatIdentifier: '+14155551212',
        messageDate: 111222332,
      },
    });

    expect(sendText).toHaveBeenCalledWith(
      'imessage:+14155551212',
      ['[hybridclaw] hello from the bot'][0],
    );
  });

  test('drops reflected local self-chat messages that come back with a marker prefix fragment', async () => {
    const { createIMessageRuntime, backendFactory } =
      await importFreshIMessageRuntime();
    const runtime = createIMessageRuntime();
    const handler = vi.fn(async () => {});

    await runtime.initIMessage(handler);

    const onInbound = backendFactory.mock.calls[0]?.[0]
      ?.onInbound as (message: {
      sessionId: string;
      guildId: null;
      channelId: string;
      userId: string;
      username: string;
      content: string;
      media: [];
      messageId: string;
      conversationId: string;
      handle: string;
      isGroup: boolean;
      backend: 'local';
      rawEvent: unknown;
    }) => Promise<void>;

    await onInbound({
      sessionId: 'session-4',
      guildId: null,
      channelId: 'imessage:+14155551212',
      userId: '+14155551212',
      username: 'Alice',
      content: 'R [hybridclaw] HybridClaw Status-Update (aktuell, II)',
      media: [],
      messageId: 'local:400',
      conversationId: 'any;-;+14155551212',
      handle: '+14155551212',
      isGroup: false,
      backend: 'local',
      rawEvent: {
        rowid: 400,
        isFromMe: 0,
        handle: '+14155551212',
        chatIdentifier: '+14155551212',
        messageDate: 444555665,
      },
    });
    await onInbound({
      sessionId: 'session-4',
      guildId: null,
      channelId: 'imessage:+14155551212',
      userId: '+14155551212',
      username: 'Alice',
      content: 'X [hybridclaw] HybridClaw Status-Update (aktuell)',
      media: [],
      messageId: 'local:401',
      conversationId: 'any;-;+14155551212',
      handle: '+14155551212',
      isGroup: false,
      backend: 'local',
      rawEvent: {
        rowid: 401,
        isFromMe: 0,
        handle: '+14155551212',
        chatIdentifier: '+14155551212',
        messageDate: 444555666,
      },
    });
    await onInbound({
      sessionId: 'session-4',
      guildId: null,
      channelId: 'imessage:+14155551212',
      userId: '+14155551212',
      username: 'Alice',
      content: 'hybridclaw] Kurze Digest:',
      media: [],
      messageId: 'local:402',
      conversationId: 'any;-;+14155551212',
      handle: '+14155551212',
      isGroup: false,
      backend: 'local',
      rawEvent: {
        rowid: 402,
        isFromMe: 0,
        handle: '+14155551212',
        chatIdentifier: '+14155551212',
        messageDate: 444555667,
      },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  test('does not prefix non-self iMessage replies', async () => {
    const { createIMessageRuntime, backendFactory, sendText } =
      await importFreshIMessageRuntime({
        sendTextRefs: [
          {
            channelId: 'imessage:+14155551212',
            text: 'hello from the bot',
          },
        ],
      });
    const runtime = createIMessageRuntime();
    const handler = vi.fn(async (...args: unknown[]) => {
      const reply = args[7] as (content: string) => Promise<void>;
      await reply('hello from the bot');
    });

    await runtime.initIMessage(handler);

    const onInbound = backendFactory.mock.calls[0]?.[0]
      ?.onInbound as (message: {
      sessionId: string;
      guildId: null;
      channelId: string;
      userId: string;
      username: string;
      content: string;
      media: [];
      messageId: string;
      conversationId: string;
      handle: string;
      isGroup: boolean;
      backend: 'local';
      rawEvent: unknown;
    }) => Promise<void>;

    await onInbound({
      sessionId: 'session-5',
      guildId: null,
      channelId: 'imessage:+14155551212',
      userId: '+14155551212',
      username: 'Alice',
      content: '/stop',
      media: [],
      messageId: 'local:301',
      conversationId: 'any;-;+14155551212',
      handle: '+14155551212',
      isGroup: false,
      backend: 'local',
      rawEvent: {
        rowid: 301,
        isFromMe: 0,
        handle: '+14155550000',
        chatIdentifier: '+14155551212',
        messageDate: 111222333,
      },
    });

    expect(sendText).toHaveBeenCalledWith(
      'imessage:+14155551212',
      'hello from the bot',
    );
  });

  test('prefixes non-main self-chat replies with the agent display name', async () => {
    const { createIMessageRuntime, backendFactory, sendText } =
      await importFreshIMessageRuntime({
        agents: {
          list: [{ id: 'charly', displayName: 'Charly' }],
        },
        sessionAgentId: 'charly',
      });
    const runtime = createIMessageRuntime();
    const handler = vi.fn(async (...args: unknown[]) => {
      const reply = args[7] as (content: string) => Promise<void>;
      await reply('hello from the bot');
    });

    await runtime.initIMessage(handler);

    const onInbound = backendFactory.mock.calls[0]?.[0]
      ?.onInbound as (message: {
      sessionId: string;
      guildId: null;
      channelId: string;
      userId: string;
      username: string;
      content: string;
      media: [];
      messageId: string;
      conversationId: string;
      handle: string;
      isGroup: boolean;
      backend: 'local';
      rawEvent: unknown;
    }) => Promise<void>;

    await onInbound({
      sessionId:
        'agent:charly:channel:imessage:chat:dm:peer:imessage%3A%2B14155551212',
      guildId: null,
      channelId: 'imessage:+14155551212',
      userId: '+14155551212',
      username: 'Alice',
      content: '/stop',
      media: [],
      messageId: 'local:501',
      conversationId: 'any;-;+14155551212',
      handle: '+14155551212',
      isGroup: false,
      backend: 'local',
      rawEvent: {
        rowid: 501,
        isFromMe: 1,
        handle: '+14155551212',
        chatIdentifier: '+14155551212',
        messageDate: 111222334,
      },
    });

    expect(sendText).toHaveBeenCalledWith(
      'imessage:+14155551212',
      '[Charly] hello from the bot',
    );
  });

  test('prefers the active session agent over the canonical session key for self-chat prefixes', async () => {
    const { createIMessageRuntime, backendFactory, sendText } =
      await importFreshIMessageRuntime({
        agents: {
          list: [{ id: 'charly', displayName: 'Charly' }],
        },
        sessionAgentId: 'charly',
      });
    const runtime = createIMessageRuntime();
    const handler = vi.fn(async (...args: unknown[]) => {
      const reply = args[7] as (content: string) => Promise<void>;
      await reply('hello from the bot');
    });

    await runtime.initIMessage(handler);

    const onInbound = backendFactory.mock.calls[0]?.[0]
      ?.onInbound as (message: {
      sessionId: string;
      guildId: null;
      channelId: string;
      userId: string;
      username: string;
      content: string;
      media: [];
      messageId: string;
      conversationId: string;
      handle: string;
      isGroup: boolean;
      backend: 'local';
      rawEvent: unknown;
    }) => Promise<void>;

    await onInbound({
      sessionId:
        'agent:main:channel:imessage:chat:dm:peer:imessage%3A%2B14155551212',
      guildId: null,
      channelId: 'imessage:+14155551212',
      userId: '+14155551212',
      username: 'Alice',
      content: '/stop',
      media: [],
      messageId: 'local:502',
      conversationId: 'any;-;+14155551212',
      handle: '+14155551212',
      isGroup: false,
      backend: 'local',
      rawEvent: {
        rowid: 502,
        isFromMe: 1,
        handle: '+14155551212',
        chatIdentifier: '+14155551212',
        messageDate: 111222335,
      },
    });

    expect(sendText).toHaveBeenCalledWith(
      'imessage:+14155551212',
      '[Charly] hello from the bot',
    );
  });

  test('drops reflected local self-chat replies with no-space marker junk before the agent prefix', async () => {
    const { createIMessageRuntime, backendFactory } =
      await importFreshIMessageRuntime({
        agents: {
          list: [{ id: 'lena', displayName: 'lena' }],
        },
        sessionAgentId: 'lena',
      });
    const runtime = createIMessageRuntime();
    const handler = vi.fn(async () => {});

    await runtime.initIMessage(handler);

    const onInbound = backendFactory.mock.calls[0]?.[0]
      ?.onInbound as (message: {
      sessionId: string;
      guildId: null;
      channelId: string;
      userId: string;
      username: string;
      content: string;
      media: [];
      messageId: string;
      conversationId: string;
      handle: string;
      isGroup: boolean;
      backend: 'local';
      rawEvent: unknown;
    }) => Promise<void>;

    await onInbound({
      sessionId:
        'agent:main:channel:imessage:chat:dm:peer:imessage%3A%2B14155551212',
      guildId: null,
      channelId: 'imessage:+14155551212',
      userId: '+14155551212',
      username: 'Alice',
      content: '+B[lena] Session agent set to `lena`',
      media: [],
      messageId: 'local:503',
      conversationId: 'any;-;+14155551212',
      handle: '+14155551212',
      isGroup: false,
      backend: 'local',
      rawEvent: {
        rowid: 503,
        isFromMe: 0,
        handle: '+14155551212',
        chatIdentifier: '+14155551212',
        messageDate: 111222336,
      },
    });

    expect(handler).not.toHaveBeenCalled();
  });
});
