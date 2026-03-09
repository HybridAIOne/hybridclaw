import { afterEach, describe, expect, test, vi } from 'vitest';

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function importFreshGatewayMain() {
  vi.resetModules();

  const state = {
    commandHandler: null as null | ((...args: unknown[]) => Promise<void>),
    messageHandler: null as null | ((...args: unknown[]) => Promise<void>),
    configChangeListener: null as
      | null
      | ((
          next: Record<string, unknown>,
          prev: Record<string, unknown>,
        ) => void),
    currentConfig: {
      heartbeat: { enabled: true, intervalMs: 1_000 },
      hybridai: { defaultChatbotId: 'bot-default' },
      memory: { consolidationIntervalHours: 0, decayRate: 0.25 },
      observability: { enabled: false, botId: '', agentId: '' },
      scheduler: { jobs: [] as unknown[] },
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
    resolveAgentIdForModel: vi.fn(() => 'agent-resolved'),
    rewriteUserMentionsForMessage: vi.fn(async (text: string) => text),
    setInterval: vi.fn(() => ({ timer: true })),
    startHealthServer: vi.fn(),
    startHeartbeat: vi.fn(),
    startObservabilityIngest: vi.fn(),
    startScheduler: vi.fn(),
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
  vi.doMock('../src/config/config.js', () => ({
    DISCORD_TOKEN: 'discord-token',
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
    },
  }));
  vi.doMock('../src/providers/factory.js', () => ({
    resolveAgentIdForModel: state.resolveAgentIdForModel,
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
    renderGatewayCommand: state.renderGatewayCommand,
    runGatewayScheduledTask: vi.fn(async () => {}),
  }));
  vi.doMock('../src/gateway/health.js', () => ({
    startHealthServer: state.startHealthServer,
  }));
  vi.doMock('../src/gateway/proactive-delivery.js', () => ({
    isDiscordChannelId: vi.fn(() => true),
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
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/logger.js');
  vi.doUnmock('../src/memory/db.js');
  vi.doUnmock('../src/memory/memory-service.js');
  vi.doUnmock('../src/providers/factory.js');
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
    expect(state.startHealthServer).toHaveBeenCalledTimes(1);
    expect(state.initDiscord).toHaveBeenCalledTimes(1);
    expect(state.startHeartbeat).toHaveBeenCalledWith(
      'agent-resolved',
      1_000,
      expect.any(Function),
    );
    expect(state.startObservabilityIngest).toHaveBeenCalledTimes(1);
    expect(state.startScheduler).toHaveBeenCalledTimes(1);
    expect(state.onConfigChange).toHaveBeenCalledTimes(1);
    expect(state.setInterval).toHaveBeenCalled();
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

  test('restarts dependent services when config changes affect gateway runtime', async () => {
    const state = await importFreshGatewayMain();
    const previousConfig = state.currentConfig;
    const nextConfig = {
      heartbeat: { enabled: false, intervalMs: 2_000 },
      hybridai: { defaultChatbotId: 'bot-next' },
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
