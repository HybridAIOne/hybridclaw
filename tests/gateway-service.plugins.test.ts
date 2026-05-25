import { Readable } from 'node:stream';

import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const {
  runAgentMock,
  ensurePluginManagerInitializedMock,
  reloadPluginManagerMock,
  shutdownPluginManagerMock,
  setPluginInboundMessageDispatcherMock,
  checkPluginMock,
  formatDependencyPlanDetailsMock,
  installPluginMock,
  listInstallablePluginsMock,
  pluginDependencyApprovalRequiredError,
  readPluginConfigEntryMock,
  readPluginConfigValueMock,
  reinstallPluginMock,
  setPluginEnabledMock,
  unsetPluginConfigValueMock,
  uninstallPluginMock,
  pluginManagerMock,
  writePluginConfigValueMock,
} = vi.hoisted(() => {
  const pluginManager = {
    collectPromptContextDetails: vi.fn(async () => ({
      sections: ['plugin-memory-context'],
      pluginIds: ['qmd-memory'],
      replacesBuiltInMemory: false,
    })),
    collectPromptContext: vi.fn(async () => ['plugin-memory-context']),
    getMemoryLayerBehavior: vi.fn(async () => ({
      replacesBuiltInMemory: false,
    })),
    findCommand: vi.fn(() => undefined),
    getToolDefinitions: vi.fn(() => [
      {
        name: 'memory_lookup',
        description: 'Query plugin memory',
        parameters: {
          type: 'object' as const,
          properties: {
            question: { type: 'string' },
          },
          required: ['question'],
        },
      },
    ]),
    notifyBeforeAgentStart: vi.fn(async () => {}),
    notifyMemoryWrites: vi.fn(async () => {}),
    notifyTurnComplete: vi.fn(async () => {}),
    notifyAgentEnd: vi.fn(async () => {}),
    handleSessionReset: vi.fn(async () => {}),
    handleInboundWebhook: vi.fn(async () => false),
    notifySessionStart: vi.fn(async () => {}),
    listPluginSummary: vi.fn(() => []),
    hasMiddleware: vi.fn(() => false),
    applyMiddleware: vi.fn(async () => ({
      userContent: '',
      resultText: '',
      blocked: false,
      events: [],
    })),
    hasOutputGuards: vi.fn(() => false),
    applyOutputGuards: vi.fn(async (context: { resultText: string }) => ({
      resultText: context.resultText,
      blocked: false,
      events: [],
    })),
  };
  return {
    runAgentMock: vi.fn(),
    ensurePluginManagerInitializedMock: vi.fn(async () => pluginManager),
    reloadPluginManagerMock: vi.fn(async () => pluginManager),
    shutdownPluginManagerMock: vi.fn(async () => {}),
    setPluginInboundMessageDispatcherMock: vi.fn(),
    checkPluginMock: vi.fn(async (pluginId: string) => ({
      pluginId,
      pluginDir: `/tmp/.hybridclaw/plugins/${pluginId}`,
      source: 'home' as const,
      requiresEnv: ['DEMO_PLUGIN_TOKEN'],
      missingEnv: [],
      requiredConfigKeys: ['workspaceId'],
      packageJsonDependencies: [
        { package: '@scope/demo-plugin', installed: true },
      ],
      nodeDependencies: [],
      pipDependencies: [],
      externalDependencies: [],
      configuredRequiredBins: [],
    })),
    formatDependencyPlanDetailsMock: vi.fn(() => 'npm packages: demo'),
    installPluginMock: vi.fn(async (source: string) => ({
      pluginId: 'demo-plugin',
      pluginDir: '/tmp/.hybridclaw/plugins/demo-plugin',
      source,
      alreadyInstalled: false,
      dependenciesInstalled: true,
      dependencySummary: {
        usedPackageJson: true,
        installedNodePackages: [],
        installedPipPackages: [],
      },
      configuredRequiredBins: [],
      externalDependencies: [],
      requiresEnv: ['DEMO_PLUGIN_TOKEN'],
      requiredConfigKeys: ['workspaceId'],
    })),
    listInstallablePluginsMock: vi.fn(() => []),
    readPluginConfigEntryMock: vi.fn((pluginId: string) => ({
      pluginId,
      configPath: '/tmp/config.json',
      entry: {
        id: pluginId,
        enabled: true,
        config: {
          searchMode: 'query',
        },
      },
    })),
    readPluginConfigValueMock: vi.fn((pluginId: string, key: string) => ({
      pluginId,
      key,
      value: 'query',
      configPath: '/tmp/config.json',
      entry: {
        id: pluginId,
        enabled: true,
        config: {
          [key]: 'query',
        },
      },
    })),
    reinstallPluginMock: vi.fn(async (source: string) => ({
      pluginId: 'demo-plugin',
      pluginDir: '/tmp/.hybridclaw/plugins/demo-plugin',
      source,
      alreadyInstalled: false,
      replacedExistingInstall: true,
      dependenciesInstalled: true,
      dependencySummary: {
        usedPackageJson: true,
        installedNodePackages: [],
        installedPipPackages: [],
      },
      configuredRequiredBins: [],
      externalDependencies: [],
      requiresEnv: ['DEMO_PLUGIN_TOKEN'],
      requiredConfigKeys: ['workspaceId'],
    })),
    pluginDependencyApprovalRequiredError: class PluginDependencyApprovalRequiredError extends Error {
      readonly plan: {
        usesPackageJson: boolean;
        nodePackages: string[];
        pipPackages: string[];
      };

      constructor(plan: {
        usesPackageJson: boolean;
        nodePackages: string[];
        pipPackages: string[];
      }) {
        super('Plugin dependency installation requires explicit approval.');
        this.plan = plan;
      }
    },
    uninstallPluginMock: vi.fn(async () => ({
      pluginId: 'demo-plugin',
      pluginDir: '/tmp/.hybridclaw/plugins/demo-plugin',
      removedPluginDir: true,
      removedConfigOverrides: 1,
    })),
    setPluginEnabledMock: vi.fn(async (pluginId: string, enabled: boolean) => ({
      pluginId,
      enabled,
      changed: true,
      configPath: '/tmp/config.json',
      entry: enabled
        ? null
        : {
            id: pluginId,
            enabled: false,
            config: {},
          },
    })),
    unsetPluginConfigValueMock: vi.fn(
      async (pluginId: string, key: string) => ({
        pluginId,
        key,
        value: undefined,
        changed: true,
        removed: true,
        configPath: '/tmp/config.json',
        entry: null,
      }),
    ),
    writePluginConfigValueMock: vi.fn(
      async (pluginId: string, key: string, rawValue: string) => ({
        pluginId,
        key,
        value: rawValue,
        changed: true,
        removed: false,
        configPath: '/tmp/config.json',
        entry: {
          id: pluginId,
          enabled: true,
          config: {
            [key]: rawValue,
          },
        },
      }),
    ),
    pluginManagerMock: pluginManager,
  };
});

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/plugins/plugin-manager.js', () => ({
  ensurePluginManagerInitialized: ensurePluginManagerInitializedMock,
  reloadPluginManager: reloadPluginManagerMock,
  shutdownPluginManager: shutdownPluginManagerMock,
  setPluginInboundMessageDispatcher: setPluginInboundMessageDispatcherMock,
}));

