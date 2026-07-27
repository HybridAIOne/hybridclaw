import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

type InboundEmailBatchHandler = (
  messages: Array<{ folder: string; raw: Buffer; uid: number }>,
) => Promise<void>;

const {
  createTransportMock,
  ensurePluginManagerInitializedMock,
  reloadPluginManagerMock,
  runAgentMock,
  sentMail,
  setPluginInboundMessageDispatcherMock,
  shutdownPluginManagerMock,
  state,
} = vi.hoisted(() => {
  const state = {
    inboundHandler: null as InboundEmailBatchHandler | null,
  };
  const sentMail: Array<Record<string, unknown>> = [];
  let sentMessageCounter = 0;

  const createTransportMock = vi.fn(() => ({
    close: vi.fn(async () => {}),
    sendMail: vi.fn(async (mail: Record<string, unknown>) => {
      sentMail.push(mail);
      sentMessageCounter += 1;
      return {
        accepted: [mail.to],
        messageId:
          typeof mail.messageId === 'string' && mail.messageId.trim()
            ? mail.messageId
            : `<sent-${sentMessageCounter}@example.com>`,
        pending: [],
        rejected: [],
      };
    }),
    verify: vi.fn(async () => {}),
  }));

  return {
    createTransportMock,
    ensurePluginManagerInitializedMock: vi.fn(async () => null),
    reloadPluginManagerMock: vi.fn(async () => null),
    runAgentMock: vi.fn(),
    sentMail,
    setPluginInboundMessageDispatcherMock: vi.fn(),
    shutdownPluginManagerMock: vi.fn(async () => {}),
    state,
  };
});

vi.mock('nodemailer', () => ({
  default: {
    createTransport: createTransportMock,
  },
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { path: 'Sent' };

    append = vi.fn(async () => ({ destination: 'Sent', uid: 1 }));
    close = vi.fn(() => {});
    connect = vi.fn(async () => {});
    getMailboxLock = vi.fn(async (path: string) => ({
      path,
      release: vi.fn(),
    }));
    list = vi.fn(async () => [
      {
        flags: new Set<string>(),
        name: 'Sent',
        path: 'Sent',
        specialUse: '\\Sent',
      },
    ]);
    logout = vi.fn(async () => {});
    search = vi.fn(async () => []);
  },
}));

