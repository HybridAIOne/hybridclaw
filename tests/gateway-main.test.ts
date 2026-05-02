import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

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
  slackEnabled?: boolean;
  slackInitError?: Error;
  hasSlackCredentials?: boolean;
  twilioAuthToken?: string;
  voiceEnabled?: boolean;
  voiceConfigAuthToken?: string;
  voiceInitError?: Error;
  whatsappEnabled?: boolean;
  whatsappLinked?: boolean;
  msteamsEnabled?: boolean;
  hasMSTeamsCredentials?: boolean;
  initGatewayServiceImpl?: () => Promise<void>;
  warmPoolEnabled?: boolean;
}) {
  return {
    commandHandler: null as null | ((...args: unknown[]) => Promise<void>),
    messageHandler: null as null | ((...args: unknown[]) => Promise<void>),
    teamsCommandHandler: null as null | ((...args: unknown[]) => Promise<void>),
    teamsMessageHandler: null as null | ((...args: unknown[]) => Promise<void>),
    slackMessageHandler: null as null | ((...args: unknown[]) => Promise<void>),
    signalMessageHandler: null as
      | null
      | ((...args: unknown[]) => Promise<void>),
    telegramMessageHandler: null as
      | null
      | ((...args: unknown[]) => Promise<void>),
    imessageMessageHandler: null as
      | null
      | ((...args: unknown[]) => Promise<void>),
    voiceMessageHandler: null as null | ((...args: unknown[]) => Promise<void>),
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
      slack: {
        enabled: options?.slackEnabled ?? false,
        groupPolicy: 'allowlist',
        dmPolicy: 'allowlist',
        allowFrom: [] as string[],
        groupAllowFrom: [] as string[],
        requireMention: true,
        textChunkLimit: 12_000,
        replyStyle: 'thread',
        mediaMaxMb: 20,
      },
      signal: {
        enabled: false,
        daemonUrl: '',
        account: '',
        dmPolicy: 'disabled',
        groupPolicy: 'disabled',
        allowFrom: [] as string[],
        groupAllowFrom: [] as string[],
        textChunkLimit: 4_000,
        reconnectIntervalMs: 5_000,
        outboundDelayMs: 350,
      },
      telegram: {
        enabled: false,
        botToken: '',
        dmPolicy: 'disabled',
        groupPolicy: 'disabled',
        allowFrom: [] as string[],
        groupAllowFrom: [] as string[],
        requireMention: true,
        pollIntervalMs: 1_500,
        textChunkLimit: 4_000,
        mediaMaxMb: 20,
      },
      voice: {
        enabled: options?.voiceEnabled ?? false,
        provider: 'twilio',
        twilio: {
          accountSid: options?.voiceEnabled ? 'AC123' : '',
          authToken:
            options?.voiceConfigAuthToken ??
            (options?.voiceEnabled ? 'twilio-auth-token' : ''),
          fromNumber: options?.voiceEnabled ? '+14155550123' : '',
        },
        relay: {
          ttsProvider: 'default',
          voice: '',
          transcriptionProvider: 'default',
          language: 'en-US',
          interruptible: true,
          welcomeGreeting: 'Hello! How can I help you today?',
        },
        webhookPath: '/voice',
        maxConcurrentCalls: 8,
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
      container: {
        sandboxMode: 'container',
        warmPool: {
          enabled: options?.warmPoolEnabled ?? false,
          coldStartBudgetMs: 200,
          trafficWindowMs: 3_600_000,
          minIdlePerActiveAgent: 1,
          maxIdlePerAgent: 2,
          memoryPressureRssMb: 2_048,
        },
      },
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
    getActiveExecutorCount: vi.fn(() => 0),
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
    validateGatewayPromptEnvDefaults: vi.fn(),
    initDatabase: vi.fn(),
    initDiscord: vi.fn(),
    initEmail: vi.fn(),
    initIMessage: vi.fn(),
    initMSTeams: vi.fn(),
    initSignal: vi.fn(),
    initSlack: vi.fn(),
    initTelegram: vi.fn(),
    initVoice: vi.fn(),
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
    shutdownDiscord: vi.fn(async () => {}),
    shutdownEmail: vi.fn(async () => {}),
    shutdownSignal: vi.fn(async () => {}),
    shutdownSlack: vi.fn(async () => {}),
    shutdownTelegram: vi.fn(async () => {}),
    shutdownWhatsApp: vi.fn(async () => {}),
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
    setDiscordMaintenancePresence: vi.fn(async () => {}),
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
  slackEnabled?: boolean;
  hasSlackCredentials?: boolean;
  whatsappEnabled?: boolean;
  voiceEnabled?: boolean;
  voiceInitError?: Error;
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
  warmPoolEnabled?: boolean;
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
  state.initSlack.mockImplementation((messageHandler) => {
    if (options?.slackInitError) {
      throw options.slackInitError;
    }
    state.slackMessageHandler = messageHandler;
  });
  state.initSignal.mockImplementation((messageHandler) => {
    state.signalMessageHandler = messageHandler;
  });
  state.initTelegram.mockImplementation((messageHandler) => {
    state.telegramMessageHandler = messageHandler;
  });
  state.initIMessage.mockImplementation((messageHandler) => {
    if (options?.imessageInitError) {
      throw options.imessageInitError;
    }
    state.imessageMessageHandler = messageHandler;
  });
  state.initVoice.mockImplementation((messageHandler) => {
    if (options?.voiceInitError) {
      throw options.voiceInitError;
    }
    state.voiceMessageHandler = messageHandler;
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
    getActiveExecutorCount: state.getActiveExecutorCount,
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
    shutdownDiscord: state.shutdownDiscord,
    setDiscordMaintenancePresence: state.setDiscordMaintenancePresence,
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
  vi.doMock('../src/channels/signal/runtime.js', () => ({
    initSignal: state.initSignal,
    sendToSignalChat: vi.fn(async () => {}),
    shutdownSignal: state.shutdownSignal,
  }));
  vi.doMock('../src/channels/telegram/runtime.js', () => ({
    hasTelegramBotToken: vi.fn(() =>
      Boolean(
        String(state.getConfigSnapshot().telegram?.botToken || '').trim(),
      ),
    ),
    initTelegram: state.initTelegram,
    sendTelegramMediaToChat: vi.fn(async () => {}),
    sendToTelegramChat: vi.fn(async () => {}),
    shutdownTelegram: state.shutdownTelegram,
  }));
  vi.doMock('../src/channels/voice/runtime.js', () => ({
    initVoice: state.initVoice,
    shutdownVoice: vi.fn(async () => {}),
  }));
  vi.doMock('../src/channels/msteams/runtime.js', () => ({
    initMSTeams: state.initMSTeams,
  }));
  vi.doMock('../src/channels/slack/runtime.js', () => ({
    initSlack: state.initSlack,
    sendSlackFileToTarget: vi.fn(async () => {}),
    sendToSlackTarget: vi.fn(async () => {}),
    shutdownSlack: state.shutdownSlack,
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
    shutdownWhatsApp: state.shutdownWhatsApp,
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
    SLACK_APP_TOKEN:
      options?.hasSlackCredentials === false ? '' : 'slack-app-token',
    SLACK_BOT_TOKEN:
      options?.hasSlackCredentials === false ? '' : 'xoxb-slack-bot-token',
    TELEGRAM_BOT_TOKEN: '',
    TWILIO_AUTH_TOKEN:
      options?.twilioAuthToken ?? state.currentConfig.voice.twilio.authToken,
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
    validateGatewayPromptEnvDefaults: state.validateGatewayPromptEnvDefaults,
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

useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllGlobals: true,
  unmock: [
    '../src/agent/executor.js',
    '../src/agent/proactive-policy.js',
    '../src/agent/silent-reply.js',
    '../src/agent/silent-reply-stream.js',
    '../src/audit/observability-ingest.js',
    '../src/channels/discord/delivery.js',
    '../src/channels/discord/mentions.js',
    '../src/channels/discord/runtime.js',
    '../src/channels/imessage/runtime.js',
    '../src/channels/signal/runtime.js',
    '../src/channels/telegram/runtime.js',
    '../src/channels/voice/runtime.js',
    '../src/channels/msteams/attachments.js',
    '../src/channels/msteams/runtime.js',
    '../src/channels/slack/runtime.js',
    '../src/channels/email/runtime.js',
    '../src/channels/whatsapp/runtime.js',
    '../src/channels/whatsapp/auth.js',
    '../src/config/config.js',
    '../src/logger.js',
    '../src/memory/db.js',
    '../src/memory/memory-service.js',
    '../src/agents/agent-registry.js',
    '../src/providers/local-discovery.js',
    '../src/providers/local-health.js',
    '../src/scheduler/heartbeat.js',
    '../src/scheduler/scheduler.js',
    '../src/gateway/gateway-service.js',
    '../src/gateway/gateway-chat-service.js',
    '../src/gateway/gateway-scheduled-task-service.js',
    '../src/gateway/gateway-http-server.js',
    '../src/gateway/proactive-delivery.js',
    '../src/gateway/managed-media-cleanup.js',
    '../src/workflow/executor.js',
    '../src/workflow/service.js',
  ],
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

  test('logs info on startup when the warm process pool is enabled', async () => {
    const state = await importFreshGatewayMain({ warmPoolEnabled: true });

    expect(state.loggerInfo).toHaveBeenCalledWith(
      {
        sandboxMode: 'container',
        minIdlePerActiveAgent: 1,
        maxIdlePerAgent: 2,
        effectiveMinIdlePerActiveAgent: 1,
        memoryPressureRssMb: 2_048,
        coldStartBudgetMs: 200,
        warmScope:
          'runtime process only; request-specific MCP, plugin, media, and model setup still runs after input',
        warmFill:
          'filled after recent traffic for an agent; gateway startup does not pre-spawn workers',
        disableConfig: 'container.warmPool.enabled=false',
      },
      'Warm process pool enabled; idle workers prewarm runtime process startup only',
    );
    expect(state.loggerWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      'Warm process pool enabled; idle workers prewarm runtime process startup only',
    );
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

  test('starts voice integration automatically when enabled in config', async () => {
    const state = await importFreshGatewayMain({ voiceEnabled: true });

    expect(state.initVoice).toHaveBeenCalledTimes(1);
    expect(state.voiceMessageHandler).not.toBeNull();
    expectInfoLog(
      state,
      'Gateway channels',
      expect.objectContaining({
        voice: true,
      }),
    );
  });

  test('starts voice integration when the Twilio auth token comes from shared secret resolution', async () => {
    const state = await importFreshGatewayMain({
      voiceEnabled: true,
      voiceConfigAuthToken: '',
      twilioAuthToken: 'twilio-auth-token',
    });

    expect(state.initVoice).toHaveBeenCalledTimes(1);
    expect(state.voiceMessageHandler).not.toBeNull();
  });

  test('voice integration batches streamed text and strips markdown before speaking', async () => {
    const state = await importFreshGatewayMain({ voiceEnabled: true });
    state.handleGatewayMessage.mockImplementation(
      async ({ onTextDelta }: { onTextDelta?: (delta: string) => void }) => {
        onTextDelta?.('**Yes');
        onTextDelta?.('** that works.');
        return {
          status: 'success' as const,
          result: '**Yes** that works.',
          toolsUsed: [],
          artifacts: [],
        };
      },
    );

    const reply = vi.fn(async () => {});
    const responseStream = {
      push: vi.fn(async () => {}),
    };

    await state.voiceMessageHandler?.(
      'session-voice',
      null,
      'voice:CA123',
      'user-voice',
      'Caller',
      'hello',
      [],
      reply,
      {
        abortSignal: new AbortController().signal,
        callSid: 'CA123',
        twilioSessionId: 'VX123',
        remoteIp: '127.0.0.1',
        setupMessage: null,
        responseStream,
      },
    );

    expect(responseStream.push).toHaveBeenCalledTimes(1);
    expect(responseStream.push).toHaveBeenCalledWith('Yes that works.');
    expect(reply).not.toHaveBeenCalled();
  });

  test('voice integration normalizes approval phrases from speech transcripts', async () => {
    const state = await importFreshGatewayMain({ voiceEnabled: true });
    state.handleGatewayMessage.mockResolvedValue({
      status: 'success',
      result: 'Approved.',
      toolsUsed: [],
      artifacts: [],
    });

    const reply = vi.fn(async () => {});
    const responseStream = {
      push: vi.fn(async () => {}),
    };

    await state.voiceMessageHandler?.(
      'session-voice',
      null,
      'voice:CA123',
      'user-voice',
      'Caller',
      'Yes for a session.',
      [],
      reply,
      {
        abortSignal: new AbortController().signal,
        callSid: 'CA123',
        twilioSessionId: 'VX123',
        remoteIp: '127.0.0.1',
        setupMessage: null,
        responseStream,
      },
    );

    expect(state.handleGatewayMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'yes for session',
        channelId: 'voice:CA123',
        source: 'voice',
      }),
    );
    expect(reply).toHaveBeenCalledWith('Approved.');
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

    expect(context.sendApprovalNotification).toHaveBeenCalledWith({
      approval: expect.objectContaining({
        approvalId: 'approve123',
        prompt: '',
      }),
      presentation: {
        mode: 'buttons',
        showText: true,
        showButtons: true,
        showReplyText: false,
      },
      userId: 'user',
    });
    expect(pendingApprovals.getPendingApproval('session')).toMatchObject({
      approvalId: 'approve123',
      prompt: 'Hello <@123>\n*Tools: search*',
      presentation: {
        mode: 'buttons',
        showText: true,
        showButtons: true,
        showReplyText: false,
      },
    });

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

  test('stores Slack pending approvals via the transport notification hook', async () => {
    const state = await importFreshGatewayMain({ slackEnabled: true });
    const pendingApprovals = await import(
      '../src/gateway/pending-approvals.js'
    );
    state.handleGatewayMessage.mockResolvedValue({
      status: 'success',
      result: 'Need approval',
      toolsUsed: ['web_search'],
      artifacts: [],
      pendingApproval: {
        approvalId: 'approve123',
        prompt: 'I need your approval before I access reuters.com.',
        intent: 'access reuters.com',
        reason: 'this would contact a new external host',
        allowSession: true,
        allowAgent: true,
        allowAll: true,
        expiresAt: 1_710_000_000_000,
      },
    });
    const cleanup = {
      disableButtons: vi.fn(async () => {}),
    };
    const sendApprovalNotification = vi.fn(async () => cleanup);
    const reply = vi.fn(async () => {});

    await state.slackMessageHandler?.(
      'session-slack',
      null,
      'slack:C1234567890:1710000000.123456',
      'U1234567890',
      'alice',
      'hello',
      [],
      reply,
      {
        inbound: {
          target: 'slack:C1234567890:1710000000.123456',
          isDm: false,
          threadTs: '1710000000.123456',
          rawEvent: {
            channel: 'C1234567890',
            ts: '1710000000.200000',
            type: 'message',
          },
        },
        sendApprovalNotification,
      },
    );

    expect(sendApprovalNotification).toHaveBeenCalledWith({
      approval: expect.objectContaining({
        approvalId: 'approve123',
        prompt: 'I need your approval before I access reuters.com.',
      }),
      presentation: {
        mode: 'buttons',
        showText: true,
        showButtons: true,
        showReplyText: false,
      },
      userId: 'U1234567890',
    });
    expect(reply).not.toHaveBeenCalled();
    expect(pendingApprovals.getPendingApproval('session-slack')).toMatchObject({
      approvalId: 'approve123',
      userId: 'U1234567890',
      prompt: 'I need your approval before I access reuters.com.',
      presentation: {
        mode: 'buttons',
        showText: true,
        showButtons: true,
        showReplyText: false,
      },
      disableButtons: cleanup.disableButtons,
    });
    await pendingApprovals.clearPendingApproval('session-slack');
  });

  test('routes Slack slash-text commands through the gateway command handler', async () => {
    const state = await importFreshGatewayMain({ slackEnabled: true });
    const reply = vi.fn(async () => {});

    await state.slackMessageHandler?.(
      'session-slack',
      null,
      'slack:C1234567890',
      'U1234567890',
      'alice',
      '/status',
      [],
      reply,
      {
        inbound: {
          target: 'slack:C1234567890',
          isDm: false,
          threadTs: null,
          rawEvent: {
            channel: 'C1234567890',
            ts: '1710000000.200000',
            type: 'message',
          },
        },
      },
    );

    expect(state.handleGatewayCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-slack',
        channelId: 'slack:C1234567890',
        args: ['status'],
        userId: 'U1234567890',
      }),
    );
    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith('rendered:plain output');
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
      presentation: {
        mode: 'text',
        showText: true,
        showButtons: false,
        showReplyText: true,
      },
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

  test('does not restart Telegram integration when Telegram config values are unchanged', async () => {
    const state = await importFreshGatewayMain({
      onState: (draft) => {
        draft.currentConfig.telegram = {
          ...draft.currentConfig.telegram,
          enabled: true,
          botToken: 'telegram-token',
          dmPolicy: 'allowlist',
          allowFrom: ['12345'],
        };
      },
    });
    const previousConfig = state.currentConfig;
    const nextConfig = {
      ...state.currentConfig,
      telegram: {
        ...state.currentConfig.telegram,
        allowFrom: [...state.currentConfig.telegram.allowFrom],
        groupAllowFrom: [...state.currentConfig.telegram.groupAllowFrom],
      },
    };

    expect(state.initTelegram).toHaveBeenCalledTimes(1);

    state.currentConfig = nextConfig;
    state.configChangeListener?.(nextConfig, previousConfig);
    await settle();

    expect(state.shutdownTelegram).not.toHaveBeenCalled();
    expect(state.initTelegram).toHaveBeenCalledTimes(1);
  });

  test('restarts Telegram integration when Telegram config changes', async () => {
    const state = await importFreshGatewayMain({
      onState: (draft) => {
        draft.currentConfig.telegram = {
          ...draft.currentConfig.telegram,
          enabled: true,
          botToken: 'telegram-token',
          dmPolicy: 'allowlist',
          allowFrom: ['12345'],
        };
      },
    });
    const previousConfig = state.currentConfig;
    const nextConfig = {
      ...state.currentConfig,
      telegram: {
        ...state.currentConfig.telegram,
        requireMention: false,
      },
    };

    expect(state.initTelegram).toHaveBeenCalledTimes(1);

    state.currentConfig = nextConfig;
    state.configChangeListener?.(nextConfig, previousConfig);
    await settle();

    expect(state.shutdownTelegram).toHaveBeenCalledTimes(1);
    expect(state.initTelegram).toHaveBeenCalledTimes(2);
    expectInfoLog(
      state,
      'Config changed, restarting Telegram integration',
      expect.objectContaining({
        enabled: true,
        dmPolicy: 'allowlist',
        groupPolicy: 'disabled',
        pollIntervalMs: 1_500,
        requireMention: false,
      }),
    );
  });

  test('does not restart Slack integration when Slack allowlists only change order', async () => {
    const state = await importFreshGatewayMain({
      slackEnabled: true,
      hasSlackCredentials: true,
      onState: (draft) => {
        draft.currentConfig.slack = {
          ...draft.currentConfig.slack,
          enabled: true,
          allowFrom: ['U123', 'U456'],
          groupAllowFrom: ['U789', 'U000'],
        };
      },
    });
    const previousConfig = state.currentConfig;
    const nextConfig = {
      ...state.currentConfig,
      slack: {
        ...state.currentConfig.slack,
        allowFrom: ['U456', 'U123'],
        groupAllowFrom: ['U000', 'U789'],
      },
    };

    expect(state.initSlack).toHaveBeenCalledTimes(1);

    state.currentConfig = nextConfig;
    state.configChangeListener?.(nextConfig, previousConfig);
    await settle();

    expect(state.shutdownSlack).not.toHaveBeenCalled();
    expect(state.initSlack).toHaveBeenCalledTimes(1);
  });

  test('restarts Slack integration when Slack config changes', async () => {
    const state = await importFreshGatewayMain({
      slackEnabled: true,
      hasSlackCredentials: true,
    });
    const previousConfig = state.currentConfig;
    const nextConfig = {
      ...state.currentConfig,
      slack: {
        ...state.currentConfig.slack,
        replyStyle: 'top-level',
      },
    };

    expect(state.initSlack).toHaveBeenCalledTimes(1);

    state.currentConfig = nextConfig;
    state.configChangeListener?.(nextConfig, previousConfig);
    await settle();

    expect(state.shutdownSlack).toHaveBeenCalledTimes(1);
    expect(state.initSlack).toHaveBeenCalledTimes(2);
    expectInfoLog(
      state,
      'Config changed, restarting Slack integration',
      expect.objectContaining({
        enabled: true,
        dmPolicy: 'allowlist',
        groupPolicy: 'allowlist',
        requireMention: true,
        replyStyle: 'top-level',
      }),
    );
  });

  test('SIGTERM shutdown stops executors before draining', async () => {
    const state = await importFreshGatewayMain({
      onState: (nextState) => {
        nextState.getActiveExecutorCount.mockReturnValueOnce(1);
        nextState.getActiveExecutorCount.mockReturnValue(0);
      },
    });
    const sigtermHandler = state.processOn.mock.calls.find(
      ([event]) => event === 'SIGTERM',
    )?.[1] as (() => void) | undefined;
    const executorModule = await import('../src/agent/executor.js');
    const stopAllExecutionsMock = vi.mocked(executorModule.stopAllExecutions);

    expect(sigtermHandler).toBeTypeOf('function');

    sigtermHandler?.();
    await settle();

    expect(stopAllExecutionsMock).toHaveBeenCalledTimes(1);
    expect(stopAllExecutionsMock.mock.invocationCallOrder[0]).toBeLessThan(
      state.getActiveExecutorCount.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(
      state.startGatewayHttpServer.mock.results[0]?.value.broadcastShutdown,
    ).toHaveBeenCalledTimes(1);
  });

  test('shutdown continues when a cleanup step never resolves', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const state = await importFreshGatewayMain({
      onState: (nextState) => {
        nextState.setDiscordMaintenancePresence.mockImplementation(
          () => new Promise<void>(() => undefined),
        );
        nextState.setTimeout.mockImplementation((callback: () => void) => {
          callback();
          return { timer: true };
        });
      },
    });
    const sigintHandler = state.processOn.mock.calls.find(
      ([event]) => event === 'SIGINT',
    )?.[1] as (() => void) | undefined;

    expect(sigintHandler).toBeTypeOf('function');

    sigintHandler?.();
    await settle();
    await settle();

    expect(state.loggerWarn).toHaveBeenCalledWith(
      {
        step: 'set Discord maintenance presence',
        timeoutMs: 5_000,
      },
      'Gateway shutdown step timed out; continuing',
    );
    expect(state.shutdownEmail).toHaveBeenCalledTimes(1);
    expect(state.shutdownSlack).toHaveBeenCalledTimes(1);
    expect(state.shutdownTelegram).toHaveBeenCalledTimes(1);
    expect(state.shutdownWhatsApp).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('keeps voice stopped on config change until shared Twilio auth token refresh completes', async () => {
    const state = await importFreshGatewayMain({
      voiceEnabled: false,
      twilioAuthToken: '',
      voiceConfigAuthToken: '',
    });
    const previousConfig = state.currentConfig;
    const nextConfig = {
      ...state.currentConfig,
      voice: {
        enabled: true,
        provider: 'twilio',
        twilio: {
          accountSid: 'AC123',
          authToken: 'config-token',
          fromNumber: '+14155550123',
        },
        relay: {
          ...state.currentConfig.voice.relay,
        },
        webhookPath: '/voice',
        maxConcurrentCalls: 8,
      },
    };

    expect(state.initVoice).toHaveBeenCalledTimes(0);

    state.currentConfig = nextConfig;
    state.configChangeListener?.(nextConfig, previousConfig);
    await settle();

    expect(state.initVoice).toHaveBeenCalledTimes(0);
    expect(state.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        accountSidConfigured: true,
        authTokenConfigured: false,
        configAuthTokenConfigured: true,
        fromNumberConfigured: true,
        sharedAuthTokenConfigured: false,
      }),
      'Config changed, keeping Voice integration stopped until shared Twilio auth token refresh completes',
    );
    expect(state.loggerWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      'Voice integration disabled: Twilio credentials are incomplete',
    );
  });
});