vi.mock('../src/plugins/plugin-install.js', () => ({
  checkPlugin: checkPluginMock,
  formatDependencyPlanDetails: formatDependencyPlanDetailsMock,
  installPlugin: installPluginMock,
  listInstallablePlugins: listInstallablePluginsMock,
  PluginDependencyApprovalRequiredError: pluginDependencyApprovalRequiredError,
  reinstallPlugin: reinstallPluginMock,
  uninstallPlugin: uninstallPluginMock,
}));

vi.mock('../src/plugins/plugin-config.js', () => ({
  readPluginConfigEntry: readPluginConfigEntryMock,
  readPluginConfigValue: readPluginConfigValueMock,
  setPluginEnabled: setPluginEnabledMock,
  unsetPluginConfigValue: unsetPluginConfigValueMock,
  writePluginConfigValue: writePluginConfigValueMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-plugins-',
  cleanup: () => {
    runAgentMock.mockReset();
    ensurePluginManagerInitializedMock.mockClear();
    reloadPluginManagerMock.mockClear();
    setPluginInboundMessageDispatcherMock.mockClear();
    pluginManagerMock.collectPromptContextDetails.mockClear();
    pluginManagerMock.collectPromptContext.mockClear();
    pluginManagerMock.getMemoryLayerBehavior.mockClear();
    pluginManagerMock.getToolDefinitions.mockClear();
    pluginManagerMock.handleInboundWebhook.mockClear();
    pluginManagerMock.notifyBeforeAgentStart.mockClear();
    pluginManagerMock.notifyMemoryWrites.mockClear();
    pluginManagerMock.notifyTurnComplete.mockClear();
    pluginManagerMock.notifyAgentEnd.mockClear();
    pluginManagerMock.handleSessionReset.mockClear();
    pluginManagerMock.notifySessionStart.mockClear();
    pluginManagerMock.listPluginSummary.mockClear();
    pluginManagerMock.findCommand.mockClear();
    pluginManagerMock.hasMiddleware.mockClear();
    pluginManagerMock.applyMiddleware.mockClear();
    pluginManagerMock.hasOutputGuards.mockClear();
    pluginManagerMock.applyOutputGuards.mockClear();
    shutdownPluginManagerMock.mockClear();
    checkPluginMock.mockClear();
    formatDependencyPlanDetailsMock.mockClear();
    installPluginMock.mockClear();
    listInstallablePluginsMock.mockClear();
    readPluginConfigEntryMock.mockClear();
    readPluginConfigValueMock.mockClear();
    reinstallPluginMock.mockClear();
    setPluginEnabledMock.mockClear();
    unsetPluginConfigValueMock.mockClear();
    uninstallPluginMock.mockClear();
    writePluginConfigValueMock.mockClear();
  },
});

function makeWebhookRequest(params: {
  method?: string;
  url: string;
}): import('node:http').IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: params.method || 'POST',
    url: params.url,
    headers: {},
    socket: {
      remoteAddress: '127.0.0.1',
    },
  }) as import('node:http').IncomingMessage;
}

function makeWebhookResponse(): import('node:http').ServerResponse & {
  body: string;
  headers: Record<string, string>;
  writableEnded: boolean;
  headersSent: boolean;
} {
  const headers: Record<string, string> = {};
  const response = {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    body: '',
    headers,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(chunk?: unknown) {
      if (chunk != null) {
        response.body += Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk);
      }
      response.writableEnded = true;
      response.headersSent = true;
    },
  };
  return response as unknown as import('node:http').ServerResponse & {
    body: string;
    headers: Record<string, string>;
    writableEnded: boolean;
    headersSent: boolean;
  };
}

