import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, test, vi } from 'vitest';

const processMock = vi.fn();
const credentialsFactoryMock = vi.fn();
const authConfigMock = vi.fn();
const typingStartMock = vi.fn();
const typingStopMock = vi.fn();
const sendChunkedReplyMock = vi.fn(async () => {});
const continueConversationAsyncMock = vi.fn();
const buildTeamsAttachmentContextMock = vi.fn(async () => []);
const maybeHandleMSTeamsFileConsentInvokeMock = vi.fn(async () => false);
const getMemoryValueMock = vi.fn();
const setMemoryValueMock = vi.fn();
const extractPrimaryTextMock = vi.fn(() => 'Hi!');
const parseCommandMock = vi.fn(() => ({
  args: [],
  command: '',
  isCommand: false,
}));
const loggerDebugMock = vi.fn();
const loggerErrorMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerWarnMock = vi.fn();
const cloudAdapters: Array<{ onTurnError?: unknown }> = [];

function makeRequest(body: unknown): IncomingMessage {
  return Object.assign(
    Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]),
    {
      method: 'POST',
      url: '/api/msteams/messages',
      headers: {
        authorization: 'Bearer test-token',
      },
    },
  ) as IncomingMessage;
}

function makeResponse(): ServerResponse {
  const headers = new Map<string, string>();
  const response = {
    socket: {},
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    body: '',
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    hasHeader(name: string) {
      return headers.has(name.toLowerCase());
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
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
        response.write(chunk);
      }
      response.headersSent = true;
      response.writableEnded = true;
    },
  };
  return response as unknown as ServerResponse;
}

function makeStoredConversationReference() {
  return {
    channelId: 'conversation-123',
    isDm: true,
    reference: {
      bot: { id: 'bot-id' },
      channelId: 'msteams',
      conversation: {
        id: 'conversation-123',
        conversationType: 'personal',
      },
      locale: 'de-DE',
      serviceUrl: 'https://smba.trafficmanager.net/de/tenant-id/',
      user: { id: 'user-id', name: 'User' },
    },
    replyStyle: 'thread' as const,
    replyToId: 'incoming-1',
  };
}

async function importRuntime() {
  vi.resetModules();

  vi.doMock('botbuilder', () => ({
    CloudAdapter: class {
      onTurnError?: unknown;

      constructor() {
        cloudAdapters.push(this);
      }

      process = processMock;
      continueConversationAsync = continueConversationAsyncMock;
    },
  }));
  vi.doMock('botbuilder-core', () => ({
    ConfigurationBotFrameworkAuthentication: class {
      constructor(...args: unknown[]) {
        authConfigMock(...args);
      }
    },
    ConfigurationServiceClientCredentialFactory: class {
      constructor(...args: unknown[]) {
        credentialsFactoryMock(...args);
      }
    },
  }));
  vi.doMock('botframework-schema', () => ({
    ActivityTypes: {
      Message: 'message',
    },
  }));
  vi.doMock('../src/config/config.js', () => ({
    APP_VERSION: '0.7.1',
    DATA_DIR: '/tmp/hybridclaw-test-data',
    MSTEAMS_APP_ID: 'teams-app-id',
    MSTEAMS_APP_PASSWORD: 'teams-secret',
    MSTEAMS_ENABLED: true,
    MSTEAMS_TENANT_ID: 'teams-tenant-id',
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: loggerDebugMock,
      error: loggerErrorMock,
      info: loggerInfoMock,
      warn: loggerWarnMock,
    },
  }));
  vi.doMock('../src/memory/db.js', async () => {
    const actual = await vi.importActual('../src/memory/db.js');
    return {
      ...actual,
      getMemoryValue: getMemoryValueMock,
      setMemoryValue: setMemoryValueMock,
    };
  });
  vi.doMock('../src/channels/msteams/attachments.js', () => ({
    buildTeamsAttachmentContext: buildTeamsAttachmentContextMock,
    maybeHandleMSTeamsFileConsentInvoke:
      maybeHandleMSTeamsFileConsentInvokeMock,
    buildTeamsUploadedFileAttachment: vi.fn(async () => ({
      contentType: 'image/png',
      contentUrl: 'https://example.com/attachment.png',
      name: 'attachment.png',
    })),
  }));
  vi.doMock('../src/channels/msteams/delivery.js', () => ({
    sendChunkedReply: sendChunkedReplyMock,
  }));
  vi.doMock('../src/channels/msteams/inbound.js', () => ({
    buildSessionIdFromActivity: vi.fn(() => 'teams:dm:user'),
    cleanIncomingContent: vi.fn(() => 'Hi!'),
    extractPrimaryText: extractPrimaryTextMock,
    extractActorIdentity: vi.fn(() => ({
      aadObjectId: 'user-aad-id',
      displayName: 'User',
      userId: 'user-id',
      username: 'user',
    })),
    extractTeamsTeamId: vi.fn(() => null),
    hasBotMention: vi.fn(() => false),
    isTeamsDm: vi.fn(() => true),
    parseCommand: parseCommandMock,
  }));
  vi.doMock('../src/channels/msteams/send-permissions.js', () => ({
    resolveMSTeamsChannelPolicy: vi.fn(() => ({
      allowed: true,
      replyStyle: 'thread',
      requireMention: false,
      tools: [],
    })),
  }));
  vi.doMock('../src/channels/msteams/stream.js', () => ({
    MSTeamsStreamManager: class {},
  }));
  vi.doMock('../src/channels/msteams/typing.js', () => ({
    createMSTeamsTypingController: vi.fn(() => ({
      start: typingStartMock,
      stop: typingStopMock,
    })),
  }));

  return import('../src/channels/msteams/runtime.js');
}