vi.mock('../src/channels/email/connection.ts', () => ({
  createEmailConnectionManager: vi.fn(
    (
      _config: unknown,
      _password: string,
      onNewMessages: InboundEmailBatchHandler,
    ) => {
      state.inboundHandler = onNewMessages;
      return {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      };
    },
  ),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/plugins/plugin-manager.js', () => ({
  ensurePluginManagerInitialized: ensurePluginManagerInitializedMock,
  listLoadedPluginCommands: vi.fn(() => []),
  reloadPluginManager: reloadPluginManagerMock,
  setPluginInboundMessageDispatcher: setPluginInboundMessageDispatcherMock,
  shutdownPluginManager: shutdownPluginManagerMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-agent-email-e2e-',
  cleanup: () => {
    createTransportMock.mockClear();
    ensurePluginManagerInitializedMock.mockClear();
    reloadPluginManagerMock.mockClear();
    runAgentMock.mockReset();
    sentMail.length = 0;
    setPluginInboundMessageDispatcherMock.mockClear();
    shutdownPluginManagerMock.mockClear();
    state.inboundHandler = null;
  },
});

function buildInboundEmail(): Buffer {
  return Buffer.from(
    [
      'From: Boss <boss@example.com>',
      'To: Mail Agent <agent@example.com>',
      'Subject: Runbook request',
      'Message-ID: <boss-runbook-1@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'Please open the incident runbook and notify ops.',
      '',
    ].join('\r\n'),
  );
}

function findSentMail(to: string): Record<string, unknown> {
  const message = sentMail.find((mail) => mail.to === to);
  expect(message).toBeDefined();
  return message || {};
}

async function setupEmailAgentHome(): Promise<void> {
  setupHome();

  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  updateRuntimeConfig((draft) => {
    draft.auxiliaryModels.session_title.provider = 'disabled';
    draft.email.enabled = true;
    draft.email.address = 'agent@example.com';
    draft.email.password = 'test-password';
    draft.email.imapHost = 'imap.example.com';
    draft.email.imapPort = 993;
    draft.email.imapSecure = true;
    draft.email.smtpHost = 'smtp.example.com';
    draft.email.smtpPort = 587;
    draft.email.smtpSecure = false;
    draft.email.folders = ['INBOX'];
    draft.email.allowFrom = ['boss@example.com'];
    draft.email.pollIntervalMs = 30_000;
    draft.email.accounts = [];
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  upsertRegisteredAgent({
    displayName: 'Mail Agent',
    id: 'main',
  });
}

async function deliverInboundEmail(): Promise<void> {
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  // Use the module-level runtime, the way the gateway does
  // (src/gateway/gateway.ts). The message tool's email sends go through the
  // same default instance, so this is what shares the inbound thread context
  // with a tool-driven reply; a private createEmailRuntime() instance would
  // give the tool its own empty thread tracker and hide that.
  const { initEmail, shutdownEmail } = await import(
    '../src/channels/email/runtime.js'
  );

  try {
    await initEmail(
      async (
        sessionId,
        guildId,
        channelId,
        userId,
        username,
        content,
        media,
        reply,
        context,
      ) => {
        const result = await handleGatewayMessage({
          agentId: context.agentId,
          chatbotId: 'bot-test',
          content,
          guildId,
          channelId,
          media,
          model: 'test-model',
          sessionId,
          source: 'email',
          userId,
          username,
        });
        expect(result.status).toBe('success');
        await reply(String(result.result || ''));
      },
    );

    expect(state.inboundHandler).toBeDefined();
    await state.inboundHandler?.([
      {
        folder: 'INBOX',
        raw: buildInboundEmail(),
        uid: 42,
      },
    ]);
  } finally {
    await shutdownEmail();
  }
}

test('agent email flow sends mail, acts on inbound mail, and replies in-thread', async () => {
  await setupEmailAgentHome();

  runAgentMock.mockImplementation(
    async (params: { channelId?: string; sessionId: string }) => {
      const { runMessageToolAction } = await import(
        '../src/channels/message/tool-actions.js'
      );
      const toolArgs = {
        action: 'send' as const,
        channelId: 'ops@example.com',
        content: 'Please prepare the incident runbook for boss@example.com.',
        sessionId: params.sessionId,
        subject: 'Boss runbook request',
      };
      const toolResult = await runMessageToolAction(toolArgs);
      return {
        agentId: 'main',
        artifacts: [],
        model: 'test-model',
        provider: 'test-provider',
        result: 'I notified ops and will follow up here.',
        status: 'success',
        toolExecutions: [
          {
            arguments: JSON.stringify(toolArgs),
            durationMs: 1,
            name: 'message',
            result: JSON.stringify(toolResult),
          },
        ],
        toolsUsed: ['message'],
      };
    },
  );

  await deliverInboundEmail();

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock.mock.calls[0]?.[0]).toMatchObject({
    agentId: 'main',
    channelId: 'boss@example.com',
  });
  const agentMessages = (
    runAgentMock.mock.calls[0]?.[0] as {
      messages?: Array<{ content: string }>;
    }
  ).messages;
  expect(
    agentMessages?.some((message) =>
      message.content.includes('[Subject: Runbook request]'),
    ),
  ).toBe(true);
  expect(
    agentMessages?.some((message) =>
      message.content.includes(
        'Please open the incident runbook and notify ops.',
      ),
    ),
  ).toBe(true);

  const opsMail = findSentMail('ops@example.com');
  expect(opsMail).toMatchObject({
    from: {
      address: 'agent@example.com',
      name: 'Mail Agent',
    },
    subject: 'Boss runbook request',
    text: 'Please prepare the incident runbook for boss@example.com.',
  });

  const bossReply = findSentMail('boss@example.com');
  expect(bossReply).toMatchObject({
    from: 'agent@example.com',
    inReplyTo: '<boss-runbook-1@example.com>',
    references: '<boss-runbook-1@example.com>',
    subject: 'Re: Runbook request',
    text: 'I notified ops and will follow up here.',
  });
});

test('a send whose inReplyTo is not a message id still lands in the inbound thread', async () => {
  await setupEmailAgentHome();

  let toolResult: Record<string, unknown> | undefined;
  runAgentMock.mockImplementation(async (params: { sessionId: string }) => {
    const { runMessageToolAction } = await import(
      '../src/channels/message/tool-actions.js'
    );
    // An agent answering inbound mail through the message tool can pass an id
    // that is not the inbound Message-ID. Left alone it becomes a dangling
    // In-Reply-To, drops the Re: subject, and is then remembered as the thread
    // for everything sent afterwards.
    toolResult = await runMessageToolAction({
      action: 'send',
      channelId: 'boss@example.com',
      content: 'Received it.',
      inReplyTo: '<0f99ab14eeb8>',
      sessionId: params.sessionId,
    });
    return {
      agentId: 'main',
      artifacts: [],
      model: 'test-model',
      provider: 'test-provider',
      result: 'Received it.',
      status: 'success',
      toolExecutions: [],
      toolsUsed: ['message'],
    };
  });

  await deliverInboundEmail();

  // The send succeeds — the mail is what the agent actually wanted — and the
  // result names the id that was dropped, so the agent is not misled about
  // what went out.
  expect(toolResult).toMatchObject({
    ok: true,
    ignoredThreadIds: ['<0f99ab14eeb8>'],
  });
  expect(String(toolResult?.ignoredThreadIdsNote)).toMatch(
    /not an email message id/,
  );

  // The mail itself is threaded on the message the agent was answering, not
  // on the id it supplied.
  const bossReply = findSentMail('boss@example.com');
  expect(bossReply).toMatchObject({
    // A tool send carries the agent's display name; the threading below is
    // what matters — it comes from the tracked inbound thread, not from the
    // id the agent supplied.
    from: { address: 'agent@example.com', name: 'Mail Agent' },
    inReplyTo: '<boss-runbook-1@example.com>',
    references: '<boss-runbook-1@example.com>',
    subject: 'Re: Runbook request',
    text: 'Received it.',
  });
});
