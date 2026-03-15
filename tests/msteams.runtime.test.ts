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
const parseCommandMock = vi.fn(() => ({
  args: [],
  command: '',
  isCommand: false,
}));

function makeRequest(body: unknown) {
  return Object.assign(
    Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]),
    {
      method: 'POST',
      url: '/api/msteams/messages',
      headers: {
        authorization: 'Bearer test-token',
      },
    },
  );
}

function makeResponse() {
  const headers = new Map<string, string>();
  const response = {
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
  return response;
}

async function importRuntime() {
  vi.resetModules();

  vi.doMock('botbuilder', () => ({
    CloudAdapter: class {
      onTurnError?: unknown;

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
    MSTEAMS_APP_ID: 'teams-app-id',
    MSTEAMS_APP_PASSWORD: 'teams-secret',
    MSTEAMS_ENABLED: true,
    MSTEAMS_TENANT_ID: 'teams-tenant-id',
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  }));
  vi.doMock('../src/channels/msteams/attachments.js', () => ({
    buildTeamsAttachmentContext: buildTeamsAttachmentContextMock,
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
  parseCommandMock.mockReset();
  parseCommandMock.mockReturnValue({
    args: [],
    command: '',
    isCommand: false,
  });
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('Microsoft Teams runtime webhook adapter', () => {
  test('parses the raw request body and adapts the Node response for botbuilder', async () => {
    processMock.mockResolvedValue(undefined);

    const runtime = await importRuntime();
    const req = makeRequest({ type: 'message', text: 'Hi!' });
    const res = makeResponse();

    await runtime.handleMSTeamsWebhook(req as never, res as never);

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

    await runtime.handleMSTeamsWebhook(req as never, res as never);

    expect(credentialsFactoryMock).toHaveBeenCalledWith({
      MicrosoftAppId: 'teams-app-id',
      MicrosoftAppPassword: 'teams-secret',
      MicrosoftAppTenantId: 'teams-tenant-id',
      MicrosoftAppType: 'SingleTenant',
    });
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

    await runtime.handleMSTeamsWebhook(req as never, res as never);

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

    await runtime.handleMSTeamsWebhook(req as never, res as never);

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

    await runtime.handleMSTeamsWebhook(req as never, res as never);

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

    await runtime.handleMSTeamsWebhook(req as never, res as never);

    expect(continueConversationAsyncMock).toHaveBeenCalledWith(
      'teams-app-id',
      expect.objectContaining({
        activityId: undefined,
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
});