test('handleGatewayMessage passes explicit skill middleware manifest into middleware context', async () => {
  setupHome();

  pluginManagerMock.hasMiddleware
    .mockImplementationOnce((phase) => phase === 'pre_send')
    .mockImplementationOnce((phase) => phase === 'pre_send');
  pluginManagerMock.applyMiddleware.mockImplementationOnce(
    async (_phase, context) => ({
      userContent: context.userContent,
      resultText: '',
      blocked: false,
      events: [],
    }),
  );
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'agent result',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayMessage({
    sessionId: 'session-brand-voice-middleware-context',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    content: '/skill brand-voice draft the announcement',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(pluginManagerMock.applyMiddleware).toHaveBeenCalledWith(
    'pre_send',
    expect.objectContaining({
      skill: {
        name: 'brand-voice',
        middleware: {
          preSend: false,
          postReceive: true,
        },
      },
    }),
  );
});

test('handleGatewayMessage stores blocked routing middleware content', async () => {
  setupHome();

  pluginManagerMock.hasMiddleware.mockImplementationOnce(
    (phase) => phase === 'routing',
  );
  pluginManagerMock.applyMiddleware.mockResolvedValueOnce({
    userContent: 'rewritten blocked request',
    resultText: 'blocked by router',
    blocked: true,
    events: [
      {
        skillId: 'router',
        phase: 'routing',
        action: 'block',
        metadata: {
          conciergeRouter: {
            effectiveUserTurnContent: 'rewritten blocked request',
            media: [
              {
                path: '/tmp/rewritten.pdf',
                url: 'https://example.com/rewritten.pdf',
                originalUrl: 'https://example.com/rewritten.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 2048,
                filename: 'rewritten.pdf',
              },
            ],
          },
        },
      },
    ],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');

  initDatabase({ quiet: true });

  const result = await handleGatewayMessage({
    sessionId: 'session-routing-blocked-content',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    content: 'original request',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(result.result).toBe('blocked by router');
  expect(runAgentMock).not.toHaveBeenCalled();
  const history = memoryService.getConversationHistory(
    'session-routing-blocked-content',
    10,
  );
  expect(
    history.some((message) =>
      message.content.includes('rewritten blocked request'),
    ),
  ).toBe(true);
  expect(
    history.some((message) => message.content.includes('rewritten.pdf')),
  ).toBe(true);
});

test('handleGatewayMessage injects plugin prompt context and forwards plugin tools to the agent', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'plugin-aware reply',
    toolsUsed: ['memory_lookup'],
    toolExecutions: [
      {
        name: 'memory_lookup',
        arguments: '{"question":"what matters?"}',
        result: 'long-term summary',
        durationMs: 12,
      },
    ],
  });

  const result = await handleGatewayMessage({
    sessionId: 'session-plugin-test',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    content: 'What do you remember about me?',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(result.pluginsUsed).toEqual(['qmd-memory']);
  expect(pluginManagerMock.collectPromptContextDetails).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-plugin-test',
      userId: 'user-42',
      agentId: 'main',
      recentMessages: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'What do you remember about me?',
        }),
      ]),
    }),
  );
  expect(runAgentMock).toHaveBeenCalledWith(
    expect.objectContaining({
      pluginTools: [
        expect.objectContaining({
          name: 'memory_lookup',
        }),
      ],
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('plugin-memory-context'),
        }),
      ]),
    }),
  );
  expect(pluginManagerMock.notifyBeforeAgentStart).toHaveBeenCalled();
  expect(pluginManagerMock.notifyTurnComplete).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-plugin-test',
      userId: 'user-42',
      agentId: 'main',
      messages: [
        expect.objectContaining({
          role: 'user',
          content: 'What do you remember about me?',
        }),
        expect.objectContaining({
          role: 'assistant',
          content: 'plugin-aware reply',
        }),
      ],
    }),
  );
  expect(pluginManagerMock.notifyAgentEnd).toHaveBeenCalledWith(
    expect.objectContaining({
      resultText: 'plugin-aware reply',
      toolNames: ['memory_lookup'],
    }),
  );
});

test('handleGatewayMessage forwards successful native memory writes to plugins', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Saved that memory.',
    toolsUsed: ['memory'],
    toolExecutions: [
      {
        name: 'memory',
        arguments:
          '{"action":"append","file_path":"memory/2026-04-08.md","content":"Remember Clerk reduced auth integration time."}',
        result: 'Appended 45 chars to memory/2026-04-08.md',
        durationMs: 15,
      },
    ],
  });

  await handleGatewayMessage({
    sessionId: 'session-plugin-memory-write',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    content: 'Please save the auth migration reason.',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(pluginManagerMock.notifyMemoryWrites).toHaveBeenCalledWith({
    sessionId: 'session-plugin-memory-write',
    agentId: 'main',
    channelId: 'web',
    toolExecutions: [
      expect.objectContaining({
        name: 'memory',
        result: 'Appended 45 chars to memory/2026-04-08.md',
      }),
    ],
  });
  expect(
    pluginManagerMock.notifyMemoryWrites.mock.invocationCallOrder[0],
  ).toBeLessThan(pluginManagerMock.notifyAgentEnd.mock.invocationCallOrder[0]);
});

test('handleGatewayMessage suppresses unguarded text streaming when output guards are active', async () => {
  setupHome();

  pluginManagerMock.hasOutputGuards.mockReturnValue(true);
  pluginManagerMock.applyOutputGuards.mockResolvedValueOnce({
    resultText: 'guarded reply',
    blocked: false,
    events: [
      {
        pluginId: 'output-guard',
        guardId: 'output-guard',
        action: 'rewrite',
        before: 'raw reply',
        after: 'guarded reply',
      },
    ],
  });
  runAgentMock.mockImplementation(async (params: { onTextDelta?: unknown }) => {
    expect(params.onTextDelta).toBeUndefined();
    return {
      status: 'success',
      result: 'raw reply',
      toolsUsed: [],
      toolExecutions: [],
    };
  });

  const streamed: string[] = [];
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  const result = await handleGatewayMessage({
    sessionId: 'session-output-guard-streaming',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    content: 'hi',
    model: 'test-model',
    chatbotId: 'bot-1',
    onTextDelta: (delta) => streamed.push(delta),
  });

  expect(result.status).toBe('success');
  expect(result.result).toBe('guarded reply');
  expect(streamed).toEqual([]);
  expect(pluginManagerMock.applyOutputGuards).toHaveBeenCalledWith(
    expect.objectContaining({
      resultText: 'raw reply',
    }),
  );
});