afterEach(() => {
  processMock.mockReset();
  credentialsFactoryMock.mockReset();
  authConfigMock.mockReset();
  typingStartMock.mockReset();
  typingStopMock.mockReset();
  sendChunkedReplyMock.mockReset();
  continueConversationAsyncMock.mockReset();
  buildTeamsAttachmentContextMock.mockReset();
  buildTeamsAttachmentContextMock.mockResolvedValue([]);
  maybeHandleMSTeamsFileConsentInvokeMock.mockReset();
  maybeHandleMSTeamsFileConsentInvokeMock.mockResolvedValue(false);
  getMemoryValueMock.mockReset();
  getMemoryValueMock.mockReturnValue(null);
  setMemoryValueMock.mockReset();
  parseCommandMock.mockReset();
  parseCommandMock.mockReturnValue({
    args: [],
    command: '',
    isCommand: false,
  });
  extractPrimaryTextMock.mockReset();
  extractPrimaryTextMock.mockReturnValue('Hi!');
  loggerDebugMock.mockReset();
  loggerErrorMock.mockReset();
  loggerInfoMock.mockReset();
  loggerWarnMock.mockReset();
  cloudAdapters.length = 0;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('Microsoft Teams runtime webhook adapter', () => {
  test('parses the raw request body and adapts the Node response for botbuilder', async () => {
    processMock.mockResolvedValue(undefined);

    const runtime = await importRuntime();
    const req = makeRequest({ type: 'message', text: 'Hi!' });
    const res = makeResponse();

    await runtime.handleMSTeamsWebhook(req, res);

    expect(processMock).toHaveBeenCalledTimes(1);
    const [adapterReq, adapterRes] = processMock.mock.calls[0] as [
      { body?: unknown },
      {
        header: (name: string, value: string) => unknown;
        status: (statusCode: number) => unknown;
        send: (body?: unknown) => unknown;
        end: (chunk?: unknown) => unknown;
      },
    ];

    expect(adapterReq.body).toEqual({ type: 'message', text: 'Hi!' });
    expect(typeof adapterRes.header).toBe('function');
    expect(typeof adapterRes.status).toBe('function');
    expect(typeof adapterRes.send).toBe('function');
    expect(typeof adapterRes.end).toBe('function');

    adapterRes
      .status(202)
      .header('content-type', 'application/json; charset=utf-8')
      .send({ ok: true })
      .end();

    expect(res.statusCode).toBe(202);
    expect(res.getHeader('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(res.body).toBe('{"ok":true}');
    expect(res.writableEnded).toBe(true);
  });

  test('configures single-tenant credentials when a tenant id is present', async () => {
    processMock.mockResolvedValue(undefined);

    const runtime = await importRuntime();
    const req = makeRequest({ type: 'message', text: 'Hi!' });
    const res = makeResponse();

    await runtime.handleMSTeamsWebhook(req, res);

    expect(credentialsFactoryMock).toHaveBeenCalledWith({
      MicrosoftAppId: 'teams-app-id',
      MicrosoftAppPassword: 'teams-secret',
      MicrosoftAppTenantId: 'teams-tenant-id',
      MicrosoftAppType: 'SingleTenant',
    });
  });

  test('returns 401 when Bot Framework webhook authentication fails', async () => {
    processMock.mockRejectedValue(
      Object.assign(new Error('auth failed'), {
        name: 'AuthenticationError',
        statusCode: 401,
      }),
    );

    const runtime = await importRuntime();
    const req = makeRequest({ type: 'message', text: 'Hi!' });
    const res = makeResponse();

    await expect(
      runtime.handleMSTeamsWebhook(req, res),
    ).resolves.toBeUndefined();

    expect(res.statusCode).toBe(401);
    expect(res.writableEnded).toBe(true);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(Error),
        statusCode: 401,
      }),
      'Rejected Teams webhook due to Bot Framework authentication failure',
    );
  });

  test('fails fast when Teams runtime is initialized without handlers', async () => {
    const runtime = await importRuntime();

    expect(() =>
      runtime.initMSTeams(
        undefined as never,
        vi.fn(async () => {}),
      ),
    ).toThrow(
      'Teams runtime requires both message and command handlers during initialization.',
    );
    expect(() =>
      runtime.initMSTeams(
        vi.fn(async () => {}),
        undefined as never,
      ),
    ).toThrow(
      'Teams runtime requires both message and command handlers during initialization.',
    );
  });

  test('starts Teams typing while command messages are handled', async () => {
    processMock.mockImplementation(
      async (_req, _res, logic: (context: unknown) => Promise<void>) => {
        await logic({
          activity: {
            type: 'message',
            text: '/approve 3',
            conversation: { id: 'conversation-123' },
            recipient: { id: 'bot-id' },
          },
          sendActivity: vi.fn(async () => ({ id: 'reply-1' })),
          turnState: new Map(),
        });
      },
    );
    parseCommandMock.mockReturnValue({
      args: ['3'],
      command: 'approve',
      isCommand: true,
    });

    const runtime = await importRuntime();
    const onMessage = vi.fn(async () => {});
    const onCommand = vi.fn(async () => {});
    runtime.initMSTeams(onMessage, onCommand);

    const req = makeRequest({ type: 'message', text: '/approve 3' });
    const res = makeResponse();

    await runtime.handleMSTeamsWebhook(req, res);

    expect(onCommand).toHaveBeenCalledWith(
      'teams:dm:user',
      null,
      'conversation-123',
      'user-id',
      'User',
      ['approve', '3'],
      expect.any(Function),
    );
    expect(typingStartMock).toHaveBeenCalledTimes(1);
    expect(typingStopMock).toHaveBeenCalledTimes(1);
  });

  test('parses Teams commands from the primary message text only', async () => {
    processMock.mockImplementation(
      async (
        req: { body?: Record<string, unknown> },
        _res,
        logic: (context: unknown) => Promise<void>,
      ) => {
        await logic({
          activity: req.body,
          sendActivity: vi.fn(async () => ({ id: 'reply-1' })),
          turnState: new Map(),
        });
      },
    );
    extractPrimaryTextMock.mockReturnValue('/approve 2');
    parseCommandMock.mockImplementation((value: string) => {
      expect(value).toBe('/approve 2');
      return {
        args: ['2'],
        command: 'approve',
        isCommand: true,
      };
    });

    const runtime = await importRuntime();
    const onMessage = vi.fn(async () => {});
    const onCommand = vi.fn(async () => {});
    runtime.initMSTeams(onMessage, onCommand);

    const req = makeRequest({
      type: 'message',
      text: '/approve 2',
      conversation: { id: 'conversation-123' },
      recipient: { id: 'bot-id' },
      attachments: [
        {
          contentType: 'text/html',
          content: '<p>/approve 2</p>',
        },
      ],
    });
    const res = makeResponse();

    await runtime.handleMSTeamsWebhook(req, res);

    expect(onCommand).toHaveBeenCalledWith(
      'teams:dm:user',
      null,
      'conversation-123',
      'user-id',
      'User',
      ['approve', '2'],
      expect.any(Function),
    );
  });

  test('does not start Teams typing for quick local commands like clear', async () => {
    processMock.mockImplementation(
      async (_req, _res, logic: (context: unknown) => Promise<void>) => {
        await logic({
          activity: {
            type: 'message',
            text: '/clear',
            conversation: { id: 'conversation-123' },
            recipient: { id: 'bot-id' },
          },
          sendActivity: vi.fn(async () => ({ id: 'reply-1' })),
          turnState: new Map(),
        });
      },
    );
    parseCommandMock.mockReturnValue({
      args: [],
      command: 'clear',
      isCommand: true,
    });

    const runtime = await importRuntime();
    const onMessage = vi.fn(async () => {});
    const onCommand = vi.fn(async () => {});
    runtime.initMSTeams(onMessage, onCommand);

    const req = makeRequest({ type: 'message', text: '/clear' });
    const res = makeResponse();

    await runtime.handleMSTeamsWebhook(req, res);

    expect(onCommand).toHaveBeenCalledWith(
      'teams:dm:user',
      null,
      'conversation-123',
      'user-id',
      'User',
      ['clear'],
      expect.any(Function),
    );
    expect(typingStartMock).not.toHaveBeenCalled();
    expect(typingStopMock).not.toHaveBeenCalled();
  });

  test('awaits Teams attachment context before invoking the message handler', async () => {
    processMock.mockImplementation(
      async (_req, _res, logic: (context: unknown) => Promise<void>) => {
        await logic({
          activity: {
            type: 'message',
            text: 'What is on this image?',
            conversation: { id: 'conversation-123' },
            recipient: { id: 'bot-id' },
          },
          sendActivity: vi.fn(async () => ({ id: 'reply-1' })),
          turnState: new Map(),
        });
      },
    );
    buildTeamsAttachmentContextMock.mockResolvedValueOnce([
      {
        filename: 'teams-image.png',
        mimeType: 'image/png',
        originalUrl: 'https://example.com/teams-image.png',
        path: '/tmp/teams-image.png',
        sizeBytes: 3,
        url: 'https://example.com/teams-image.png',
      },
    ]);

    const runtime = await importRuntime();
    const onMessage = vi.fn(async () => {});
    const onCommand = vi.fn(async () => {});
    runtime.initMSTeams(onMessage, onCommand);

    const req = makeRequest({
      type: 'message',
      text: 'What is on this image?',
    });
    const res = makeResponse();

    await runtime.handleMSTeamsWebhook(req, res);

    expect(onMessage).toHaveBeenCalledWith(
      'teams:dm:user',
      null,
      'conversation-123',
      'user-id',
      'User',
      'Hi!',
      [
        {
          filename: 'teams-image.png',
          mimeType: 'image/png',
          originalUrl: 'https://example.com/teams-image.png',
          path: '/tmp/teams-image.png',
          sizeBytes: 3,
          url: 'https://example.com/teams-image.png',
        },
      ],
      expect.any(Function),
      expect.any(Object),
    );
  });

  test('persists a Teams conversation reference for accepted inbound messages', async () => {
    processMock.mockImplementation(
      async (_req, _res, logic: (context: unknown) => Promise<void>) => {
        await logic({
          activity: {
            type: 'message',
            text: 'persist this',
            id: 'incoming-1',
            channelId: 'msteams',
            from: { id: 'user-id', name: 'User' },
            locale: 'de-DE',
            serviceUrl: 'https://smba.trafficmanager.net/de/tenant-id/',
            conversation: {
              id: 'conversation-123',
              conversationType: 'personal',
            },
            recipient: { id: 'bot-id' },
          },
          sendActivity: vi.fn(async () => ({ id: 'reply-1' })),
          turnState: new Map(),
        });
      },
    );

    const runtime = await importRuntime();
    runtime.initMSTeams(
      vi.fn(async () => {}),
      vi.fn(async () => {}),
    );

    const req = makeRequest({ type: 'message', text: 'persist this' });
    const res = makeResponse();

    await runtime.handleMSTeamsWebhook(req, res);

    expect(setMemoryValueMock).toHaveBeenCalledWith(
      'teams:dm:user',
      'msteams:conversation-reference',
      expect.objectContaining({
        channelId: 'conversation-123',
        isDm: true,
        reference: expect.objectContaining({
          bot: { id: 'bot-id' },
          channelId: 'msteams',
          conversation: expect.objectContaining({
            id: 'conversation-123',
          }),
          serviceUrl: 'https://smba.trafficmanager.net/de/tenant-id/',
          user: { id: 'user-id', name: 'User' },
        }),
        replyStyle: 'thread',
        replyToId: 'incoming-1',
      }),
    );
  });

  test('routes Teams DM attachment sends as top-level replies', async () => {
    continueConversationAsyncMock.mockImplementation(
      async (
        _appId,
        _reference,
        logic: (context: unknown) => Promise<void>,
      ) => {
        await logic({
          sendActivities: vi.fn(async () => [{ id: 'reply-2' }]),
        });
      },
    );
    processMock.mockImplementation(
      async (_req, _res, logic: (context: unknown) => Promise<void>) => {
        await logic({
          activity: {
            type: 'message',
            text: 'upload this',
            id: 'incoming-1',
            channelId: 'msteams',
            from: { id: 'user-id', name: 'User' },
            serviceUrl: 'https://smba.trafficmanager.net/de/tenant-id/',
            conversation: {
              id: 'conversation-123',
              conversationType: 'personal',
            },
            recipient: { id: 'bot-id' },
          },
          sendActivity: vi.fn(async () => ({ id: 'reply-1' })),
          sendActivities: vi.fn(async () => [{ id: 'reply-1' }]),
          turnState: new Map(),
        });
      },
    );

    const runtime = await importRuntime();
    const onMessage = vi.fn(async (sessionId: string) => {
      await runtime.sendToActiveMSTeamsSession({
        sessionId,
        text: '',
        filePath: '/tmp/hybridclaw-homepage.png',
      });
    });
    const onCommand = vi.fn(async () => {});
    runtime.initMSTeams(onMessage, onCommand);

    const req = makeRequest({ type: 'message', text: 'upload this' });
    const res = makeResponse();

    await runtime.handleMSTeamsWebhook(req, res);

    expect(continueConversationAsyncMock).toHaveBeenCalledWith(
      'teams-app-id',
      expect.objectContaining({
        channelId: 'msteams',
        conversation: {
          id: 'conversation-123',
          conversationType: 'personal',
        },
        serviceUrl: 'https://smba.trafficmanager.net/de/tenant-id/',
      }),
      expect.any(Function),
    );
    expect(sendChunkedReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '',
        replyStyle: 'top-level',
        replyToId: null,
      }),
    );
  });

  test('falls back to a stored Teams conversation reference when the active session is gone', async () => {
    continueConversationAsyncMock.mockImplementation(
      async (
        _appId,
        _reference,
        logic: (context: unknown) => Promise<void>,
      ) => {
        await logic({
          sendActivity: vi.fn(async () => ({ id: 'reply-2' })),
        });
      },
    );
    processMock.mockImplementation(
      async (_req, _res, logic: (context: unknown) => Promise<void>) => {
        await logic({
          activity: {
            type: 'message',
            text: 'hello',
            id: 'incoming-1',
            channelId: 'msteams',
            from: { id: 'user-id', name: 'User' },
            locale: 'de-DE',
            serviceUrl: 'https://smba.trafficmanager.net/de/tenant-id/',
            conversation: {
              id: 'conversation-123',
              conversationType: 'personal',
            },
            recipient: { id: 'bot-id' },
          },
          sendActivity: vi.fn(async () => ({ id: 'reply-1' })),
          turnState: new Map(),
        });
      },
    );
    getMemoryValueMock.mockReturnValue(makeStoredConversationReference());

    const runtime = await importRuntime();
    runtime.initMSTeams(
      vi.fn(async () => {}),
      vi.fn(async () => {}),
    );

    const req = makeRequest({ type: 'message', text: 'hello' });
    const res = makeResponse();
    await runtime.handleMSTeamsWebhook(req, res);

    expect(runtime.hasActiveMSTeamsSession('teams:dm:user')).toBe(false);

    await runtime.sendToActiveMSTeamsSession({
      sessionId: 'teams:dm:user',
      text: 'retry after restart',
    });

    expect(continueConversationAsyncMock).toHaveBeenCalledWith(
      'teams-app-id',
      expect.objectContaining({
        bot: { id: 'bot-id' },
        channelId: 'msteams',
        conversation: {
          id: 'conversation-123',
          conversationType: 'personal',
        },
        serviceUrl: 'https://smba.trafficmanager.net/de/tenant-id/',
      }),
      expect.any(Function),
    );
    expect(sendChunkedReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyStyle: 'thread',
        replyToId: 'incoming-1',
        text: 'retry after restart',
      }),
    );
  });

  test('logs when sending the Teams turn failure notice fails', async () => {
    processMock.mockResolvedValue(undefined);

    const runtime = await importRuntime();
    const req = makeRequest({ type: 'message', text: 'Hi!' });
    const res = makeResponse();

    await runtime.handleMSTeamsWebhook(req, res);

    const onTurnError = cloudAdapters[0]?.onTurnError as
      | ((
          turnContext: { sendActivity: () => Promise<void> },
          error: Error,
        ) => Promise<void>)
      | undefined;
    expect(onTurnError).toBeTypeOf('function');

    await onTurnError?.(
      {
        sendActivity: vi.fn(async () => {
          throw new Error('send failed');
        }),
      },
      new Error('turn failed'),
    );

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(Error),
      }),
      'Teams turn failed',
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(Error),
      }),
      'Failed to send Teams turn failure notice',
    );
  });
});
