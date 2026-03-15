import { afterEach, describe, expect, test, vi } from 'vitest';

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function importFreshGatewayMain(options?: { whatsappLinked?: boolean }) {
  vi.resetModules();

  const state = {
    commandHandler: null as null | ((...args: unknown[]) => Promise<void>),
    messageHandler: null as null | ((...args: unknown[]) => Promise<void>),
    whatsappMessageHandler: null as
      | null
      | ((...args: unknown[]) => Promise<void>),
    configChangeListener: null as
      | null
      | ((
          next: Record<string, unknown>,
          prev: Record<string, unknown>,
        ) => void),
    currentConfig: {
      heartbeat: { enabled: true, intervalMs: 1_000 },
      hybridai: { defaultChatbotId: 'bot-default' },
      email: {
        enabled: false,
        address: '',
        imapHost: '',
        imapSecure: true,
        smtpHost: '',
        smtpSecure: false,
      },
      local: { enabled: false },
      memory: { consolidationIntervalHours: 0, decayRate: 0.25 },
      observability: { enabled: false, botId: '', agentId: '' },
      scheduler: { jobs: [] as unknown[] },
    },
    currentSession: {
      show_mode: 'all',
    },
    buildResponseText: vi.fn((text: string, toolsUsed?: string[]) =>
      toolsUsed && toolsUsed.length > 0
        ? `${text}\n*Tools: ${toolsUsed.join(', ')}*`
        : text,
    ),
    formatError: vi.fn(
      (title: string, detail: string) => `**${title}:** ${detail}`,
    ),
    formatInfo: vi.fn((title: string, body: string) => `**${title}**\n${body}`),
    getConfigSnapshot: vi.fn(),
    getGatewayStatus: vi.fn(() => ({ status: 'ok', sessions: 1 })),
    handleGatewayCommand: vi.fn(async ({ args }: { args: string[] }) => {
      if (args[0] === 'info') {
        return { kind: 'info' as const, title: 'Info', text: 'Body' };
      }
      if (args[0] === 'error') {
        return { kind: 'error' as const, title: 'Oops', text: 'Failed' };
      }
      return { kind: 'plain' as const, text: 'plain output' };
    }),
    handleGatewayMessage: vi.fn(async () => ({
      status: 'success' as const,
      result: 'Hello from gateway',
      toolsUsed: ['search'],
      artifacts: [],
    })),
    initDatabase: vi.fn(),
    initDiscord: vi.fn(),
    initWhatsApp: vi.fn(),
    initGatewayService: vi.fn(),
    listQueuedProactiveMessages: vi.fn(() => []),
    memoryServiceConsolidate: vi.fn(() => ({
      memoriesDecayed: 0,
      durationMs: 1,
    })),
    onConfigChange: vi.fn(),
    processOn: vi.spyOn(process, 'on'),
    rearmScheduler: vi.fn(),
    renderGatewayCommand: vi.fn(
      (result: { text: string }) => `rendered:${result.text}`,
    ),
    resumeEnabledFullAutoSessions: vi.fn(() => 0),
    resolveAgentForRequest: vi.fn(() => ({
      agentId: 'agent-resolved',
      model: 'gpt-5-nano',
      chatbotId: 'bot-1',
    })),
    rewriteUserMentionsForMessage: vi.fn(async (text: string) => text),
    setInterval: vi.fn(() => ({ timer: true })),
    startHealthServer: vi.fn(),
    startHeartbeat: vi.fn(),
    startDiscoveryLoop: vi.fn(),
    startHealthCheckLoop: vi.fn(),
    startObservabilityIngest: vi.fn(),
    startScheduler: vi.fn(),
    whatsappLinked: options?.whatsappLinked === true,
  };

  state.getConfigSnapshot.mockImplementation(() => state.currentConfig);
  state.onConfigChange.mockImplementation(
    (
      listener: (
        next: Record<string, unknown>,
        prev: Record<string, unknown>,
      ) => void,
    ) => {
      state.configChangeListener = listener;
      return vi.fn();
    },
  );
  state.initDiscord.mockImplementation((messageHandler, commandHandler) => {
    state.messageHandler = messageHandler;
    state.commandHandler = commandHandler;
  });
  state.initWhatsApp.mockImplementation((messageHandler) => {
    state.whatsappMessageHandler = messageHandler;
  });
  state.startScheduler.mockImplementation((listener) => {
    void listener;
  });
  state.processOn.mockImplementation((() => process) as never);
  vi.stubGlobal('setInterval', state.setInterval as never);
  vi.stubGlobal('clearInterval', vi.fn());

  vi.doMock('../src/agent/executor.js', () => ({
    stopAllExecutions: vi.fn(),
  }));
  vi.doMock('../src/agent/proactive-policy.js', () => ({
    isWithinActiveHours: vi.fn(() => true),
    proactiveWindowLabel: vi.fn(() => 'always-on'),
  }));
  vi.doMock('../src/agent/silent-reply.js', () => ({
    isSilentReply: vi.fn(() => false),
    stripSilentToken: vi.fn((value: string) => value),
  }));
  vi.doMock('../src/agent/silent-reply-stream.js', () => ({
    createSilentReplyStreamFilter: vi.fn(() => ({
      flush: () => '',
      isSilent: () => false,
      push: (value: string) => value,
    })),
  }));
  vi.doMock('../src/audit/observability-ingest.js', () => ({
    startObservabilityIngest: state.startObservabilityIngest,
    stopObservabilityIngest: vi.fn(),
  }));
  vi.doMock('../src/channels/discord/delivery.js', () => ({
    buildResponseText: state.buildResponseText,
    formatError: state.formatError,
    formatInfo: state.formatInfo,
  }));
  vi.doMock('../src/channels/discord/mentions.js', () => ({
    rewriteUserMentionsForMessage: state.rewriteUserMentionsForMessage,
  }));
  vi.doMock('../src/channels/discord/runtime.js', () => ({
    initDiscord: state.initDiscord,
    sendToChannel: vi.fn(),
    setDiscordMaintenancePresence: vi.fn(async () => {}),
  }));
  vi.doMock('../src/channels/email/runtime.js', () => ({
    initEmail: vi.fn(async () => {}),
    sendEmailAttachmentTo: vi.fn(async () => {}),
    sendToEmail: vi.fn(async () => {}),
    shutdownEmail: vi.fn(async () => {}),
  }));
  vi.doMock('../src/channels/whatsapp/runtime.js', () => ({
    initWhatsApp: state.initWhatsApp,
    sendToWhatsAppChat: vi.fn(async () => {}),
    sendWhatsAppMediaToChat: vi.fn(async () => {}),
    shutdownWhatsApp: vi.fn(async () => {}),
  }));
  vi.doMock('../src/channels/whatsapp/auth.js', () => ({
    getWhatsAppAuthStatus: vi.fn(async () => ({
      linked: state.whatsappLinked,
      jid: state.whatsappLinked ? '491701234567:16@s.whatsapp.net' : null,
    })),
  }));
  vi.doMock('../src/config/config.js', () => ({
    DISCORD_TOKEN: 'discord-token',
    EMAIL_PASSWORD: '',
    getConfigSnapshot: state.getConfigSnapshot,
    HEARTBEAT_CHANNEL: '',
    HEARTBEAT_INTERVAL: 1_000,
    HYBRIDAI_CHATBOT_ID: 'bot-1',
    HYBRIDAI_MODEL: 'gpt-5-nano',
    onConfigChange: state.onConfigChange,
    PROACTIVE_QUEUE_OUTSIDE_HOURS: false,
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  }));
  vi.doMock('../src/memory/db.js', () => ({
    deleteQueuedProactiveMessage: vi.fn(),
    enqueueProactiveMessage: vi.fn(() => ({ dropped: 0, queued: 1 })),
    getMostRecentSessionChannelId: vi.fn(() => 'discord:123'),
    getQueuedProactiveMessageCount: vi.fn(() => 0),
    initDatabase: state.initDatabase,
    listQueuedProactiveMessages: state.listQueuedProactiveMessages,
  }));
  vi.doMock('../src/memory/memory-service.js', () => ({
    memoryService: {
      consolidateMemories: state.memoryServiceConsolidate,
      getSessionById: vi.fn(() => state.currentSession),
    },
  }));
  vi.doMock('../src/agents/agent-registry.js', () => ({
    resolveAgentForRequest: state.resolveAgentForRequest,
  }));
  vi.doMock('../src/providers/local-discovery.js', () => ({
    startDiscoveryLoop: state.startDiscoveryLoop,
    stopDiscoveryLoop: vi.fn(),
  }));
  vi.doMock('../src/providers/local-health.js', () => ({
    startHealthCheckLoop: state.startHealthCheckLoop,
    stopHealthCheckLoop: vi.fn(),
  }));
  vi.doMock('../src/scheduler/heartbeat.js', () => ({
    startHeartbeat: state.startHeartbeat,
    stopHeartbeat: vi.fn(),
  }));
  vi.doMock('../src/scheduler/scheduler.js', () => ({
    rearmScheduler: state.rearmScheduler,
    startScheduler: state.startScheduler,
    stopScheduler: vi.fn(),
  }));
  vi.doMock('../src/gateway/gateway-service.js', () => ({
    getGatewayStatus: state.getGatewayStatus,
    handleGatewayCommand: state.handleGatewayCommand,
    handleGatewayMessage: state.handleGatewayMessage,
    initGatewayService: state.initGatewayService,
    renderGatewayCommand: state.renderGatewayCommand,
    resumeEnabledFullAutoSessions: state.resumeEnabledFullAutoSessions,
    runGatewayScheduledTask: vi.fn(async () => {}),
  }));
  vi.doMock('../src/gateway/health.js', () => ({
    startHealthServer: state.startHealthServer,
  }));
  vi.doMock('../src/gateway/proactive-delivery.js', () => ({
    hasQueuedProactiveDeliveryPath: vi.fn(() => true),
    isDiscordChannelId: vi.fn(() => true),
    isEmailAddress: vi.fn(() => false),
    isSupportedProactiveChannelId: vi.fn(() => true),
    resolveHeartbeatDeliveryChannelId: vi.fn(() => '123456789012345678'),
    shouldDropQueuedProactiveMessage: vi.fn(() => false),
  }));

  await import('../src/gateway/gateway.ts');
  await settle();

  if (
    !state.commandHandler ||
    !state.messageHandler ||
    !state.configChangeListener
  ) {
    throw new Error('Gateway bootstrap did not capture handlers.');
  }

  return state;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/agent/executor.js');
  vi.doUnmock('../src/agent/proactive-policy.js');
  vi.doUnmock('../src/agent/silent-reply.js');
  vi.doUnmock('../src/agent/silent-reply-stream.js');
  vi.doUnmock('../src/audit/observability-ingest.js');
  vi.doUnmock('../src/channels/discord/delivery.js');
  vi.doUnmock('../src/channels/discord/mentions.js');
  vi.doUnmock('../src/channels/discord/runtime.js');
  vi.doUnmock('../src/channels/email/runtime.js');
  vi.doUnmock('../src/channels/whatsapp/runtime.js');
  vi.doUnmock('../src/channels/whatsapp/auth.js');
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/logger.js');
  vi.doUnmock('../src/memory/db.js');
  vi.doUnmock('../src/memory/memory-service.js');
  vi.doUnmock('../src/agents/agent-registry.js');
  vi.doUnmock('../src/providers/local-discovery.js');
  vi.doUnmock('../src/providers/local-health.js');
  vi.doUnmock('../src/scheduler/heartbeat.js');
  vi.doUnmock('../src/scheduler/scheduler.js');
  vi.doUnmock('../src/gateway/gateway-service.js');
  vi.doUnmock('../src/gateway/health.js');
  vi.doUnmock('../src/gateway/proactive-delivery.js');
  vi.resetModules();
});