test('handleGatewayMessage lets a plugin memory layer replace built-in memory', async () => {
  setupHome();

  pluginManagerMock.getMemoryLayerBehavior.mockResolvedValueOnce({
    replacesBuiltInMemory: true,
  });
  pluginManagerMock.collectPromptContextDetails.mockResolvedValueOnce({
    sections: ['mempalace-memory-context'],
    pluginIds: ['mempalace-memory'],
    replacesBuiltInMemory: true,
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  const buildPromptMemorySpy = vi.spyOn(
    memoryService,
    'buildPromptMemoryContext',
  );
  const storeTurnSpy = vi.spyOn(memoryService, 'storeTurn');
  const appendCanonicalSpy = vi.spyOn(memoryService, 'appendCanonicalMessages');
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'replacement-aware reply',
    toolsUsed: [],
    toolExecutions: [],
  });

  const sessionId = 'session-plugin-replacement';
  const result = await handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    content: 'What should you remember about the auth migration?',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(result.pluginsUsed).toEqual(['mempalace-memory']);
  expect(buildPromptMemorySpy).not.toHaveBeenCalled();
  expect(storeTurnSpy).not.toHaveBeenCalled();
  expect(appendCanonicalSpy).not.toHaveBeenCalled();

  const systemMessage = (
    runAgentMock.mock.calls[0]?.[0] as
      | { messages?: Array<{ role: string; content: string }> }
      | undefined
  )?.messages?.find((message) => message.role === 'system');
  const dynamicContextMessage = (
    runAgentMock.mock.calls[0]?.[0] as
      | { messages?: Array<{ role: string; content: string }> }
      | undefined
  )?.messages?.find(
    (message) =>
      message.role === 'user' &&
      message.content.includes('mempalace-memory-context'),
  );
  expect(systemMessage?.content).not.toContain('## Session Summary');
  expect(systemMessage?.content).not.toContain('mempalace-memory-context');
  expect(systemMessage?.content).not.toContain('## Retrieved Context');
  expect(dynamicContextMessage?.content).toContain('## Session Summary');
  expect(dynamicContextMessage?.content).toContain('mempalace-memory-context');
  expect(dynamicContextMessage?.content).not.toContain('## Retrieved Context');

  const history = memoryService.getConversationHistory(sessionId, 10);
  expect(history.map((message) => message.role)).toEqual(['assistant', 'user']);

  const canonicalContext = memoryService.getCanonicalContext({
    agentId: 'main',
    userId: 'user-42',
    windowSize: 12,
    excludeSessionId: sessionId,
  });
  expect(canonicalContext).toEqual({
    summary: null,
    recent_messages: [],
  });
});

test('handleGatewayMessage continues without plugins when plugin manager init fails', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  ensurePluginManagerInitializedMock.mockRejectedValueOnce(
    new Error('plugin init failed'),
  );
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'pluginless reply',
    toolsUsed: [],
    toolExecutions: [],
  });

  const result = await handleGatewayMessage({
    sessionId: 'session-pluginless-test',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    content: 'Still answer even if plugins explode.',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');
  expect(result.result).toBe('pluginless reply');
  expect(result.pluginsUsed).toEqual([]);
  expect(pluginManagerMock.collectPromptContextDetails).not.toHaveBeenCalled();
  expect(pluginManagerMock.notifyBeforeAgentStart).not.toHaveBeenCalled();
  expect(runAgentMock).toHaveBeenCalledWith(
    expect.objectContaining({
      pluginTools: [],
    }),
  );
});

test('handleGatewayPluginWebhook returns a generic 503 when plugin manager init fails', async () => {
  setupHome();

  const { handleGatewayPluginWebhook } = await import(
    '../src/gateway/gateway-plugin-service.ts'
  );

  ensurePluginManagerInitializedMock.mockRejectedValueOnce(
    new Error('plugin load exploded at /tmp/private-path'),
  );
  const req = makeWebhookRequest({
    method: 'POST',
    url: '/api/plugin-webhooks/demo-plugin/email-inbound',
  });
  const res = makeWebhookResponse();

  await handleGatewayPluginWebhook(
    req,
    res,
    new URL('http://localhost/api/plugin-webhooks/demo-plugin/email-inbound'),
  );

  expect(res.statusCode).toBe(503);
  expect(res.body).toContain('Plugin manager unavailable.');
  expect(res.body).not.toContain('/tmp/private-path');
});

test('handleGatewayCommand lists plugin summaries', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  pluginManagerMock.listPluginSummary.mockReturnValue([
    {
      id: 'demo-plugin',
      name: 'Demo Plugin',
      version: '1.0.0',
      description: 'Demo plugin for testing',
      source: 'project',
      enabled: true,
      commands: ['demo_status'],
      tools: ['demo_echo'],
      hooks: ['demo-hook'],
    },
    {
      id: 'broken-plugin',
      source: 'home',
      enabled: true,
      error: 'register exploded',
      commands: [],
      tools: [],
      hooks: [],
    },
  ]);
  listInstallablePluginsMock.mockReturnValue([
    {
      id: 'demo-plugin',
      name: 'Demo Plugin',
      version: '1.0.0',
      description: 'Already installed',
      source: 'project',
      dir: '/tmp/project/plugins/demo-plugin',
      installSource: 'demo-plugin',
    },
    {
      id: 'available-plugin',
      name: 'Available Plugin',
      version: '0.1.0',
      description: 'Available plugin for testing',
      source: 'bundled',
      dir: '/tmp/package/plugins/available-plugin',
      installSource: 'available-plugin',
    },
  ]);

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-list',
    guildId: null,
    channelId: 'web',
    args: ['plugin', 'list'],
  });

  expect(pluginManagerMock.listPluginSummary).toHaveBeenCalled();
  expect(listInstallablePluginsMock).toHaveBeenCalled();
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugins');
  expect(result.text).toContain('Installed\n');
  expect(result.text).toContain('demo-plugin v1.0.0 [project]');
  expect(result.text).toContain('description: Demo plugin for testing');
  expect(result.text).toContain('commands: /demo_status');
  expect(result.text).toContain('tools: demo_echo');
  expect(result.text).toContain('broken-plugin [home]');
  expect(result.text).toContain('error: register exploded');
  expect(result.text).toContain('Available\n');
  expect(result.text).toContain('available-plugin v0.1.0 [bundled]');
  expect(result.text).toContain('description: Available plugin for testing');
  expect(result.text).toContain('install: /plugin install available-plugin');
  expect(result.text).not.toContain('description: Already installed');
});

test('handleGatewayCommand filters plugin list to available plugins', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  pluginManagerMock.listPluginSummary.mockReturnValue([
    {
      id: 'demo-plugin',
      source: 'home',
      enabled: true,
      commands: [],
      tools: [],
      hooks: [],
    },
  ]);
  listInstallablePluginsMock.mockReturnValue([
    {
      id: 'demo-plugin',
      source: 'project',
      dir: '/tmp/project/plugins/demo-plugin',
      installSource: 'demo-plugin',
    },
    {
      id: 'available-plugin',
      source: 'bundled',
      dir: '/tmp/package/plugins/available-plugin',
      installSource: 'available-plugin',
    },
  ]);

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-list-available',
    guildId: null,
    channelId: 'web',
    args: ['plugin', 'list', 'available'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain('available-plugin [bundled]');
  expect(result.text).toContain('install: /plugin install available-plugin');
  expect(result.text).not.toContain('demo-plugin [home]');
});

