import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function expectInfoLog(
  state: ReturnType<typeof createGatewayMainTestState>,
  message: string,
  payload: unknown,
): void {
  expect(state.loggerInfo).toHaveBeenCalledWith(payload, message);
}

function createGatewayMainTestState(options?: {
  discordInitError?: Error;
  emailEnabled?: boolean;
  emailPassword?: string;
  imessageInitError?: Error;
  imessageEnabled?: boolean;
  whatsappEnabled?: boolean;
  whatsappLinked?: boolean;
  msteamsEnabled?: boolean;
  hasMSTeamsCredentials?: boolean;
  initGatewayServiceImpl?: () => Promise<void>;
}) {
  return {
    commandHandler: null as null | ((...args: unknown[]) => Promise<void>),
    messageHandler: null as null | ((...args: unknown[]) => Promise<void>),
    teamsCommandHandler: null as null | ((...args: unknown[]) => Promise<void>),
    teamsMessageHandler: null as null | ((...args: unknown[]) => Promise<void>),
    imessageMessageHandler: null as
      | null
      | ((...args: unknown[]) => Promise<void>),
    whatsappMessageHandler: null as
      | null
      | ((...args: unknown[]) => Promise<void>),
    configChangeListener: null as
      | null
      | ((
          next: Record<string, unknown>,
          prev: Record<string, unknown>,
        ) => void),
    scheduledTaskRunner: null as null | ((...args: unknown[]) => Promise<void>),
    currentConfig: {
      heartbeat: { enabled: true, intervalMs: 1_000 },
      hybridai: { defaultChatbotId: 'bot-default' },
      email: {
        enabled: options?.emailEnabled ?? false,
        address: options?.emailEnabled ? 'bot@example.com' : '',
        imapHost: options?.emailEnabled ? 'imap.example.com' : '',
        imapSecure: true,
        smtpHost: options?.emailEnabled ? 'smtp.example.com' : '',
        smtpSecure: false,
      },
      msteams: {
        enabled: options?.msteamsEnabled ?? true,
        webhook: {
          port: 9090,
          path: '/api/msteams/messages',
        },
      },
      imessage: {
        enabled: options?.imessageEnabled ?? false,
        backend: 'bluebubbles',
        webhookPath: '/api/imessage/webhook',
      },
      whatsapp: {
        dmPolicy: options?.whatsappEnabled === false ? 'disabled' : 'pairing',
        groupPolicy: 'disabled',
      },
      local: { enabled: false },
      memory: {
        consolidationIntervalHours: 0,
        decayRate: 0.25,
        consolidationLanguage: 'en',
      },
      observability: { enabled: false, botId: '', agentId: '' },
      ops: { healthPort: 9090 },
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
    buildTeamsArtifactAttachments: vi.fn(async () => []),
    formatError: vi.fn(
      (title: string, detail: string) => `**${title}:** ${detail}`,
    ),
    formatInfo: vi.fn((title: string, body: string) => `**${title}**\n${body}`),
    currentMostRecentSessionChannelId: 'discord:123' as string | null,
    getConfigSnapshot: vi.fn(),
    getGatewayStatus: vi.fn(() => ({
      status: 'ok',
      sessions: 1,
      providerHealth: {},
      localBackends: {},
    })),
    getWorkflowByCompanionTaskId: vi.fn(() => null),
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
    initEmail: vi.fn(),
    initIMessage: vi.fn(),
    initMSTeams: vi.fn(),
    initWhatsApp: vi.fn(),
    initializeWorkflowRuntime: vi.fn(),
    initGatewayService: vi.fn(
      options?.initGatewayServiceImpl || (async () => {}),
    ),
    listAgents: vi.fn(() => []),
    stopGatewayPlugins: vi.fn(async () => {}),
    listQueuedProactiveMessages: vi.fn(() => []),
    loggerDebug: vi.fn(),
    loggerError: vi.fn(),
    loggerFatal: vi.fn(),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    shutdownEmail: vi.fn(async () => {}),
    memoryServiceConsolidate: vi.fn(() => ({
      memoriesDecayed: 0,
      dailyFilesCompiled: 0,
      workspacesUpdated: 0,
      modelCleanups: 0,
      fallbacksUsed: 0,
      durationMs: 1,
    })),
    memoryServiceConsolidateWithCleanup: vi.fn(async () => ({
      memoriesDecayed: 0,
      dailyFilesCompiled: 0,
      workspacesUpdated: 0,
      modelCleanups: 0,
      fallbacksUsed: 0,
      durationMs: 1,
    })),
    memoryServiceSetDecayRate: vi.fn(),
    memoryServiceSetLanguage: vi.fn(),
    onConfigChange: vi.fn(),
    processOn: vi.spyOn(process, 'on'),
    rearmScheduler: vi.fn(),
    renderGatewayCommand: vi.fn(
      (result: { text: string }) => `rendered:${result.text}`,
    ),
    resumeEnabledFullAutoSessions: vi.fn(() => 0),
    runGatewayScheduledTask: vi.fn(async () => {}),
    resolveAgentForRequest: vi.fn(() => ({
      agentId: 'agent-resolved',
      model: 'gpt-5-nano',
      chatbotId: 'bot-1',
    })),
    resolveAgentWorkspaceId: vi.fn((agentId: string) => agentId),
    rewriteUserMentionsForMessage: vi.fn(async (text: string) => text),
    runManagedMediaCleanup: vi.fn(async () => {}),
    executeWorkflow: vi.fn(async () => {}),
    setInterval: vi.fn(() => ({ timer: true })),
    setTimeout: vi.fn(() => ({ timer: true })),
    startGatewayHttpServer: vi.fn(() => ({
      broadcastShutdown: vi.fn(),
      setReady: vi.fn(),
    })),
    startHeartbeat: vi.fn(),
    startDiscoveryLoop: vi.fn(),
    hybridAIProbeGet: vi.fn(async () => ({})),
    localBackendsProbeGet: vi.fn(async () => new Map()),
    startObservabilityIngest: vi.fn(),
    startScheduler: vi.fn(),
    whatsappLinked: options?.whatsappLinked === true,
  };
}

async function importFreshGatewayMain(options?: {
  discordInitError?: Error;
  imessageInitError?: Error;
  imessageEnabled?: boolean;
  whatsappEnabled?: boolean;
  whatsappInitError?: Error;
  whatsappAuthLockError?: {
    lockPath: string;
    ownerPid?: number | null;
    message?: string;
  };
  whatsappLinked?: boolean;
  msteamsEnabled?: boolean;
  hasMSTeamsCredentials?: boolean;
  initGatewayServiceImpl?: () => Promise<void>;
  skipBootstrapHandlerCheck?: boolean;
  dataDir?: string;
  onState?: (state: ReturnType<typeof createGatewayMainTestState>) => void;
}) {
  vi.resetModules();

  const state = createGatewayMainTestState(options);
  options?.onState?.(state);

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
  state.initDiscord.mockImplementation(
    async (messageHandler, commandHandler) => {
      state.messageHandler = messageHandler;
      state.commandHandler = commandHandler;
      if (options?.discordInitError) {
        throw options.discordInitError;
      }
    },
  );
  state.initMSTeams.mockImplementation((messageHandler, commandHandler) => {
    state.teamsMessageHandler = messageHandler;
    state.teamsCommandHandler = commandHandler;
  });
  state.initIMessage.mockImplementation((messageHandler) => {
    if (options?.imessageInitError) {
      throw options.imessageInitError;
    }
    state.imessageMessageHandler = messageHandler;
  });
  class MockWhatsAppAuthLockError extends Error {
    readonly lockPath: string;
    readonly ownerPid: number | null;

    constructor(
      message: string,
      options: { lockPath: string; ownerPid?: number | null },
    ) {
      super(message);
      this.name = 'WhatsAppAuthLockError';
      this.lockPath = options.lockPath;
      this.ownerPid = options.ownerPid ?? null;
    }
  }
  state.initWhatsApp.mockImplementation((messageHandler) => {
    if (options?.whatsappAuthLockError) {
      throw new MockWhatsAppAuthLockError(
        options.whatsappAuthLockError.message ||
          'WhatsApp auth state is already in use',
        {
          lockPath: options.whatsappAuthLockError.lockPath,
          ownerPid: options.whatsappAuthLockError.ownerPid ?? null,
        },
      );
    }
    if (options?.whatsappInitError) {
      throw options.whatsappInitError;
    }
    state.whatsappMessageHandler = messageHandler;
  });
  state.startScheduler.mockImplementation((listener) => {
    state.scheduledTaskRunner = listener;
  });
  state.processOn.mockImplementation((() => process) as never);
  vi.stubGlobal('setInterval', state.setInterval as never);
  vi.stubGlobal('clearInterval', vi.fn());
  vi.stubGlobal('setTimeout', state.setTimeout as never);
  vi.stubGlobal('clearTimeout', vi.fn());

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
  vi.doMock('../src/channels/msteams/attachments.js', () => ({
    buildTeamsArtifactAttachments: state.buildTeamsArtifactAttachments,
  }));
  vi.doMock('../src/channels/imessage/runtime.js', () => ({
    initIMessage: state.initIMessage,
    sendIMessageMediaToChat: vi.fn(async () => {}),
    sendToIMessageChat: vi.fn(async () => {}),
    shutdownIMessage: vi.fn(async () => {}),
  }));
  vi.doMock('../src/channels/msteams/runtime.js', () => ({
    initMSTeams: state.initMSTeams,
  }));
  vi.doMock('../src/channels/email/runtime.js', () => ({
    initEmail: state.initEmail,
    sendEmailAttachmentTo: vi.fn(async () => {}),
    sendToEmail: vi.fn(async () => {}),
    shutdownEmail: state.shutdownEmail,
  }));
  vi.doMock('../src/channels/whatsapp/runtime.js', () => ({
    initWhatsApp: state.initWhatsApp,
    sendToWhatsAppChat: vi.fn(async () => {}),
    sendWhatsAppMediaToChat: vi.fn(async () => {}),
    shutdownWhatsApp: vi.fn(async () => {}),
  }));
  vi.doMock('../src/channels/whatsapp/auth.js', () => ({
    WhatsAppAuthLockError: MockWhatsAppAuthLockError,
    getWhatsAppAuthStatus: vi.fn(async () => ({
      linked: state.whatsappLinked,
      jid: state.whatsappLinked ? '491701234567:16@s.whatsapp.net' : null,
    })),
  }));
  vi.doMock('../src/config/config.js', () => ({
    DATA_DIR: options?.dataDir ?? '/tmp/hybridclaw-data',
    DISCORD_TOKEN: 'discord-token',
    EMAIL_PASSWORD: options?.emailPassword ?? '',
    MSTEAMS_APP_ID:
      options?.hasMSTeamsCredentials === false ? '' : 'teams-app-id',
    MSTEAMS_APP_PASSWORD:
      options?.hasMSTeamsCredentials === false ? '' : 'teams-app-password',
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
      debug: state.loggerDebug,
      error: state.loggerError,
      fatal: state.loggerFatal,
      info: state.loggerInfo,
      warn: state.loggerWarn,
    },
  }));
  vi.doMock('../src/memory/db.js', () => ({
    deleteQueuedProactiveMessage: vi.fn(),
    enqueueProactiveMessage: vi.fn(() => ({ dropped: 0, queued: 1 })),
    getMostRecentSessionChannelId: vi.fn(
      () => state.currentMostRecentSessionChannelId,
    ),
    getQueuedProactiveMessageCount: vi.fn(() => 0),
    getWorkflowByCompanionTaskId: state.getWorkflowByCompanionTaskId,
    initDatabase: state.initDatabase,
    listQueuedProactiveMessages: state.listQueuedProactiveMessages,
  }));
  vi.doMock('../src/memory/memory-service.js', () => ({
    memoryService: {
      consolidateMemories: state.memoryServiceConsolidate,
      consolidateMemoriesWithCleanup: state.memoryServiceConsolidateWithCleanup,
      getSessionById: vi.fn(() => state.currentSession),
      setConsolidationDecayRate: state.memoryServiceSetDecayRate,
      setConsolidationLanguage: state.memoryServiceSetLanguage,
    },
  }));
  vi.doMock('../src/agents/agent-registry.js', () => ({
    listAgents: state.listAgents,
    resolveAgentForRequest: state.resolveAgentForRequest,
    resolveAgentWorkspaceId: state.resolveAgentWorkspaceId,
  }));
  vi.doMock('../src/providers/local-discovery.js', () => ({
    startDiscoveryLoop: state.startDiscoveryLoop,
    stopDiscoveryLoop: vi.fn(),
  }));
  vi.doMock('../src/providers/local-health.js', () => ({
    localBackendsProbe: {
      get: state.localBackendsProbeGet,
      peek: vi.fn(() => new Map()),
      invalidate: vi.fn(),
    },
  }));
  vi.doMock('../src/providers/hybridai-health.js', () => ({
    hybridAIProbe: {
      get: state.hybridAIProbeGet,
      peek: vi.fn(() => null),
      invalidate: vi.fn(),
    },
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
    renderGatewayCommand: state.renderGatewayCommand,
    resumeEnabledFullAutoSessions: state.resumeEnabledFullAutoSessions,
  }));
  vi.doMock('../src/gateway/gateway-chat-service.js', () => ({
    handleGatewayMessage: state.handleGatewayMessage,
  }));
  vi.doMock('../src/gateway/gateway-scheduled-task-service.js', () => ({
    runGatewayScheduledTask: state.runGatewayScheduledTask,
  }));
  vi.doMock('../src/gateway/gateway-plugin-service.js', () => ({
    initGatewayService: state.initGatewayService,
    stopGatewayPlugins: state.stopGatewayPlugins,
  }));
  vi.doMock('../src/gateway/gateway-http-server.js', () => ({
    startGatewayHttpServer: state.startGatewayHttpServer,
  }));
  vi.doMock('../src/gateway/proactive-delivery.js', () => ({
    deliverProactiveMessage: vi.fn(async () => {}),
    deliverWebhookMessage: vi.fn(async () => {}),
    hasQueuedProactiveDeliveryPath: vi.fn(() => true),
    isDiscordChannelId: vi.fn(() => true),
    isEmailAddress: vi.fn(() => false),
    isSupportedProactiveChannelId: vi.fn(() => true),
    resolveHeartbeatDeliveryChannelId: vi.fn(() => '123456789012345678'),
    resolveLastUsedDeliverableChannelId: vi.fn(() => '123456789012345678'),
    shouldDropQueuedProactiveMessage: vi.fn(() => false),
  }));
  vi.doMock('../src/gateway/managed-media-cleanup.js', () => ({
    runManagedMediaCleanup: state.runManagedMediaCleanup,
  }));
  vi.doMock('../src/workflow/executor.js', () => ({
    executeWorkflow: state.executeWorkflow,
  }));
  vi.doMock('../src/workflow/service.js', () => ({
    initializeWorkflowRuntime: state.initializeWorkflowRuntime,
  }));

  await import('../src/gateway/gateway.ts');
  await settle();

  if (
    !options?.skipBootstrapHandlerCheck &&
    (!state.commandHandler ||
      !state.messageHandler ||
      !state.configChangeListener)
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
  vi.doUnmock('../src/channels/imessage/runtime.js');
  vi.doUnmock('../src/channels/msteams/attachments.js');
  vi.doUnmock('../src/channels/msteams/runtime.js');
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
  vi.doUnmock('../src/gateway/gateway-chat-service.js');
  vi.doUnmock('../src/gateway/gateway-scheduled-task-service.js');
  vi.doUnmock('../src/gateway/gateway-http-server.js');
  vi.doUnmock('../src/gateway/proactive-delivery.js');
  vi.doUnmock('../src/gateway/managed-media-cleanup.js');
  vi.doUnmock('../src/workflow/executor.js');
  vi.doUnmock('../src/workflow/service.js');
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('gateway bootstrap', () => {
  test('starts the gateway subsystems on import', async () => {
    const state = await importFreshGatewayMain();

    expect(state.initDatabase).toHaveBeenCalledTimes(1);
    expect(state.initGatewayService).toHaveBeenCalledTimes(1);
    expect(state.resumeEnabledFullAutoSessions).toHaveBeenCalledTimes(1);
    expect(state.startGatewayHttpServer).toHaveBeenCalledTimes(1);
    expect(state.initDiscord).toHaveBeenCalledTimes(1);
    expect(state.initMSTeams).toHaveBeenCalledTimes(1);
    expect(state.startHeartbeat).toHaveBeenCalledWith(
      'agent-resolved',
      1_000,
      expect.any(Function),
    );
    expect(state.startDiscoveryLoop).toHaveBeenCalledTimes(1);
    expect(state.startObservabilityIngest).toHaveBeenCalledTimes(1);
    expect(state.startScheduler).toHaveBeenCalledTimes(1);
    expect(state.onConfigChange).toHaveBeenCalledTimes(1);
    expect(state.setInterval).toHaveBeenCalled();
  });

  test('runs a missed dream consolidation on startup when nightly scheduling is enabled', async () => {
    const dataDir = makeTempDir('hybridclaw-gateway-data-');
    const state = await importFreshGatewayMain({
      dataDir,
      onState: (draft) => {
        draft.currentConfig.memory = {
          consolidationIntervalHours: 24,
          decayRate: 0.4,
          consolidationLanguage: 'en',
        };
      },
    });

    expect(state.memoryServiceSetDecayRate).toHaveBeenCalledWith(0.4);
    expect(state.memoryServiceConsolidateWithCleanup).toHaveBeenCalledTimes(1);
    expect(state.setTimeout.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('does not rerun dream consolidation on startup when a nightly run already completed today', async () => {
    const dataDir = makeTempDir('hybridclaw-gateway-data-');
    fs.writeFileSync(
      path.join(dataDir, 'memory-consolidation-state.json'),
      `${JSON.stringify({
        version: 1,
        lastCompletedAt: new Date().toISOString(),
      })}\n`,
      'utf-8',
    );

    const state = await importFreshGatewayMain({
      dataDir,
      onState: (draft) => {
        draft.currentConfig.memory = {
          consolidationIntervalHours: 24,
          decayRate: 0.4,
          consolidationLanguage: 'en',
        };
      },
    });

    expect(state.memoryServiceConsolidateWithCleanup).not.toHaveBeenCalled();
    expect(state.setTimeout.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('logs the resolved scheduler timezone instead of an invalid USER.md placeholder', async () => {
    const dataDir = makeTempDir('hybridclaw-gateway-data-');
    const mainWorkspaceDir = path.join(dataDir, 'agents', 'main', 'workspace');
    fs.mkdirSync(mainWorkspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(mainWorkspaceDir, 'USER.md'),
      '# USER.md\n\n- **Timezone:** _(to be determined)_\n',
      'utf-8',
    );

    const state = await importFreshGatewayMain({
      dataDir,
      onState: (draft) => {
        draft.currentConfig.memory = {
          consolidationIntervalHours: 24,
          decayRate: 0.4,
          consolidationLanguage: 'en',
        };
      },
    });

    expect(state.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        nextRunAt: expect.any(String),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      }),
      'Memory consolidation scheduled for next nightly run',
    );
  });

  test('starts iMessage integration automatically when enabled in config', async () => {
    const state = await importFreshGatewayMain({ imessageEnabled: true });

    expect(state.initIMessage).toHaveBeenCalledTimes(1);
    expect(state.imessageMessageHandler).not.toBeNull();
    expectInfoLog(
      state,
      'Gateway channels',
      expect.objectContaining({
        imessage: true,
      }),
    );
  });

  test('keeps gateway startup running when iMessage integration fails to initialize', async () => {
    const state = await importFreshGatewayMain({
      imessageEnabled: true,
      imessageInitError: new Error('unsupported platform'),
    });

    expect(state.initIMessage).toHaveBeenCalledTimes(1);
    expect(state.imessageMessageHandler).toBeNull();
    expect(state.loggerWarn).toHaveBeenCalledWith(
      { error: expect.any(Error) },
      'iMessage integration failed to start',
    );
    expectInfoLog(
      state,
      'Gateway channels',
      expect.objectContaining({
        imessage: false,
      }),
    );
  });

  test('awaits gateway service initialization before opening startup surfaces', async () => {
    let releaseInit: (() => void) | null = null;
    const initGate = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    let capturedState: ReturnType<typeof createGatewayMainTestState> | null =
      null;

    const bootstrapPromise = importFreshGatewayMain({
      initGatewayServiceImpl: async () => {
        await initGate;
      },
      skipBootstrapHandlerCheck: true,
      onState: (state) => {
        capturedState = state;
      },
    });

    try {
      await settle();

      expect(capturedState).not.toBeNull();
      expect(capturedState?.startGatewayHttpServer).not.toHaveBeenCalled();
      expect(capturedState?.initDiscord).not.toHaveBeenCalled();
      expect(
        capturedState?.resumeEnabledFullAutoSessions,
      ).not.toHaveBeenCalled();
    } finally {
      releaseInit?.();
    }

    const state = await bootstrapPromise;

    expect(state.initGatewayService).toHaveBeenCalledTimes(1);
    expect(state.startGatewayHttpServer).toHaveBeenCalledTimes(1);
    expect(state.initDiscord).toHaveBeenCalledTimes(1);
    expect(state.resumeEnabledFullAutoSessions).toHaveBeenCalledTimes(1);
  });

  test('starts WhatsApp integration automatically when the transport is enabled', async () => {
    const state = await importFreshGatewayMain({ whatsappLinked: false });

    expect(state.initWhatsApp).toHaveBeenCalledTimes(1);
    expect(state.whatsappMessageHandler).not.toBeNull();
  });

  test('does not start WhatsApp integration when the transport is disabled', async () => {
    const state = await importFreshGatewayMain({
      whatsappEnabled: false,
      whatsappLinked: false,
    });

    expect(state.initWhatsApp).not.toHaveBeenCalled();
    expectInfoLog(
      state,
      'Gateway channels',
      expect.objectContaining({
        whatsapp: false,
      }),
    );
  });

  test('skips last-channel scheduled jobs when no deliverable channel exists', async () => {
    const state = await importFreshGatewayMain({
      onState: (draft) => {
        draft.currentMostRecentSessionChannelId = null;
      },
    });

    await state.scheduledTaskRunner?.({
      source: 'config-job',
      jobId: 'release-notes',
      sessionId: 'scheduler:release-notes',
      channelId: 'scheduler',
      prompt: 'publish release notes',
      actionKind: 'agent_turn',
      delivery: {
        kind: 'last-channel',
      },
    });

    expect(state.runGatewayScheduledTask).not.toHaveBeenCalled();
    expect(state.loggerInfo).toHaveBeenCalledWith(
      {
        jobId: 'release-notes',
        taskId: undefined,
        source: 'config-job',
        actionKind: 'agent_turn',
        delivery: 'last-channel',
      },
      'Scheduled task skipped: no delivery channel available',
    );
    expect(state.loggerError).not.toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'release-notes',
        delivery: 'last-channel',
      }),
      'Scheduled task failed',
    );
  });

  test('logs provider health and scheduler jobs separately from the startup summary', async () => {
    const state = await importFreshGatewayMain({
      onState: (draft) => {
        draft.getGatewayStatus.mockReturnValue({
          status: 'ok',
          sessions: 1,
          codex: {
            authenticated: true,
            source: 'browser-pkce',
            accountId: 'acct-1',
            expiresAt: 1,
            reloginRequired: false,
          },
          observability: {
            enabled: true,
            running: false,
            paused: false,
            reason: null,
            streamKey: 'stream-key',
            lastCursor: 1,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastError: null,
          },
          scheduler: {
            jobs: [
              {
                id: 'release-notes',
                name: 'Release Notes',
                description: null,
                enabled: true,
                lastRun: '2026-04-03T13:00:00.003Z',
                lastStatus: 'success',
                nextRunAt: '2026-04-03T14:00:00.000Z',
                disabled: false,
                consecutiveErrors: 0,
              },
            ],
          },
          providerHealth: {
            codex: {
              kind: 'remote',
              reachable: true,
              modelCount: 8,
              detail: 'Authenticated via browser-pkce',
            },
          },
          localBackends: {
            lmstudio: {
              reachable: true,
              latencyMs: 29,
              modelCount: 12,
            },
          },
        });
      },
    });

    expectInfoLog(
      state,
      'HybridClaw gateway started',
      expect.not.objectContaining({
        scheduler: expect.anything(),
        providerHealth: expect.anything(),
        localBackends: expect.anything(),
      }),
    );
    expectInfoLog(state, 'Gateway scheduler jobs', {
      jobs: [
        {
          id: 'release-notes',
          name: 'Release Notes',
          description: null,
          enabled: true,
          lastRun: '2026-04-03T13:00:00.003Z',
          lastStatus: 'success',
          nextRunAt: '2026-04-03T14:00:00.000Z',
          disabled: false,
          consecutiveErrors: 0,
        },
      ],
    });
    expectInfoLog(
      state,
      'Gateway provider health',
      expect.objectContaining({
        providerHealth: expect.objectContaining({
          codex: expect.objectContaining({
            reachable: true,
          }),
        }),
        localBackends: expect.objectContaining({
          lmstudio: expect.objectContaining({
            reachable: true,
          }),
        }),
      }),
    );
  });

  test('keeps the gateway running when WhatsApp auth is locked by another process', async () => {
    const state = await importFreshGatewayMain({
      whatsappLinked: true,
      whatsappAuthLockError: {
        lockPath: '/tmp/whatsapp.lock',
        ownerPid: 35685,
      },
    });

    expect(state.initWhatsApp).toHaveBeenCalledTimes(1);
    expect(state.startGatewayHttpServer).toHaveBeenCalledTimes(1);
    expect(state.loggerWarn).toHaveBeenCalledWith(
      {
        lockPath: '/tmp/whatsapp.lock',
        ownerPid: 35685,
      },
      'WhatsApp integration disabled: auth state is locked by another HybridClaw process',
    );
    expect(
      state.loggerError.mock.calls.some(
        (call) => call[1] === 'WhatsApp integration failed to start',
      ),
    ).toBe(false);
    expectInfoLog(
      state,
      'Gateway channels',
      expect.objectContaining({
        whatsapp: false,
      }),
    );
  });

  test('logs non-lock WhatsApp startup failures as errors without aborting gateway startup', async () => {
    const whatsappInitError = new Error('WhatsApp bootstrap failed');
    const state = await importFreshGatewayMain({
      whatsappLinked: true,
      whatsappInitError,
    });

    expect(state.initWhatsApp).toHaveBeenCalledTimes(1);
    expect(state.startGatewayHttpServer).toHaveBeenCalledTimes(1);
    expect(state.loggerError).toHaveBeenCalledWith(
      { error: whatsappInitError },
      'WhatsApp integration failed to start',
    );
    expectInfoLog(
      state,
      'Gateway channels',
      expect.objectContaining({
        whatsapp: false,
      }),
    );
  });

  test('keeps the gateway running when Discord startup rejects', async () => {
    const discordInitError = Object.assign(
      new Error('An invalid token was provided.'),
      { code: 'TokenInvalid' },
    );
    const state = await importFreshGatewayMain({ discordInitError });

    expect(state.initDiscord).toHaveBeenCalledTimes(1);
    expect(state.initMSTeams).toHaveBeenCalledTimes(1);
    expect(state.startGatewayHttpServer).toHaveBeenCalledTimes(1);
    expect(state.loggerWarn).toHaveBeenCalledWith(
      'Discord integration disabled: DISCORD_TOKEN was rejected by Discord. Update or clear the token and restart the gateway.',
    );
    expect(state.loggerError).not.toHaveBeenCalledWith(
      { error: discordInitError },
      'Discord integration failed to start',
    );
    expectInfoLog(
      state,
      'Gateway channels',
      expect.objectContaining({
        discord: false,
        msteams: true,
        email: false,
        whatsapp: true,
      }),
    );
  });

  test('logs non-token Discord startup failures as errors', async () => {
    const discordInitError = new Error('Discord gateway unavailable');
    const state = await importFreshGatewayMain({ discordInitError });

    expect(state.initDiscord).toHaveBeenCalledTimes(1);
    expect(state.loggerError).toHaveBeenCalledWith(
      { error: discordInitError },
      'Discord integration failed to start',
    );
    expect(state.loggerWarn).not.toHaveBeenCalledWith(
      'Discord integration disabled: DISCORD_TOKEN was rejected by Discord. Update or clear the token and restart the gateway.',
    );
    expectInfoLog(
      state,
      'Gateway channels',
      expect.objectContaining({
        discord: false,
      }),
    );
  });

  test('does not start Teams when config disables it even if credentials exist', async () => {
    const state = await importFreshGatewayMain({
      msteamsEnabled: false,
      hasMSTeamsCredentials: true,
    });

    expect(state.initMSTeams).not.toHaveBeenCalled();
    expect(state.teamsMessageHandler).toBeNull();
    expect(state.teamsCommandHandler).toBeNull();
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
      '123456789012345678',
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

  test('replies directly when a Discord chat result includes components', async () => {
    const state = await importFreshGatewayMain();
    state.handleGatewayMessage.mockResolvedValue({
      status: 'success',
      result: 'Choose an option',
      toolsUsed: [],
      artifacts: [],
      components: [{ type: 1, components: [] }],
    });
    const stream = {
      append: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      finalize: vi.fn(async () => {}),
    };
    const reply = vi.fn(async () => {});
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
      '123456789012345678',
      'user',
      'alice',
      'hello',
      [],
      reply,
      context,
    );

    expect(reply).toHaveBeenCalledWith(
      'Choose an option',
      [],
      [{ type: 1, components: [] }],
    );
    expect(stream.discard).toHaveBeenCalled();
    expect(stream.finalize).not.toHaveBeenCalled();
  });

  test('finalizes Teams message responses with uploaded artifact attachments', async () => {
    const state = await importFreshGatewayMain();
    state.buildTeamsArtifactAttachments.mockResolvedValue([
      {
        contentType: 'image/png',
        contentUrl: 'https://example.com/attachment.png',
        name: 'attachment.png',
      },
    ]);
    state.handleGatewayMessage.mockResolvedValue({
      status: 'success',
      result: 'Hello from gateway',
      toolsUsed: ['search'],
      artifacts: [
        {
          filename: 'attachment.png',
          mimeType: 'image/png',
          path: '/tmp/attachment.png',
        },
      ],
    });
    const stream = {
      append: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      finalize: vi.fn(async () => {}),
    };
    const turnContext = { sendActivities: vi.fn() };
    const context = {
      abortSignal: new AbortController().signal,
      activity: { id: 'activity-1' },
      policy: { replyStyle: 'thread' },
      stream,
      turnContext,
    };

    await state.teamsMessageHandler?.(
      'teams:dm:user-aad-id',
      null,
      'a:teams-current-conversation',
      'user-aad-id',
      'alice',
      'hello',
      [],
      vi.fn(async () => {}),
      context,
    );

    expect(state.buildTeamsArtifactAttachments).toHaveBeenCalledWith({
      artifacts: [
        {
          filename: 'attachment.png',
          mimeType: 'image/png',
          path: '/tmp/attachment.png',
        },
      ],
      turnContext,
    });
    expect(stream.finalize).toHaveBeenCalledWith(
      'Hello from gateway\n*Tools: search*',
      [
        {
          contentType: 'image/png',
          contentUrl: 'https://example.com/attachment.png',
          name: 'attachment.png',
        },
      ],
    );
  });

  test('keeps attachment-only Teams replies instead of discarding them', async () => {
    const state = await importFreshGatewayMain();
    state.buildTeamsArtifactAttachments.mockResolvedValue([
      {
        contentType: 'image/png',
        contentUrl: 'https://example.com/attachment.png',
        name: 'attachment.png',
      },
    ]);
    state.handleGatewayMessage.mockResolvedValue({
      status: 'success',
      result: '',
      toolsUsed: ['browser_screenshot'],
      artifacts: [
        {
          filename: 'attachment.png',
          mimeType: 'image/png',
          path: '/tmp/attachment.png',
        },
      ],
    });
    const stream = {
      append: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      finalize: vi.fn(async () => {}),
    };
    const context = {
      abortSignal: new AbortController().signal,
      activity: { id: 'activity-1' },
      policy: { replyStyle: 'thread' },
      stream,
      turnContext: { sendActivities: vi.fn() },
    };

    await state.teamsMessageHandler?.(
      'teams:dm:user-aad-id',
      null,
      'a:teams-current-conversation',
      'user-aad-id',
      'alice',
      'hello',
      [],
      vi.fn(async () => {}),
      context,
    );

    expect(stream.discard).not.toHaveBeenCalled();
    expect(stream.finalize).toHaveBeenCalledWith('', [
      {
        contentType: 'image/png',
        contentUrl: 'https://example.com/attachment.png',
        name: 'attachment.png',
      },
    ]);
  });

  test('sends Teams attachments as a follow-up when text was already streamed', async () => {
    const state = await importFreshGatewayMain();
    state.buildTeamsArtifactAttachments.mockResolvedValue([
      {
        contentType: 'image/png',
        contentUrl: 'https://example.com/attachment.png',
        name: 'attachment.png',
      },
    ]);
    state.handleGatewayMessage.mockImplementation(
      async ({ onTextDelta }: { onTextDelta?: (delta: string) => void }) => {
        onTextDelta?.('Screenshot captured.');
        return {
          status: 'success' as const,
          result: 'Screenshot captured.',
          toolsUsed: ['browser_screenshot'],
          artifacts: [
            {
              filename: 'attachment.png',
              mimeType: 'image/png',
              path: '/tmp/attachment.png',
            },
          ],
        };
      },
    );
    const stream = {
      append: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      finalize: vi.fn(async () => {}),
    };
    const reply = vi.fn(async () => {});
    const context = {
      abortSignal: new AbortController().signal,
      activity: { id: 'activity-1' },
      policy: { replyStyle: 'thread' },
      stream,
      turnContext: { sendActivities: vi.fn() },
    };

    await state.teamsMessageHandler?.(
      'teams:dm:user-aad-id',
      null,
      'a:teams-current-conversation',
      'user-aad-id',
      'alice',
      'hello',
      [],
      reply,
      context,
    );

    expect(stream.finalize).toHaveBeenCalledWith(
      'Screenshot captured.\n*Tools: browser_screenshot*',
    );
    expect(reply).toHaveBeenCalledWith('', [
      {
        contentType: 'image/png',
        contentUrl: 'https://example.com/attachment.png',
        name: 'attachment.png',
      },
    ]);
  });

  test('stores rendered fallback text for Discord pending approvals', async () => {
    const state = await importFreshGatewayMain();
    const pendingApprovals = await import(
      '../src/gateway/pending-approvals.js'
    );
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
      '123456789012345678',
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
    await pendingApprovals.clearPendingApproval('session');
  });

  test('stores Teams pending approvals and advertises numeric replies', async () => {
    const state = await importFreshGatewayMain();
    const pendingApprovals = await import(
      '../src/gateway/pending-approvals.js'
    );
    state.handleGatewayMessage.mockResolvedValue({
      status: 'success',
      result: 'Need approval',
      toolsUsed: ['bash'],
      artifacts: [],
      pendingApproval: {
        approvalId: 'approve123',
        prompt: 'Need approval',
        intent: 'control a local app',
        reason: 'this command controls host GUI or application state',
        allowSession: true,
        allowAgent: true,
        expiresAt: Date.now() + 60_000,
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
      activity: { id: 'activity-1' },
      policy: { replyStyle: 'thread' },
      stream,
      turnContext: { sendActivities: vi.fn() },
    };

    await state.teamsMessageHandler?.(
      'teams:dm:user-aad-id',
      null,
      'a:teams-current-conversation',
      'user-aad-id',
      'alice',
      'hello',
      [],
      vi.fn(async () => {}),
      context,
    );

    expect(
      pendingApprovals.getPendingApproval('teams:dm:user-aad-id'),
    ).toMatchObject({
      approvalId: 'approve123',
      userId: 'user-aad-id',
    });
    expect(stream.finalize).toHaveBeenCalledWith(
      expect.stringContaining('Reply `1` to allow once'),
    );
    expect(stream.finalize).toHaveBeenCalledWith(
      expect.stringContaining('`/approve [1|2|3|4|5]`'),
    );
    await pendingApprovals.clearPendingApproval('teams:dm:user-aad-id');
  });

  test('routes bare Teams numeric approvals through the approval command flow', async () => {
    const state = await importFreshGatewayMain();
    const pendingApprovals = await import(
      '../src/gateway/pending-approvals.js'
    );
    await pendingApprovals.setPendingApproval('teams:dm:user-aad-id', {
      approvalId: 'approve123',
      prompt: 'Need approval',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      userId: 'user-aad-id',
      resolvedAt: null,
      disableButtons: null,
      disableTimeout: null,
    });
    state.handleGatewayMessage.mockResolvedValue({
      status: 'success',
      result: 'Approved.',
      toolsUsed: [],
      artifacts: [],
    });
    const stream = {
      append: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      finalize: vi.fn(async () => {}),
    };
    const reply = vi.fn(async () => {});
    const context = {
      abortSignal: new AbortController().signal,
      activity: { id: 'activity-1' },
      policy: { replyStyle: 'thread' },
      stream,
      turnContext: { sendActivities: vi.fn() },
    };

    await state.teamsMessageHandler?.(
      'teams:dm:user-aad-id',
      null,
      'a:teams-current-conversation',
      'user-aad-id',
      'alice',
      '2',
      [],
      reply,
      context,
    );

    expect(state.handleGatewayMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'yes approve123 for session',
        sessionId: 'teams:dm:user-aad-id',
      }),
    );
    expect(reply).toHaveBeenCalledWith('Approved.');
    await pendingApprovals.clearPendingApproval('teams:dm:user-aad-id');
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

  test('routes iMessage slash commands through the gateway command handler', async () => {
    const state = await importFreshGatewayMain({ imessageEnabled: true });
    const reply = vi.fn(async () => {});

    await state.imessageMessageHandler?.(
      'agent:main:channel:imessage:chat:dm:peer:imessage%3A%2B491701234567',
      null,
      'imessage:+491701234567',
      '+491701234567',
      'alice',
      '/status',
      [],
      reply,
      {
        abortSignal: new AbortController().signal,
        inbound: {},
        rawEvent: {},
        backend: 'local',
        conversationId: 'any;-;+491701234567',
        handle: '+491701234567',
        isGroup: false,
      },
    );

    expect(state.handleGatewayCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['status'],
        channelId: 'imessage:+491701234567',
        sessionId:
          'agent:main:channel:imessage:chat:dm:peer:imessage%3A%2B491701234567',
      }),
    );
    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith('rendered:plain output');
  });

  test('suppresses interrupted reply text for local iMessage self-chat', async () => {
    const state = await importFreshGatewayMain({ imessageEnabled: true });
    state.handleGatewayMessage.mockResolvedValue({
      status: 'error',
      result: null,
      toolsUsed: [],
      artifacts: [],
      error: 'Timeout waiting for agent output after 300000ms',
    });
    const reply = vi.fn(async () => {});

    await state.imessageMessageHandler?.(
      'agent:main:channel:imessage:chat:dm:peer:imessage%3A%2B491701234567',
      null,
      'imessage:+491701234567',
      '+491701234567',
      'alice',
      'Hi',
      [],
      reply,
      {
        abortSignal: new AbortController().signal,
        inbound: {
          backend: 'local',
          conversationId: 'any;-;+491701234567',
          handle: '+491701234567',
          isGroup: false,
          rawEvent: {
            handle: '+491701234567',
            chatIdentifier: '+491701234567',
          },
        },
      },
    );

    expect(reply).not.toHaveBeenCalled();
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
      memory: {
        consolidationIntervalHours: 2,
        decayRate: 0.5,
        consolidationLanguage: 'en',
      },
      observability: { enabled: true, botId: 'bot-obs', agentId: 'agent-obs' },
      scheduler: { jobs: [{ id: 'job-1' }] },
    };

    state.currentConfig = nextConfig;
    state.configChangeListener?.(nextConfig, previousConfig);

    expect(state.startHeartbeat).toHaveBeenCalledTimes(2);
    expect(state.rearmScheduler).toHaveBeenCalledTimes(1);
    expect(state.startObservabilityIngest).toHaveBeenCalledTimes(2);
    expect(state.setTimeout.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('restarts email integration when email config changes', async () => {
    const state = await importFreshGatewayMain({
      emailEnabled: true,
      emailPassword: 'secret',
    });
    const previousConfig = state.currentConfig;
    const nextConfig = {
      ...state.currentConfig,
      email: {
        ...state.currentConfig.email,
        smtpSecure: true,
      },
    };

    expect(state.initEmail).toHaveBeenCalledTimes(1);

    state.currentConfig = nextConfig;
    state.configChangeListener?.(nextConfig, previousConfig);
    await settle();

    expect(state.shutdownEmail).toHaveBeenCalledTimes(1);
    expect(state.initEmail).toHaveBeenCalledTimes(2);
    expectInfoLog(
      state,
      'Config changed, restarting email integration',
      expect.objectContaining({
        address: 'bot@example.com',
        smtpHost: 'smtp.example.com',
        smtpSecure: true,
      }),
    );
  });
});