describe('gateway bootstrap', () => {
  test('starts the gateway subsystems on import', async () => {
    const state = await importFreshGatewayMain();

    expect(state.initDatabase).toHaveBeenCalledTimes(1);
    expect(state.initGatewayService).toHaveBeenCalledTimes(1);
    expect(state.resumeEnabledFullAutoSessions).toHaveBeenCalledTimes(1);
    expect(state.startHealthServer).toHaveBeenCalledTimes(1);
    expect(state.initDiscord).toHaveBeenCalledTimes(1);
    expect(state.startHeartbeat).toHaveBeenCalledWith(
      'agent-resolved',
      1_000,
      expect.any(Function),
    );
    expect(state.startDiscoveryLoop).toHaveBeenCalledTimes(1);
    expect(state.startHealthCheckLoop).toHaveBeenCalledTimes(1);
    expect(state.startObservabilityIngest).toHaveBeenCalledTimes(1);
    expect(state.startScheduler).toHaveBeenCalledTimes(1);
    expect(state.onConfigChange).toHaveBeenCalledTimes(1);
    expect(state.setInterval).toHaveBeenCalled();
  });

  test('starts WhatsApp integration automatically when linked auth exists', async () => {
    const state = await importFreshGatewayMain({ whatsappLinked: true });

    expect(state.initWhatsApp).toHaveBeenCalledTimes(1);
    expect(state.whatsappMessageHandler).not.toBeNull();
  });

  test('formats command replies based on gateway command result kind', async () => {
    const state = await importFreshGatewayMain();
    const reply = vi.fn(async () => {});

    await state.commandHandler?.(
      'session',
      null,
      'channel',
      'user',
      'alice',
      ['info'],
      reply,
    );
    await state.commandHandler?.(
      'session',
      null,
      'channel',
      'user',
      'alice',
      ['error'],
      reply,
    );
    await state.commandHandler?.(
      'session',
      null,
      'channel',
      'user',
      'alice',
      ['plain'],
      reply,
    );

    expect(reply).toHaveBeenNthCalledWith(1, '**Info**\nBody');
    expect(reply).toHaveBeenNthCalledWith(2, '**Oops:** Failed');
    expect(reply).toHaveBeenNthCalledWith(3, 'rendered:plain output');
  });

  test('finalizes Discord message responses using rendered gateway output', async () => {
    const state = await importFreshGatewayMain();
    const stream = {
      append: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      finalize: vi.fn(async () => {}),
    };
    const context = {
      abortSignal: new AbortController().signal,
      batchedMessages: [],
      emitLifecyclePhase: vi.fn(),
      mentionLookup: { byAlias: new Map() },
      sourceMessage: {},
      stream,
    };

    await state.messageHandler?.(
      'session',
      null,
      'channel',
      'user',
      'alice',
      'hello',
      [],
      vi.fn(async () => {}),
      context,
    );

    expect(state.rewriteUserMentionsForMessage).toHaveBeenCalledWith(
      'Hello from gateway',
      context.sourceMessage,
      context.mentionLookup,
    );
    expect(stream.finalize).toHaveBeenCalledWith(
      'Hello from gateway\n*Tools: search*',
      [],
    );
    expect(stream.fail).not.toHaveBeenCalled();
  });

  test('stores rendered fallback text for Discord pending approvals', async () => {
    const state = await importFreshGatewayMain();
    state.rewriteUserMentionsForMessage.mockResolvedValue('Hello <@123>');
    state.handleGatewayMessage.mockResolvedValue({
      status: 'success',
      result: 'Hello @alice',
      toolsUsed: ['search'],
      artifacts: [],
      pendingApproval: {
        approvalId: 'approve123',
        prompt: '',
        intent: 'control a local app',
        reason: 'this command controls host GUI or application state',
        allowSession: true,
        allowAgent: false,
        expiresAt: 1_710_000_000_000,
      },
    });
    const stream = {
      append: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      finalize: vi.fn(async () => {}),
    };
    const context = {
      abortSignal: new AbortController().signal,
      batchedMessages: [],
      emitLifecyclePhase: vi.fn(),
      mentionLookup: { byAlias: new Map() },
      sendApprovalNotification: vi.fn(async () => ({
        disableButtons: vi.fn(async () => {}),
      })),
      sourceMessage: {},
      stream,
    };

    await state.messageHandler?.(
      'session',
      null,
      'channel',
      'user',
      'alice',
      'hello',
      [],
      vi.fn(async () => {}),
      context,
    );

    const reply = vi.fn(async () => {});
    await state.commandHandler?.(
      'session',
      null,
      'channel',
      'user',
      'alice',
      ['approve', 'view'],
      reply,
    );

    expect(reply).toHaveBeenCalledWith(
      '**Pending Approval**\nHello <@123>\n*Tools: search*',
      undefined,
      expect.any(Array),
    );
  });

  test('routes WhatsApp slash commands through the gateway command handler', async () => {
    const state = await importFreshGatewayMain({ whatsappLinked: true });
    const reply = vi.fn(async () => {});

    await state.whatsappMessageHandler?.(
      'wa:491701234567@s.whatsapp.net',
      null,
      '491701234567@s.whatsapp.net',
      '+491701234567',
      'alice',
      '/help',
      [],
      reply,
      {
        abortSignal: new AbortController().signal,
        batchedMessages: [],
        chatJid: '491701234567@s.whatsapp.net',
        isGroup: false,
        rawMessage: {},
        senderJid: '491701234567@s.whatsapp.net',
      },
    );

    expect(state.handleGatewayCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['help'],
        channelId: '491701234567@s.whatsapp.net',
        sessionId: 'wa:491701234567@s.whatsapp.net',
      }),
    );
    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith('rendered:plain output');
  });

  test('treats bare WhatsApp /model as model info', async () => {
    const state = await importFreshGatewayMain({ whatsappLinked: true });

    await state.whatsappMessageHandler?.(
      'wa:491701234567@s.whatsapp.net',
      null,
      '491701234567@s.whatsapp.net',
      '+491701234567',
      'alice',
      '/model',
      [],
      vi.fn(async () => {}),
      {
        abortSignal: new AbortController().signal,
        batchedMessages: [],
        chatJid: '491701234567@s.whatsapp.net',
        isGroup: false,
        rawMessage: {},
        senderJid: '491701234567@s.whatsapp.net',
      },
    );

    expect(state.handleGatewayCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['model', 'info'],
      }),
    );
    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
  });

  test('expands WhatsApp /info into the standard info command set', async () => {
    const state = await importFreshGatewayMain({ whatsappLinked: true });

    await state.whatsappMessageHandler?.(
      'wa:491701234567@s.whatsapp.net',
      null,
      '491701234567@s.whatsapp.net',
      '+491701234567',
      'alice',
      '/info',
      [],
      vi.fn(async () => {}),
      {
        abortSignal: new AbortController().signal,
        batchedMessages: [],
        chatJid: '491701234567@s.whatsapp.net',
        isGroup: false,
        rawMessage: {},
        senderJid: '491701234567@s.whatsapp.net',
      },
    );

    expect(state.handleGatewayCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        args: ['bot', 'info'],
      }),
    );
    expect(state.handleGatewayCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        args: ['model', 'info'],
      }),
    );
    expect(state.handleGatewayCommand).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        args: ['status'],
      }),
    );
    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
  });

  test('uses the analyzed vision text when the model only returns Done in WhatsApp', async () => {
    const state = await importFreshGatewayMain({ whatsappLinked: true });
    state.handleGatewayMessage.mockResolvedValue({
      status: 'success',
      result: 'Done.',
      toolsUsed: ['vision_analyze'],
      toolExecutions: [
        {
          name: 'vision_analyze',
          arguments: '{"file_path":"/tmp/image.jpg"}',
          result: JSON.stringify({
            success: true,
            analysis: 'A basil plant on a windowsill.',
          }),
          durationMs: 43800,
        },
      ],
      artifacts: [],
    });
    const reply = vi.fn(async () => {});

    await state.whatsappMessageHandler?.(
      'wa:491701234567@s.whatsapp.net',
      null,
      '491701234567@s.whatsapp.net',
      '+491701234567',
      'alice',
      'what is in this image?',
      [],
      reply,
      {
        abortSignal: new AbortController().signal,
        batchedMessages: [],
        chatJid: '491701234567@s.whatsapp.net',
        isGroup: false,
        rawMessage: {},
        senderJid: '491701234567@s.whatsapp.net',
      },
    );

    expect(reply).toHaveBeenCalledWith(
      'A basil plant on a windowsill.\n*Tools: vision_analyze*',
    );
  });

  test('replies with a retry prompt when a WhatsApp turn times out before a reply', async () => {
    const state = await importFreshGatewayMain({ whatsappLinked: true });
    state.handleGatewayMessage.mockResolvedValue({
      status: 'error',
      result: null,
      toolsUsed: [],
      artifacts: [],
      error: 'Timeout waiting for agent output after 300000ms',
    });
    const reply = vi.fn(async () => {});

    await state.whatsappMessageHandler?.(
      'wa:491701234567@s.whatsapp.net',
      null,
      '491701234567@s.whatsapp.net',
      '+491701234567',
      'alice',
      'Von wem ist das?',
      [],
      reply,
      {
        abortSignal: new AbortController().signal,
        batchedMessages: [],
        chatJid: '491701234567@s.whatsapp.net',
        isGroup: false,
        rawMessage: {},
        senderJid: '491701234567@s.whatsapp.net',
      },
    );

    expect(reply).toHaveBeenCalledWith(
      'The request was interrupted before I could reply. Please send it again.',
    );
  });

  test('omits the Discord tool footer when the session show mode hides tools', async () => {
    const state = await importFreshGatewayMain();
    state.currentSession.show_mode = 'thinking';
    const stream = {
      append: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      finalize: vi.fn(async () => {}),
    };
    const context = {
      abortSignal: new AbortController().signal,
      batchedMessages: [],
      emitLifecyclePhase: vi.fn(),
      mentionLookup: { byAlias: new Map() },
      sourceMessage: {},
      stream,
    };

    await state.messageHandler?.(
      'session',
      null,
      'channel',
      'user',
      'alice',
      'hello',
      [],
      vi.fn(async () => {}),
      context,
    );

    expect(stream.finalize).toHaveBeenCalledWith('Hello from gateway', []);
  });

  test('restarts dependent services when config changes affect gateway runtime', async () => {
    const state = await importFreshGatewayMain();
    const previousConfig = state.currentConfig;
    const nextConfig = {
      heartbeat: { enabled: false, intervalMs: 2_000 },
      hybridai: { defaultChatbotId: 'bot-next' },
      email: {
        enabled: false,
        address: '',
        imapHost: '',
        imapSecure: true,
        smtpHost: '',
        smtpSecure: false,
      },
      local: { enabled: true },
      memory: { consolidationIntervalHours: 2, decayRate: 0.5 },
      observability: { enabled: true, botId: 'bot-obs', agentId: 'agent-obs' },
      scheduler: { jobs: [{ id: 'job-1' }] },
    };

    state.currentConfig = nextConfig;
    state.configChangeListener?.(nextConfig, previousConfig);

    expect(state.startHeartbeat).toHaveBeenCalledTimes(2);
    expect(state.rearmScheduler).toHaveBeenCalledTimes(1);
    expect(state.startObservabilityIngest).toHaveBeenCalledTimes(2);
    expect(state.setInterval.mock.calls.length).toBeGreaterThan(1);
  });
});