test('handleGatewayCommand shows plugin config overrides', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-config-show',
    guildId: null,
    channelId: 'web',
    args: ['plugin', 'config', 'qmd-memory'],
  });

  expect(readPluginConfigEntryMock).toHaveBeenCalledWith('qmd-memory');
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Config');
  expect(result.text).toContain('Plugin: qmd-memory');
  expect(result.text).toContain('Config file: /tmp/config.json');
  expect(result.text).toContain('"searchMode": "query"');
});

test('handleGatewayCommand updates plugin config from a local TUI/web session and reloads plugins', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  pluginManagerMock.listPluginSummary.mockReturnValueOnce([
    {
      id: 'qmd-memory',
      source: 'home',
      enabled: true,
      commands: [],
      tools: [],
      hooks: [],
    },
  ]);

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-config-set',
    guildId: null,
    channelId: 'tui',
    args: ['plugin', 'config', 'qmd-memory', 'searchMode', 'query'],
  });

  expect(writePluginConfigValueMock).toHaveBeenCalledWith(
    'qmd-memory',
    'searchMode',
    'query',
  );
  expect(reloadPluginManagerMock).toHaveBeenCalled();
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Config Updated');
  expect(result.text).toContain('Plugin: qmd-memory');
  expect(result.text).toContain('Key: searchMode');
  expect(result.text).toContain('Value: "query"');
  expect(result.text).toContain('Plugin runtime reloaded.');
});

test('handleGatewayCommand disables a plugin from a local TUI/web session and reloads plugins', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-disable',
    guildId: null,
    channelId: 'tui',
    args: ['plugin', 'disable', 'qmd-memory'],
  });

  expect(setPluginEnabledMock).toHaveBeenCalledWith('qmd-memory', false);
  expect(reloadPluginManagerMock).toHaveBeenCalled();
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Disabled');
  expect(result.text).toContain('Plugin: qmd-memory');
  expect(result.text).toContain('Status: disabled');
  expect(result.text).toContain('Plugin runtime reloaded.');
});

test('handleGatewayCommand reports rollback reload failures when disabling a plugin', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { logger } = await import('../src/logger.js');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  pluginManagerMock.listPluginSummary.mockReturnValueOnce([
    {
      id: 'qmd-memory',
      source: 'home',
      enabled: true,
      commands: [],
      tools: [],
      hooks: [],
    },
  ]);
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  reloadPluginManagerMock
    .mockRejectedValueOnce(new Error('reload exploded'))
    .mockRejectedValueOnce(new Error('rollback reload exploded'));

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-disable-rollback-failed',
    guildId: null,
    channelId: 'tui',
    args: ['plugin', 'disable', 'qmd-memory'],
  });

  expect(setPluginEnabledMock).toHaveBeenCalledWith('qmd-memory', false);
  expect(reloadPluginManagerMock).toHaveBeenCalledTimes(2);
  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Disable Failed');
  expect(result.text).toContain(
    'Updated runtime config at `/tmp/config.json`, but plugin reload failed.',
  );
  expect(result.text).toContain('Previous runtime config was restored.');
  expect(result.text).toContain(
    'Plugin runtime reload also failed after rollback; plugin state may be inconsistent until the next successful reload.',
  );
  expect(result.text).toContain(
    'Plugin runtime reload failed: rollback reload exploded.',
  );
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'plugin disable',
      pluginId: 'qmd-memory',
      reloadMessage: 'Plugin runtime reload failed: reload exploded.',
      rollbackReloadMessage:
        'Plugin runtime reload failed: rollback reload exploded.',
    }),
    'Plugin runtime rollback reload failed',
  );
});

test('handleGatewayCommand rejects enable for undiscovered plugins', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  pluginManagerMock.listPluginSummary.mockReturnValueOnce([
    {
      id: 'concierge-router',
      source: 'project',
      enabled: true,
      commands: ['concierge'],
      tools: [],
      hooks: [],
    },
  ]);

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-enable-missing',
    guildId: null,
    channelId: 'tui',
    args: ['plugin', 'enable', 'concierge-routing'],
  });

  expect(setPluginEnabledMock).not.toHaveBeenCalled();
  expect(reloadPluginManagerMock).not.toHaveBeenCalled();
  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Not Found');
  expect(result.text).toContain(
    'No discovered plugin has id `concierge-routing`.',
  );
  expect(result.text).toContain(
    'Install it first with `/plugin install <path|plugin-id|npm-spec>`.',
  );
});

test('handleGatewayCommand rejects plugin disable outside local TUI/web sessions', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-disable-remote',
    guildId: 'guild-1',
    channelId: 'discord-channel-1',
    args: ['plugin', 'disable', 'qmd-memory'],
  });

  expect(setPluginEnabledMock).not.toHaveBeenCalled();
  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Disable Restricted');
  expect(result.text).toContain('only available from local TUI/web sessions');
});

test('handleGatewayCommand installs a plugin from a local TUI/web session and reloads plugins', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-install',
    guildId: null,
    channelId: 'tui',
    args: ['plugin', 'install', './plugins/qmd-memory', '--yes'],
  });

  expect(installPluginMock).toHaveBeenCalledWith('./plugins/qmd-memory', {
    approveDependencyInstall: true,
    onDependenciesAlreadySatisfied: expect.any(Function),
  });
  expect(reloadPluginManagerMock).toHaveBeenCalled();
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Installed');
  expect(result.text).toContain(
    'Installed plugin `demo-plugin` to `/tmp/.hybridclaw/plugins/demo-plugin`.',
  );
  expect(result.text).toContain(
    'Installed plugin Node.js dependencies from package.json.',
  );
  expect(result.text).toContain('Required runtime secrets: DEMO_PLUGIN_TOKEN');
  expect(result.text).toContain('required config keys: workspaceId');
  expect(result.text).toContain('Plugin runtime reloaded.');
});

test('handleGatewayCommand reports missing binary guidance after plugin install', async () => {
  setupHome();
  installPluginMock.mockResolvedValueOnce({
    pluginId: 'mempalace-memory',
    pluginDir: '/tmp/.hybridclaw/plugins/mempalace-memory',
    source: './plugins/mempalace-memory',
    alreadyInstalled: false,
    dependenciesInstalled: true,
    dependencySummary: {
      usedPackageJson: false,
      installedNodePackages: [],
      installedPipPackages: ['mempalace'],
    },
    configuredRequiredBins: [],
    externalDependencies: [],
    requiresEnv: [],
    requiredConfigKeys: [],
    missingRequiredBins: [
      {
        name: 'mempalace',
        command: 'mempalace',
        configKey: 'command',
        installHint: 'pip install mempalace',
        installUrl: 'https://github.com/milla-jovovich/mempalace',
      },
    ],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-install-mempalace',
    guildId: null,
    channelId: 'tui',
    args: ['plugin', 'install', './plugins/mempalace-memory', '--yes'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain(
    'Missing required binaries right now: mempalace.',
  );
  expect(result.text).toContain('Install mempalace: `pip install mempalace`');
  expect(result.text).toContain(
    'Install docs for mempalace: https://github.com/milla-jovovich/mempalace',
  );
  expect(result.text).toContain(
    'If mempalace is installed outside PATH, set it with: `/plugin config mempalace-memory command /absolute/path/to/mempalace`',
  );
  expect(result.text).toContain(
    'Until the missing binaries are installed, the plugin will remain unavailable.',
  );
});

test('handleGatewayCommand rejects plugin install outside local TUI/web sessions', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-install-remote',
    guildId: 'guild-1',
    channelId: 'discord-channel-1',
    args: ['plugin', 'install', './plugins/qmd-memory'],
  });

  expect(installPluginMock).not.toHaveBeenCalled();
  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Install Restricted');
  expect(result.text).toContain('only available from local TUI/web sessions');
});

test('handleGatewayCommand requires explicit approval before installing plugin dependencies', async () => {
  setupHome();
  installPluginMock.mockRejectedValueOnce(
    new pluginDependencyApprovalRequiredError({
      usesPackageJson: false,
      nodePackages: [],
      pipPackages: ['mempalace'],
    }),
  );

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-install-approval',
    guildId: null,
    channelId: 'tui',
    userId: 'local-user',
    args: ['plugin', 'install', './plugins/mempalace-memory'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Pending Approval');
  expect(result.text).toContain(
    'I need your approval before I install Python packages for plugin `./plugins/mempalace-memory`: mempalace.',
  );
  expect(result.text).toContain('Approval ID:');
  expect(result.text).toContain(
    'Reply `yes for session` to trust this action for this session.',
  );
  expect(result.text).not.toContain('Node.js dependency state');
});

test('handleTextChannelApprovalCommand approves a pending plugin dependency install', async () => {
  setupHome();
  installPluginMock
    .mockRejectedValueOnce(
      new pluginDependencyApprovalRequiredError({
        usesPackageJson: false,
        nodePackages: [],
        pipPackages: ['mempalace'],
      }),
    )
    .mockRejectedValueOnce(
      new pluginDependencyApprovalRequiredError({
        usesPackageJson: false,
        nodePackages: [],
        pipPackages: ['mempalace'],
      }),
    )
    .mockResolvedValueOnce({
      pluginId: 'mempalace-memory',
      pluginDir: '/tmp/.hybridclaw/plugins/mempalace-memory',
      source: './plugins/mempalace-memory',
      alreadyInstalled: false,
      dependenciesInstalled: true,
      dependencySummary: {
        usedPackageJson: false,
        installedNodePackages: [],
        installedPipPackages: ['mempalace'],
      },
      configuredRequiredBins: [],
      externalDependencies: [],
      requiresEnv: [],
      requiredConfigKeys: [],
    });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { handleTextChannelApprovalCommand } = await import(
    '../src/gateway/text-channel-commands.ts'
  );

  initDatabase({ quiet: true });

  const approval = await handleGatewayCommand({
    sessionId: 'session-plugin-install-approve-flow',
    guildId: null,
    channelId: 'tui',
    userId: 'local-user',
    username: 'local-user',
    args: ['plugin', 'install', './plugins/mempalace-memory'],
  });

  expect(approval.kind).toBe('info');

  const handled = await handleTextChannelApprovalCommand({
    sessionId: 'session-plugin-install-approve-flow',
    guildId: null,
    channelId: 'tui',
    userId: 'local-user',
    username: 'local-user',
    args: ['approve', 'yes'],
  });

  expect(handled).not.toBeNull();
  expect(installPluginMock).toHaveBeenNthCalledWith(
    3,
    './plugins/mempalace-memory',
    { approveDependencyInstall: true },
  );
  expect(handled?.text).toContain('Plugin Installed');
  expect(handled?.text).toContain('Installed plugin `mempalace-memory`');
});

test('handleTextChannelApprovalCommand approves npm for the session before prompting separately for pip', async () => {
  setupHome();
  installPluginMock
    .mockRejectedValueOnce(
      new pluginDependencyApprovalRequiredError({
        usesPackageJson: true,
        nodePackages: [],
        pipPackages: ['mempalace'],
      }),
    )
    .mockRejectedValueOnce(
      new pluginDependencyApprovalRequiredError({
        usesPackageJson: true,
        nodePackages: [],
        pipPackages: ['mempalace'],
      }),
    )
    .mockRejectedValueOnce(
      new pluginDependencyApprovalRequiredError({
        usesPackageJson: true,
        nodePackages: [],
        pipPackages: ['mempalace'],
      }),
    )
    .mockResolvedValueOnce({
      pluginId: 'mempalace-memory',
      pluginDir: '/tmp/.hybridclaw/plugins/mempalace-memory',
      source: './plugins/mempalace-memory',
      alreadyInstalled: false,
      dependenciesInstalled: true,
      dependencySummary: {
        usedPackageJson: true,
        installedNodePackages: [],
        installedPipPackages: ['mempalace'],
      },
      configuredRequiredBins: [],
      externalDependencies: [],
      requiresEnv: [],
      requiredConfigKeys: [],
    });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { handleTextChannelApprovalCommand } = await import(
    '../src/gateway/text-channel-commands.ts'
  );

  initDatabase({ quiet: true });

  const initialApproval = await handleGatewayCommand({
    sessionId: 'session-plugin-install-two-step',
    guildId: null,
    channelId: 'tui',
    userId: 'local-user',
    username: 'local-user',
    args: ['plugin', 'install', './plugins/mempalace-memory'],
  });
  expect(initialApproval.kind).toBe('info');

  const pipApproval = await handleTextChannelApprovalCommand({
    sessionId: 'session-plugin-install-two-step',
    guildId: null,
    channelId: 'tui',
    userId: 'local-user',
    username: 'local-user',
    args: ['approve', 'session'],
  });

  expect(pipApproval).not.toBeNull();
  expect(pipApproval?.text).toContain(
    'I need your approval before I install Python packages for plugin',
  );
  expect(pipApproval?.text).toContain('mempalace');

  const installed = await handleTextChannelApprovalCommand({
    sessionId: 'session-plugin-install-two-step',
    guildId: null,
    channelId: 'tui',
    userId: 'local-user',
    username: 'local-user',
    args: ['approve', 'yes'],
  });

  expect(installed?.text).toContain('Plugin Installed');
  expect(installPluginMock).toHaveBeenNthCalledWith(
    4,
    './plugins/mempalace-memory',
    { approveDependencyInstall: true },
  );
});

test('handleGatewayCommand reports plugin install failures', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  installPluginMock.mockRejectedValueOnce(new Error('plugin path not found'));

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-install-failed',
    guildId: null,
    channelId: 'web',
    args: ['plugin', 'install', './plugins/missing-plugin'],
  });

  expect(result.kind).toBe('error');
  if (result.kind !== 'error') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Install Failed');
  expect(result.text).toBe('plugin path not found');
});

test('handleGatewayCommand reinstalls a plugin from a local TUI/web session and reloads plugins', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-reinstall',
    guildId: null,
    channelId: 'tui',
    args: ['plugin', 'reinstall', './plugins/qmd-memory', '--yes'],
  });

  expect(reinstallPluginMock).toHaveBeenCalledWith('./plugins/qmd-memory', {
    approveDependencyInstall: true,
    onDependenciesAlreadySatisfied: expect.any(Function),
  });
  expect(reloadPluginManagerMock).toHaveBeenCalled();
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Reinstalled');
  expect(result.text).toContain(
    'Reinstalled plugin `demo-plugin` to `/tmp/.hybridclaw/plugins/demo-plugin`.',
  );
  expect(result.text).toContain(
    'Installed plugin Node.js dependencies from package.json.',
  );
  expect(result.text).toContain('Plugin runtime reloaded.');
});

test('handleGatewayCommand checks one plugin from a local TUI/web session', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-check',
    guildId: null,
    channelId: 'tui',
    args: ['plugin', 'check', 'demo-plugin'],
  });

  expect(checkPluginMock).toHaveBeenCalledWith('demo-plugin');
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Check');
  expect(result.text).toContain('Plugin: demo-plugin');
  expect(result.text).toContain(
    'package.json dependencies: @scope/demo-plugin=ok',
  );
});

test('handleGatewayCommand dispatches plugin-registered commands', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const handler = vi.fn(async () => 'QMD index is ready.');
  pluginManagerMock.findCommand.mockReturnValue({
    name: 'qmd',
    description: 'Show QMD status',
    handler,
  });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-command',
    guildId: 'guild-123',
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    args: ['qmd', 'status'],
  });

  expect(pluginManagerMock.findCommand).toHaveBeenCalledWith('qmd');
  expect(handler).toHaveBeenCalledWith(['status'], {
    sessionId: 'session-plugin-command',
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    guildId: 'guild-123',
  });
  expect(result.kind).toBe('plain');
  expect(result.text).toBe('QMD index is ready.');
});

test('handleGatewayCommand stringifies non-string plugin command results', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const handler = vi.fn(async () => ({
    ok: true,
    message: 'structured payload',
  }));
  pluginManagerMock.findCommand.mockReturnValue({
    name: 'qmd',
    description: 'Show QMD status',
    handler,
  });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-command-object',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    args: ['qmd', 'status'],
  });

  expect(result.kind).toBe('plain');
  expect(result.text).toBe(
    JSON.stringify(
      {
        ok: true,
        message: 'structured payload',
      },
      null,
      2,
    ),
  );
});

test('handleGatewayCommand omits malformed plugin command decorations', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const handler = vi.fn(async () => ({
    kind: 'info',
    title: 'Plugin Result',
    text: 'structured payload',
    components: [{ type: 1, components: [{ custom_id: 'missing-type' }] }],
    modelCatalog: [{ value: 'gpt-5', label: 'GPT-5' }],
  }));
  pluginManagerMock.findCommand.mockReturnValue({
    name: 'qmd',
    description: 'Show QMD status',
    handler,
  });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-command-invalid-decoration',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    args: ['qmd', 'status'],
  });

  expect(result).toEqual(
    expect.objectContaining({
      kind: 'info',
      title: 'Plugin Result',
      text: 'structured payload',
    }),
  );
  expect(result.components).toBeUndefined();
  expect(result.modelCatalog).toBeUndefined();
});

test('handleGatewayCommand preserves valid plugin command decorations', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  const components = [{ type: 1, components: [{ type: 2, label: 'Run' }] }];
  const modelCatalog = [
    {
      value: 'gpt-5',
      label: 'GPT-5',
      isFree: false,
      recommended: true,
    },
  ];
  const handler = vi.fn(async () => ({
    kind: 'info',
    title: 'Plugin Result',
    text: 'structured payload',
    components,
    modelCatalog,
  }));
  pluginManagerMock.findCommand.mockReturnValue({
    name: 'qmd',
    description: 'Show QMD status',
    handler,
  });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-command-valid-decoration',
    guildId: null,
    channelId: 'web',
    userId: 'user-42',
    username: 'alice',
    args: ['qmd', 'status'],
  });

  expect(result.components).toEqual(components);
  expect(result.modelCatalog).toEqual(modelCatalog);
});

test('handleGatewayCommand help continues without plugins when plugin manager init fails', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  ensurePluginManagerInitializedMock.mockRejectedValueOnce(
    new Error('plugin init failed'),
  );

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-help',
    guildId: null,
    channelId: 'web',
    args: ['help'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('HybridClaw Commands');
  expect(result.text).toContain(
    '`/plugin [list [installed|available]|enable|disable|config|install|reinstall|reload|uninstall]`: Manage installed and available plugins',
  );
  expect(result.text).toContain(
    '`/auth status <provider>`: Show local provider auth and config status',
  );
  expect(result.text).toContain(
    '`/config [check|reload|get <key>|set <key> <value>]`: Show or update local runtime config',
  );
  expect(result.text).not.toContain(
    '`plugin config <plugin-id> [key] [value|--unset]`',
  );
  expect(result.text).not.toContain('`plugin enable <plugin-id>`');
  expect(result.text).not.toContain('`config check`');
  expect(result.text).not.toContain('`config reload`');
  expect(result.text).not.toContain('`config get <key>`');
  expect(result.text).not.toContain('`config set <key> <value>`');
  expect(result.text).not.toContain('`/exit`');
  expect(result.text).not.toContain('`/paste`');
});

test('handleGatewayCommand uninstalls a plugin and reloads the plugin manager', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-uninstall',
    guildId: null,
    channelId: 'web',
    args: ['plugin', 'uninstall', 'demo-plugin'],
  });

  expect(uninstallPluginMock).toHaveBeenCalledWith('demo-plugin');
  expect(shutdownPluginManagerMock).toHaveBeenCalled();
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugin Uninstalled');
  expect(result.text).toContain(
    'Uninstalled plugin `demo-plugin` from `/tmp/.hybridclaw/plugins/demo-plugin`.',
  );
  expect(result.text).toContain(
    'Removed 1 matching `plugins.list[]` override.',
  );
  expect(result.text).toContain('Plugin runtime will reload on the next turn.');
});

test('handleGatewayCommand reloads plugins without inlining the plugin list', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  pluginManagerMock.listPluginSummary.mockReturnValueOnce([
    {
      id: 'demo-plugin',
      name: 'Demo Plugin',
      version: '1.0.0',
      description: 'Demo plugin for testing',
      source: 'home',
      enabled: true,
      error: undefined,
      commands: ['demo_status'],
      tools: ['demo_tool'],
      hooks: [],
    },
  ]);

  const result = await handleGatewayCommand({
    sessionId: 'session-plugin-reload',
    guildId: null,
    channelId: 'web',
    args: ['plugin', 'reload'],
  });

  expect(reloadPluginManagerMock).toHaveBeenCalled();
  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Plugins Reloaded');
  expect(result.text).toBe('Plugin runtime reloaded.');
  expect(result.text).not.toContain('demo-plugin');
});

test('getGatewayAdminPlugins summarizes plugin status for the admin console', async () => {
  setupHome();

  const { getGatewayAdminPlugins } = await import(
    '../src/gateway/gateway-plugin-service.ts'
  );

  pluginManagerMock.listPluginSummary.mockReset();
  pluginManagerMock.listPluginSummary.mockReturnValue([
    {
      id: 'demo-plugin',
      name: 'Demo Plugin',
      version: '1.0.0',
      description: 'Demo plugin for testing',
      source: 'home',
      enabled: true,
      error: undefined,
      commands: ['demo_status'],
      tools: ['demo_tool'],
      hooks: ['gateway_start'],
    },
    {
      id: 'broken-plugin',
      name: 'Broken Plugin',
      version: undefined,
      description: undefined,
      source: 'project',
      enabled: false,
      error: 'Missing required env vars: DEMO_PLUGIN_TOKEN.',
      commands: [],
      tools: ['broken_tool'],
      hooks: [],
    },
  ]);

  const result = await getGatewayAdminPlugins();

  expect(ensurePluginManagerInitializedMock).toHaveBeenCalled();
  expect(result).toEqual({
    totals: {
      totalPlugins: 2,
      enabledPlugins: 1,
      failedPlugins: 1,
      commands: 1,
      tools: 2,
      hooks: 1,
    },
    plugins: [
      {
        id: 'broken-plugin',
        name: 'Broken Plugin',
        version: null,
        description: null,
        source: 'project',
        enabled: false,
        status: 'failed',
        error: 'Missing required env vars: DEMO_PLUGIN_TOKEN.',
        commands: [],
        tools: ['broken_tool'],
        hooks: [],
      },
      {
        id: 'demo-plugin',
        name: 'Demo Plugin',
        version: '1.0.0',
        description: 'Demo plugin for testing',
        source: 'home',
        enabled: true,
        status: 'loaded',
        error: null,
        commands: ['demo_status'],
        tools: ['demo_tool'],
        hooks: ['gateway_start'],
      },
    ],
  });
});

test('admin tools catalog excludes stale plugin tool executions when the plugin is not active', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { makeAuditRunId, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );

  initDatabase({ quiet: true });
  recordAuditEvent({
    sessionId: 'session-send-email',
    runId: makeAuditRunId('test'),
    event: {
      type: 'tool.result',
      toolName: 'send_email',
      isError: false,
      durationMs: 21,
    },
  });

  pluginManagerMock.getToolDefinitions.mockReturnValueOnce([
    {
      name: 'memory_lookup',
      description: 'Query plugin memory',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
        },
        required: ['question'],
      },
    },
  ]);

  const { getGatewayAdminTools } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await getGatewayAdminTools();
  const catalogNames = result.groups.flatMap((group) =>
    group.tools.map((tool) => tool.name),
  );

  expect(catalogNames).toContain('memory_lookup');
  expect(catalogNames).not.toContain('send_email');
  expect(result.groups).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        label: 'Plugins',
        tools: [
          expect.objectContaining({
            name: 'memory_lookup',
            kind: 'plugin',
          }),
        ],
      }),
    ]),
  );
  expect(result.recentExecutions[0]).toMatchObject({
    toolName: 'send_email',
    durationMs: 21,
  });
});
