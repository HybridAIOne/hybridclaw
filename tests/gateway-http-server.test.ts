import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, test, vi } from 'vitest';

const DEFAULT_WEB_SESSION_ID = 'agent:main:channel:web:chat:dm:peer:default';
const WEB_SESSION_ID_RE = /^agent:main:channel:web:chat:dm:peer:[a-f0-9]{16}$/;

const tempDirs: string[] = [];
const ORIGINAL_HYBRIDCLAW_AUTH_SECRET = process.env.HYBRIDCLAW_AUTH_SECRET;

function signAuthPayload(
  payload: Record<string, unknown>,
  secret: string,
): string {
  const payloadSegment = Buffer.from(JSON.stringify(payload)).toString(
    'base64url',
  );
  const signature = createHmac('sha256', secret)
    .update(payloadSegment)
    .digest('base64url');
  return `${payloadSegment}.${signature}`;
}

function makeTempDocsDir(options?: {
  includeMalformedFrontmatter?: boolean;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-health-'));
  const docsDir = path.join(root, 'docs');
  const developmentDocsDir = path.join(docsDir, 'development');
  const extensibilityDir = path.join(developmentDocsDir, 'extensibility');
  const guidesDir = path.join(developmentDocsDir, 'guides');
  const referenceDir = path.join(developmentDocsDir, 'reference');
  const consoleDistDir = path.join(root, 'console', 'dist');
  tempDirs.push(root);
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(developmentDocsDir, { recursive: true });
  fs.mkdirSync(extensibilityDir, { recursive: true });
  fs.mkdirSync(guidesDir, { recursive: true });
  fs.mkdirSync(referenceDir, { recursive: true });
  fs.mkdirSync(consoleDistDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'index.html'), '<h1>Docs</h1>', 'utf8');
  fs.writeFileSync(path.join(docsDir, 'chat.html'), '<h1>Chat</h1>', 'utf8');
  fs.writeFileSync(
    path.join(docsDir, 'agents.html'),
    '<h1>Agents</h1>',
    'utf8',
  );
  fs.writeFileSync(
    path.join(consoleDistDir, 'index.html'),
    '<h1>Admin</h1>',
    'utf8',
  );
  fs.mkdirSync(path.join(consoleDistDir, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(consoleDistDir, 'assets', 'app.js'),
    'console.log("admin")',
    'utf8',
  );
  fs.writeFileSync(
    path.join(developmentDocsDir, '_category_.json'),
    JSON.stringify({ label: 'Development', position: 1, collapsed: false }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(developmentDocsDir, 'README.md'),
    [
      '---',
      'title: Development Docs',
      'description: Development index page.',
      'sidebar_position: 1',
      '---',
      '',
      '# Development Docs',
      '',
      'Start with [Guides](./guides), [Reference](./reference), or [Extensibility](./extensibility).',
      '',
      '## Getting Started',
      '',
      'This section introduces the development docs.',
      '',
      '### First Steps',
      '',
      'Read the overview, then pick a subsystem.',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(guidesDir, 'README.md'),
    [
      '---',
      'title: Guides',
      'description: Workflow guides and practical walkthroughs.',
      'sidebar_position: 2',
      '---',
      '',
      '# Guides',
      '',
      'Browse the practical docs from here.',
      '',
      '## Tutorials',
      '',
      'Start with the main workflow walkthroughs.',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(guidesDir, 'heading-order.md'),
    [
      '---',
      'title: Heading Order',
      'description: Covers mixed heading depths.',
      'sidebar_position: 3',
      '---',
      '',
      '# Heading Order',
      '',
      '##### Deep internal heading',
      '',
      '## Repeated Section',
      '',
      'Visible content for the first section.',
      '',
      '## Repeated Section',
      '',
      'Visible content for the second section.',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(referenceDir, 'README.md'),
    [
      '---',
      'title: Reference',
      'description: Configuration and command reference.',
      'sidebar_position: 3',
      '---',
      '',
      '# Reference',
      '',
      'Look up commands, settings, and operational details.',
      '',
      '## Commands',
      '',
      'This section summarizes the CLI surface.',
      '',
    ].join('\n'),
    'utf8',
  );
  if (options?.includeMalformedFrontmatter) {
    fs.writeFileSync(
      path.join(referenceDir, 'broken.md'),
      [
        '---',
        'title: [broken',
        'description: should fail',
        '---',
        '',
        '# Broken',
        '',
        'This page should not render.',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  fs.writeFileSync(
    path.join(extensibilityDir, 'README.md'),
    [
      '---',
      'title: Extensibility',
      'description: Extend HybridClaw with tools and skills.',
      'sidebar_position: 4',
      '---',
      '',
      '# Extensibility',
      '',
      'This page documents the extension surface.',
      '',
      '## Tools',
      '',
      'Built-in tools and external tool surfaces live here.',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-health-data-'));
  tempDirs.push(dir);
  return dir;
}

function makeRequest(params: {
  method?: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  remoteAddress?: string;
}) {
  const chunks =
    params.body === undefined
      ? []
      : [
          Buffer.from(
            Buffer.isBuffer(params.body)
              ? params.body
              : typeof params.body === 'string'
                ? params.body
                : JSON.stringify(params.body),
          ),
        ];
  return Object.assign(Readable.from(chunks), {
    method: params.method || 'GET',
    url: params.url,
    headers: params.headers || {},
    socket: {
      remoteAddress: params.remoteAddress || '127.0.0.1',
    },
  });
}

function makeResponse() {
  const headers: Record<string, string | string[]> = {};
  const resolveHeaderKey = (name: string): string => {
    const existing = Object.keys(headers).find(
      (key) => key.toLowerCase() === name.toLowerCase(),
    );
    return existing || name;
  };
  const response = {
    writableEnded: false,
    headersSent: false,
    destroyed: false,
    statusCode: 0,
    headers,
    body: '',
    setHeader(name: string, value: string | string[]) {
      headers[resolveHeaderKey(name)] = value;
    },
    getHeader(name: string) {
      return headers[resolveHeaderKey(name)];
    },
    writeHead(statusCode: number, headers: Record<string, string | string[]>) {
      response.statusCode = statusCode;
      Object.assign(response.headers, headers);
      response.headersSent = true;
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
        response.body += Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk);
      }
      response.writableEnded = true;
      response.headersSent = true;
    },
    destroy() {
      response.destroyed = true;
      response.writableEnded = true;
    },
  };
  return response;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForResponse(
  response: ReturnType<typeof makeResponse>,
  predicate: (response: ReturnType<typeof makeResponse>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate(response)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for response state.');
}

async function importFreshHealth(options?: {
  docsDir?: string;
  dataDir?: string;
  webApiToken?: string;
  gatewayApiToken?: string;
  authSecret?: string;
  hybridAiBaseUrl?: string;
  runningInsideContainer?: boolean;
  mediaUploadQuotaDecision?: {
    allowed: boolean;
    remainingBytes: number;
    retryAfterMs: number;
    usedBytes: number;
  };
}) {
  vi.resetModules();

  if (options?.authSecret === undefined) {
    delete process.env.HYBRIDCLAW_AUTH_SECRET;
  } else {
    process.env.HYBRIDCLAW_AUTH_SECRET = options.authSecret;
  }

  const installRoot = options?.docsDir || makeTempDocsDir();
  const dataDir = options?.dataDir ?? makeTempDataDir();
  let handler:
    | ((
        req: Parameters<Parameters<typeof createServer>[0]>[0],
        res: Parameters<Parameters<typeof createServer>[0]>[1],
      ) => void)
    | null = null;
  let listenArgs: { port: number; host: string } | null = null;

  const createServer = vi.fn((nextHandler) => {
    handler = nextHandler;
    return {
      listen: vi.fn((port: number, host: string, callback?: () => void) => {
        listenArgs = { port, host };
        callback?.();
      }),
    };
  });

  const getGatewayStatus = vi.fn(() => ({ status: 'ok', sessions: 2 }));
  const loggerDebug = vi.fn();
  const loggerError = vi.fn();
  const loggerInfo = vi.fn();
  const loggerWarn = vi.fn();
  const getGatewayHistory = vi.fn(() => [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
  ]);
  const getGatewayHistorySummary = vi.fn(() => ({
    messageCount: 2,
    userMessageCount: 1,
    toolCallCount: 3,
    inputTokenCount: 12847,
    outputTokenCount: 8203,
    costUsd: 0.42,
    toolBreakdown: [
      { toolName: 'edit', count: 14 },
      { toolName: 'bash', count: 6 },
      { toolName: 'read', count: 3 },
    ],
    fileChanges: {
      readCount: 3,
      modifiedCount: 7,
      createdCount: 2,
      deletedCount: 1,
    },
  }));
  const getSessionById = vi.fn(() => ({ show_mode: 'all' }));
  const handleGatewayMessage = vi.fn(async () => ({
    status: 'success' as const,
    result: '__MESSAGE_SEND_HANDLED__',
    toolsUsed: [],
    toolExecutions: [
      {
        name: 'message',
        arguments: JSON.stringify({ action: 'send' }),
        result: '',
        isError: false,
      },
    ],
    artifacts: [],
  }));
  const handleGatewayCommand = vi.fn(async () => ({
    kind: 'plain' as const,
    text: 'ok',
  }));
  const renderGatewayCommand = vi.fn(
    (result: { title?: string; text: string }) =>
      result.title ? `${result.title}\n${result.text}` : result.text,
  );
  const runGatewayPluginTool = vi.fn(async () => 'plugin-tool-result');
  const getGatewayAdminOverview = vi.fn(() => ({
    status: { status: 'ok', sessions: 2, version: '0.7.1', uptime: 60 },
    configPath: '/tmp/config.json',
    recentSessions: [],
    usage: {
      daily: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        callCount: 0,
        totalToolCalls: 0,
      },
      monthly: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        callCount: 0,
        totalToolCalls: 0,
      },
      topModels: [],
    },
  }));
  const getGatewayAdminPlugins = vi.fn(async () => ({
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
        hooks: [],
      },
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
        hooks: ['gateway_start'],
      },
    ],
  }));
  const getGatewayAgents = vi.fn(() => ({
    generatedAt: '2026-03-11T10:00:00.000Z',
    version: '0.7.1',
    uptime: 60,
    ralph: {
      enabled: false,
      maxIterations: 0,
    },
    totals: {
      agents: {
        all: 1,
        active: 1,
        idle: 0,
        stopped: 0,
        unused: 0,
        running: 1,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        totalTokens: 15,
        totalCostUsd: 0.01,
      },
      sessions: {
        all: 1,
        active: 1,
        idle: 0,
        stopped: 0,
        running: 1,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        totalTokens: 15,
        totalCostUsd: 0.01,
      },
    },
    agents: [
      {
        id: 'main',
        name: 'Main Agent',
        model: 'gpt-5',
        chatbotId: null,
        enableRag: true,
        workspace: null,
        workspacePath: '/tmp/main/workspace',
        sessionCount: 1,
        activeSessions: 1,
        idleSessions: 0,
        stoppedSessions: 0,
        effectiveModels: ['gpt-5'],
        lastActive: '2026-03-11T10:00:00.000Z',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
        messageCount: 2,
        toolCalls: 1,
        recentSessionId: DEFAULT_WEB_SESSION_ID,
        status: 'active',
      },
    ],
    sessions: [
      {
        id: DEFAULT_WEB_SESSION_ID,
        name: 'Web web',
        task: 'User prompt',
        lastQuestion: 'User prompt',
        lastAnswer: 'Assistant reply',
        fullAutoEnabled: true,
        model: 'gpt-5',
        sessionId: DEFAULT_WEB_SESSION_ID,
        channelId: 'web',
        channelName: null,
        agentId: 'main',
        startedAt: '2026-03-11T09:00:00.000Z',
        lastActive: '2026-03-11T10:00:00.000Z',
        runtimeMinutes: 60,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
        messageCount: 2,
        toolCalls: 1,
        status: 'active',
        watcher: 'container runtime attached',
        previewTitle: 'tool.result + chat',
        previewMeta: '3 items · just now',
        output: ['tool.result read ok 12ms'],
      },
    ],
  }));
  const getGatewayAdminModels = vi.fn(async () => ({
    defaultModel: 'gpt-5',
    hybridaiModels: ['gpt-5'],
    codexModels: ['openai-codex/gpt-5-codex'],
    providerStatus: {},
    models: [],
  }));
  const getGatewayAdminAgents = vi.fn(() => ({
    agents: [
      {
        id: 'main',
        name: 'Main Agent',
        model: 'gpt-5',
        chatbotId: null,
        enableRag: true,
        workspace: null,
        workspacePath: '/tmp/main/workspace',
      },
    ],
  }));
  const getGatewayAdminSessions = vi.fn(() => []);
  const getGatewayAdminScheduler = vi.fn(() => ({
    jobs: [],
  }));
  const getGatewayAdminChannels = vi.fn(() => ({
    groupPolicy: 'open',
    defaultTypingMode: 'thinking',
    defaultDebounceMs: 2500,
    defaultAckReaction: 'eyes',
    defaultRateLimitPerUser: 0,
    defaultMaxConcurrentPerChannel: 2,
    channels: [],
  }));
  const getGatewayAdminConfig = vi.fn(() => ({
    path: '/tmp/config.json',
    config: { version: 1 },
  }));
  const getGatewayAdminMcp = vi.fn(() => ({
    servers: [],
  }));
  const getGatewayAdminAudit = vi.fn(() => ({
    query: '',
    sessionId: '',
    eventType: '',
    limit: 60,
    entries: [],
  }));
  const getGatewayAdminTools = vi.fn(() => ({
    totals: {
      totalTools: 2,
      builtinTools: 2,
      mcpTools: 0,
      otherTools: 0,
      recentExecutions: 1,
      recentErrors: 0,
    },
    groups: [
      {
        label: 'Files',
        tools: [
          {
            name: 'read',
            group: 'Files',
            kind: 'builtin',
            recentCalls: 1,
            recentErrors: 0,
            lastUsedAt: '2026-03-11T10:00:00.000Z',
          },
        ],
      },
    ],
    recentExecutions: [
      {
        id: 1,
        toolName: 'read',
        sessionId: DEFAULT_WEB_SESSION_ID,
        timestamp: '2026-03-11T10:00:00.000Z',
        durationMs: 12,
        isError: false,
      },
    ],
  }));
  const getGatewayAdminSkills = vi.fn(() => ({
    extraDirs: [],
    disabled: [],
    channelDisabled: {},
    skills: [],
  }));
  const deleteGatewayAdminSession = vi.fn(() => ({
    deleted: true,
    sessionId: 's1',
    deletedMessages: 2,
    deletedTasks: 0,
    deletedSemanticMemories: 0,
    deletedUsageEvents: 0,
    deletedAuditEntries: 0,
    deletedStructuredAuditEntries: 0,
    deletedApprovalEntries: 0,
  }));
  const createGatewayAdminAgent = vi.fn(
    (payload: {
      id?: string;
      name?: string | null;
      model?: string | null;
      chatbotId?: string | null;
      enableRag?: boolean | null;
      workspace?: string | null;
    }) => ({
      agent: {
        id: payload.id || 'main',
        name: payload.name || null,
        model: payload.model || null,
        chatbotId: payload.chatbotId || null,
        enableRag:
          typeof payload.enableRag === 'boolean' ? payload.enableRag : null,
        workspace: payload.workspace || null,
        workspacePath: '/tmp/main/workspace',
      },
    }),
  );
  const updateGatewayAdminAgent = vi.fn(
    (
      agentId: string,
      payload: {
        name?: string | null;
        model?: string | null;
        chatbotId?: string | null;
        enableRag?: boolean | null;
        workspace?: string | null;
      },
    ) => ({
      agent: {
        id: agentId,
        name: payload.name || null,
        model: payload.model || null,
        chatbotId: payload.chatbotId || null,
        enableRag:
          typeof payload.enableRag === 'boolean' ? payload.enableRag : null,
        workspace: payload.workspace || null,
        workspacePath: `/tmp/${agentId}/workspace`,
      },
    }),
  );
  const deleteGatewayAdminAgent = vi.fn((agentId: string) => ({
    deleted: true,
    agentId,
  }));
  const removeGatewayAdminChannel = vi.fn(() => ({
    channels: [],
  }));
  const removeGatewayAdminSchedulerJob = vi.fn(() => ({
    jobs: [],
  }));
  const removeGatewayAdminMcpServer = vi.fn(() => ({
    servers: [],
  }));
  const saveGatewayAdminConfig = vi.fn((value) => value);
  const saveGatewayAdminModels = vi.fn(async () => ({
    defaultModel: 'gpt-5',
    hybridaiModels: ['gpt-5'],
    codexModels: ['openai-codex/gpt-5-codex'],
    providerStatus: {},
    models: [],
  }));
  const upsertGatewayAdminChannel = vi.fn(() => ({
    channels: [],
  }));
  const upsertGatewayAdminSchedulerJob = vi.fn(() => ({
    jobs: [],
  }));
  const setGatewayAdminSchedulerJobPaused = vi.fn(() => ({
    jobs: [],
  }));
  const upsertGatewayAdminMcpServer = vi.fn(() => ({
    servers: [],
  }));
  class GatewayRequestError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  const setGatewayAdminSkillEnabled = vi.fn(() => ({
    extraDirs: [],
    disabled: [],
    channelDisabled: {},
    skills: [],
  }));
  const runMessageToolAction = vi.fn(async () => ({ ok: true }));
  const normalizeDiscordToolAction = vi.fn((value: string) =>
    value === 'reply' ? 'send' : null,
  );
  const handleMSTeamsWebhook = vi.fn(async () => {});
  const claimQueuedProactiveMessages = vi.fn(() => [
    { id: 1, text: 'queued message' },
  ]);
  const consumeGatewayMediaUploadQuota = vi.fn((params: { bytes: number }) => ({
    allowed: true,
    remainingBytes: Number.POSITIVE_INFINITY,
    retryAfterMs: 0,
    usedBytes: params.bytes,
    ...options?.mediaUploadQuotaDecision,
  }));

  vi.doMock('node:http', () => ({
    default: { createServer },
    createServer,
  }));
  vi.doMock('../src/config/config.ts', () => ({
    CONTAINER_SANDBOX_MODE: 'container',
    DATA_DIR: dataDir,
    GATEWAY_API_TOKEN: options?.gatewayApiToken || '',
    HEALTH_HOST: '127.0.0.1',
    HEALTH_PORT: 9090,
    HYBRIDAI_BASE_URL: options?.hybridAiBaseUrl || 'https://hybridai.one',
    MSTEAMS_WEBHOOK_PATH: '/api/msteams/messages',
    WEB_API_TOKEN: options?.webApiToken || '',
    getSandboxAutoDetectionState: vi.fn(() => ({
      runningInsideContainer: options?.runningInsideContainer === true,
      sandboxModeExplicit: false,
    })),
  }));
  vi.doMock('../src/infra/install-root.js', () => ({
    resolveInstallPath: vi.fn((...segments: string[]) =>
      path.join(installRoot, ...segments),
    ),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: loggerDebug,
      error: loggerError,
      info: loggerInfo,
      warn: loggerWarn,
    },
  }));
  vi.doMock('../src/channels/msteams/runtime.js', () => ({
    handleMSTeamsWebhook,
  }));
  vi.doMock('../src/memory/db.js', () => ({
    claimQueuedProactiveMessages,
    getSessionById,
    resetSessionIfExpired: vi.fn(() => null),
  }));
  vi.doMock('../src/gateway/gateway-service.js', () => ({
    createGatewayAdminAgent,
    deleteGatewayAdminAgent,
    deleteGatewayAdminSession,
    GatewayRequestError,
    getGatewayAgents,
    getGatewayAdminAgents,
    getGatewayAdminAudit,
    getGatewayAdminChannels,
    getGatewayAdminConfig,
    getGatewayAdminMcp,
    getGatewayAdminModels,
    getGatewayAdminOverview,
    getGatewayAdminPlugins,
    getGatewayAdminScheduler,
    getGatewayAdminSessions,
    getGatewayAdminSkills,
    getGatewayAdminTools,
    getGatewayHistory,
    getGatewayHistorySummary,
    getGatewayStatus,
    handleGatewayCommand,
    handleGatewayMessage,
    renderGatewayCommand,
    runGatewayPluginTool,
    removeGatewayAdminChannel,
    removeGatewayAdminMcpServer,
    removeGatewayAdminSchedulerJob,
    saveGatewayAdminConfig,
    saveGatewayAdminModels,
    setGatewayAdminSchedulerJobPaused,
    setGatewayAdminSkillEnabled,
    updateGatewayAdminAgent,
    upsertGatewayAdminChannel,
    upsertGatewayAdminMcpServer,
    upsertGatewayAdminSchedulerJob,
  }));
  vi.doMock('../src/channels/message/tool-actions.js', () => ({
    runMessageToolAction,
  }));
  vi.doMock('../src/channels/discord/tool-actions.js', () => ({
    createDiscordToolActionRunner: vi.fn(() =>
      vi.fn(async () => ({ ok: true })),
    ),
    normalizeDiscordToolAction,
  }));
  vi.doMock('../src/gateway/media-upload-quota.ts', () => ({
    consumeGatewayMediaUploadQuota,
  }));

  const gatewayHttpServer = await import(
    '../src/gateway/gateway-http-server.js'
  );
  gatewayHttpServer.startGatewayHttpServer();

  if (!handler || !listenArgs) {
    throw new Error('Gateway HTTP server did not initialize.');
  }

  return {
    dataDir,
    handler,
    listenArgs,
    getGatewayStatus,
    getGatewayHistory,
    getGatewayHistorySummary,
    getGatewayAdminOverview,
    getGatewayAgents,
    getGatewayAdminAgents,
    runGatewayPluginTool,
    getGatewayAdminModels,
    getGatewayAdminPlugins,
    getGatewayAdminScheduler,
    getGatewayAdminMcp,
    getGatewayAdminAudit,
    getGatewayAdminSkills,
    getGatewayAdminTools,
    createGatewayAdminAgent,
    updateGatewayAdminAgent,
    deleteGatewayAdminAgent,
    GatewayRequestError,
    setGatewayAdminSkillEnabled,
    handleGatewayMessage,
    handleGatewayCommand,
    renderGatewayCommand,
    getSessionById,
    loggerDebug,
    runMessageToolAction,
    normalizeDiscordToolAction,
    claimQueuedProactiveMessages,
    consumeGatewayMediaUploadQuota,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('node:http');
  vi.doUnmock('../src/config/config.ts');
  vi.doUnmock('../src/infra/install-root.js');
  vi.doUnmock('../src/logger.js');
  vi.doUnmock('../src/memory/db.js');
  vi.doUnmock('../src/gateway/gateway-service.js');
  vi.doUnmock('../src/channels/msteams/runtime.js');
  vi.doUnmock('../src/channels/message/tool-actions.js');
  vi.doUnmock('../src/channels/discord/tool-actions.js');
  vi.doUnmock('../src/gateway/media-upload-quota.ts');
  vi.resetModules();
  if (ORIGINAL_HYBRIDCLAW_AUTH_SECRET === undefined) {
    delete process.env.HYBRIDCLAW_AUTH_SECRET;
  } else {
    process.env.HYBRIDCLAW_AUTH_SECRET = ORIGINAL_HYBRIDCLAW_AUTH_SECRET;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('gateway HTTP server', () => {
  test('starts the HTTP server and serves the health endpoint without auth', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/health' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(state.listenArgs).toEqual({ host: '127.0.0.1', port: 9090 });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', sessions: 2 });
  });

  test('rejects unauthorized API requests from non-loopback addresses', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/status',
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
    });
  });

  test('serves static docs files from the install docs directory', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('<h1>Docs</h1>');
  });

  test('renders development docs markdown as a browsable HTML page', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/development' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain(
      '<title>Development Docs | HybridClaw Docs</title>',
    );
    expect(res.body).toContain('<h1 id="development-docs">Development Docs');
    expect(res.body).toContain('href="/development/guides"');
    expect(res.body).toContain('href="/development/reference"');
    expect(res.body).toContain('href="/development/extensibility"');
    expect(res.body).toContain('aria-label="Search docs"');
    expect(res.body).toContain('>Home</a>');
    expect(res.body).toContain('>GitHub');
    expect(res.body).toContain('>Discord');
    expect(res.body).toContain('On this page');
    expect(res.body).toContain('href="#getting-started"');
    expect(res.body).not.toContain(
      'class="docs-sidebar-link is-active" href="/development"',
    );
    expect(res.body).not.toContain('><span>Development Docs</span></a>');
  });

  test('renders section index pages from folder-based routes', async () => {
    const state = await importFreshHealth();

    for (const [pathname, title, heading, anchor] of [
      ['/development/guides', 'Guides', 'Guides', '#tutorials'],
      ['/development/reference', 'Reference', 'Reference', '#commands'],
      ['/development/guides/', 'Guides', 'Guides', '#tutorials'],
    ] as const) {
      const req = makeRequest({ url: pathname });
      const res = makeResponse();

      state.handler(req as never, res as never);

      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
      expect(res.body).toContain(`<title>${title} | HybridClaw Docs</title>`);
      expect(res.body).toContain(
        `<h1 id="${heading.toLowerCase()}">${heading}`,
      );
      expect(res.body).toContain(`href="${anchor}"`);
    }
  });

  test('reuses the cached development docs snapshot across repeated requests', async () => {
    const installRoot = makeTempDocsDir();
    const state = await importFreshHealth({ docsDir: installRoot });
    const guidesReadmePath = path.join(
      installRoot,
      'docs',
      'development',
      'guides',
      'README.md',
    );

    const firstReq = makeRequest({ url: '/development/guides' });
    const firstRes = makeResponse();
    state.handler(firstReq as never, firstRes as never);

    expect(firstRes.statusCode).toBe(200);
    expect(firstRes.body).toContain('Browse the practical docs from here.');

    fs.writeFileSync(
      guidesReadmePath,
      [
        '---',
        'title: Guides',
        'description: Workflow guides and practical walkthroughs.',
        'sidebar_position: 2',
        '---',
        '',
        '# Guides',
        '',
        'This should only appear after the cache expires.',
        '',
      ].join('\n'),
      'utf8',
    );

    const secondReq = makeRequest({ url: '/development/guides' });
    const secondRes = makeResponse();
    state.handler(secondReq as never, secondRes as never);

    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.body).toContain('Browse the practical docs from here.');
    expect(secondRes.body).not.toContain(
      'This should only appear after the cache expires.',
    );
  });

  test('rejects symlinked development markdown pages', async () => {
    const installRoot = makeTempDocsDir();
    const secretPath = path.join(installRoot, 'outside-secret.md');
    fs.writeFileSync(secretPath, '# Secret\n', 'utf8');
    fs.symlinkSync(
      secretPath,
      path.join(installRoot, 'docs', 'development', 'guides', 'secret.md'),
    );

    const state = await importFreshHealth({ docsDir: installRoot });
    const req = makeRequest({ url: '/development/guides/secret' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('Not Found');
  });

  test('ignores symlinked category metadata files outside the docs tree', async () => {
    const installRoot = makeTempDocsDir();
    const externalCategoryPath = path.join(
      installRoot,
      'outside-category.json',
    );
    fs.writeFileSync(
      externalCategoryPath,
      JSON.stringify({ label: 'Compromised' }),
      'utf8',
    );
    fs.symlinkSync(
      externalCategoryPath,
      path.join(
        installRoot,
        'docs',
        'development',
        'guides',
        '_category_.json',
      ),
    );

    const state = await importFreshHealth({ docsDir: installRoot });
    const req = makeRequest({ url: '/development/guides/heading-order' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('Compromised');
    expect(res.body).toContain('<summary>Guides</summary>');
  });

  test('does not render non-http image sources in development docs', async () => {
    const installRoot = makeTempDocsDir();
    fs.writeFileSync(
      path.join(
        installRoot,
        'docs',
        'development',
        'guides',
        'image-schemes.md',
      ),
      [
        '---',
        'title: Image Schemes',
        'description: Image scheme validation.',
        'sidebar_position: 4',
        '---',
        '',
        '# Image Schemes',
        '',
        '![Bad](javascript:alert(1))',
        '',
      ].join('\n'),
      'utf8',
    );

    const state = await importFreshHealth({ docsDir: installRoot });
    const req = makeRequest({ url: '/development/guides/image-schemes' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<img src="javascript:alert(1)"');
    expect(res.body).toContain('Bad');
    expect(res.body).not.toContain('javascript:alert(1)');
  });

  test('returns a visible error for malformed development doc frontmatter', async () => {
    const installRoot = makeTempDocsDir({ includeMalformedFrontmatter: true });
    const state = await importFreshHealth({ docsDir: installRoot });
    const req = makeRequest({ url: '/development/reference/broken' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(500);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('Development docs failed to render');
    expect(res.body).toContain('Invalid frontmatter in reference/broken.md');
  });

  test('keeps heading anchors aligned when deep headings appear before repeated sections', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/development/guides/heading-order' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="#repeated-section"');
    expect(res.body).toContain('href="#repeated-section-2"');
    expect(res.body).toContain('<h2 id="repeated-section">Repeated Section');
    expect(res.body).toContain('<h2 id="repeated-section-2">Repeated Section');
  });

  test('renders individual development docs pages by slug', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/development/extensibility' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain(
      '<title>Extensibility | HybridClaw Docs</title>',
    );
    expect(res.body).toContain('<h1 id="extensibility">Extensibility');
    expect(res.body).toContain('This page documents the extension surface.');
    expect(res.body).toContain('href="#tools"');
  });

  test('serves /chat, /agents, and /admin without a session cookie outside Docker', async () => {
    const state = await importFreshHealth();

    for (const pathname of ['/chat', '/agents', '/admin']) {
      const req = makeRequest({ url: pathname });
      const res = makeResponse();

      state.handler(req as never, res as never);

      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    }
  });

  test('redirects /chat, /agents, and /admin to HybridAI login in Docker when no session cookie is present', async () => {
    const state = await importFreshHealth({ runningInsideContainer: true });

    for (const pathname of ['/chat', '/agents', '/admin']) {
      const req = makeRequest({ url: pathname });
      const res = makeResponse();

      state.handler(req as never, res as never);

      expect(res.statusCode).toBe(302);
      expect(res.headers.Location).toBe(
        'https://hybridai.one/login?context=hybridclaw&next=/admin_api_keys',
      );
    }
  });

  test('serves the standalone agents docs page with a valid session cookie', async () => {
    const authSecret = 'health-secret';
    const issuedAtSeconds = Math.floor(Date.now() / 1000);
    const sessionToken = signAuthPayload(
      {
        exp: issuedAtSeconds + 60,
        iat: issuedAtSeconds,
        sub: 'user-1',
        typ: 'session',
      },
      authSecret,
    );
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      url: '/agents',
      headers: {
        cookie: `hybridclaw_session=${sessionToken}`,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('<h1>Agents</h1>');
  });

  test('serves admin SPA files and falls back to index.html with a valid session cookie', async () => {
    const authSecret = 'health-secret';
    const issuedAtSeconds = Math.floor(Date.now() / 1000);
    const sessionToken = signAuthPayload(
      {
        exp: issuedAtSeconds + 60,
        iat: issuedAtSeconds,
        sub: 'user-1',
        typ: 'session',
      },
      authSecret,
    );
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({ url: '/admin/sessions' });
    req.headers.cookie = `hybridclaw_session=${sessionToken}`;
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('<h1>Admin</h1>');
  });

  test('accepts a valid launch token on /auth/callback, sets a session cookie, and redirects to /admin', async () => {
    const authSecret = 'health-secret';
    const launchToken = signAuthPayload(
      {
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: 'user-1',
      },
      authSecret,
    );
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      url: `/auth/callback?token=${encodeURIComponent(launchToken)}`,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('/admin');
    expect(res.headers['Set-Cookie']).toEqual(
      expect.stringContaining('hybridclaw_session='),
    );
    expect(res.headers['Set-Cookie']).toEqual(
      expect.stringContaining('HttpOnly'),
    );
    expect(res.headers['Set-Cookie']).toEqual(
      expect.stringContaining('SameSite=Lax'),
    );
  });

  test('returns 401 from /auth/callback when the launch token is invalid', async () => {
    const state = await importFreshHealth({ authSecret: 'health-secret' });
    const req = makeRequest({
      url: '/auth/callback?token=bad-token',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('Unauthorized. Invalid or expired auth token.');
  });

  test('returns 401 from /auth/callback when the token query parameter is missing', async () => {
    const state = await importFreshHealth({ authSecret: 'health-secret' });
    const req = makeRequest({
      url: '/auth/callback',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('Unauthorized. Invalid or expired auth token.');
  });

  test('/auth/callback returns HTML with localStorage script when WEB_API_TOKEN is set', async () => {
    const authSecret = 'health-secret';
    const launchToken = signAuthPayload(
      {
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: 'user-1',
      },
      authSecret,
    );
    const state = await importFreshHealth({
      authSecret,
      webApiToken: 'my-web-token',
    });
    const req = makeRequest({
      url: `/auth/callback?token=${encodeURIComponent(launchToken)}`,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('localStorage.setItem');
    expect(res.body).toContain('hybridclaw_token');
    expect(res.body).toContain('my-web-token');
    expect(res.body).toContain('window.location.replace("/admin")');
    // Session cookie should still be set
    expect(res.headers['Set-Cookie']).toEqual(
      expect.stringContaining('hybridclaw_session='),
    );
  });

  test('/auth/callback includes CSP and X-Content-Type-Options headers when WEB_API_TOKEN is set', async () => {
    const authSecret = 'health-secret';
    const launchToken = signAuthPayload(
      {
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: 'user-1',
      },
      authSecret,
    );
    const state = await importFreshHealth({
      authSecret,
      webApiToken: 'my-web-token',
    });
    const req = makeRequest({
      url: `/auth/callback?token=${encodeURIComponent(launchToken)}`,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Security-Policy']).toBe(
      "default-src 'none'; script-src 'unsafe-inline'",
    );
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  test('/auth/callback escapes angle brackets in WEB_API_TOKEN to prevent script injection', async () => {
    const authSecret = 'health-secret';
    const launchToken = signAuthPayload(
      {
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: 'user-1',
      },
      authSecret,
    );
    const state = await importFreshHealth({
      authSecret,
      webApiToken: 'token-with-<script>-in-it',
    });
    const req = makeRequest({
      url: `/auth/callback?token=${encodeURIComponent(launchToken)}`,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    // Raw `<` must not appear inside the <script> block payload
    expect(res.body).not.toMatch(/<script>.*<(?!\/script>).*<\/script>/s);
    // The escaped form should be present instead
    expect(res.body).toContain('\\u003c');
  });

  test('/auth/callback returns 302 redirect when WEB_API_TOKEN is not set', async () => {
    const authSecret = 'health-secret';
    const launchToken = signAuthPayload(
      {
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: 'user-1',
      },
      authSecret,
    );
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      url: `/auth/callback?token=${encodeURIComponent(launchToken)}`,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('/admin');
  });

  test('/auth/callback respects a valid next query parameter (302 redirect)', async () => {
    const authSecret = 'health-secret';
    const launchToken = signAuthPayload(
      {
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: 'user-1',
      },
      authSecret,
    );
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      url: `/auth/callback?token=${encodeURIComponent(launchToken)}&next=/chat`,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('/chat');
  });

  test('/auth/callback respects a valid next query parameter (HTML localStorage redirect)', async () => {
    const authSecret = 'health-secret';
    const launchToken = signAuthPayload(
      {
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: 'user-1',
      },
      authSecret,
    );
    const state = await importFreshHealth({
      authSecret,
      webApiToken: 'my-web-token',
    });
    const req = makeRequest({
      url: `/auth/callback?token=${encodeURIComponent(launchToken)}&next=/dashboard`,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('window.location.replace("/dashboard")');
  });

  test('/auth/callback ignores protocol-relative next param to prevent open redirect', async () => {
    const authSecret = 'health-secret';
    const launchToken = signAuthPayload(
      {
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: 'user-1',
      },
      authSecret,
    );
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      url: `/auth/callback?token=${encodeURIComponent(launchToken)}&next=//evil.com`,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('/admin');
  });

  test('/auth/callback ignores absolute URL next param to prevent open redirect', async () => {
    const authSecret = 'health-secret';
    const launchToken = signAuthPayload(
      {
        exp: Math.floor(Date.now() / 1000) + 60,
        sub: 'user-1',
      },
      authSecret,
    );
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      url: `/auth/callback?token=${encodeURIComponent(launchToken)}&next=https://evil.com/steal`,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('/admin');
  });

  test('returns history for authorized loopback API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/history?sessionId=s1&limit=2' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.getGatewayHistory).toHaveBeenCalledWith('s1', 2);
    expect(state.getGatewayHistorySummary).toHaveBeenCalledWith('s1', {
      sinceMs: null,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      sessionId: 's1',
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ],
      summary: {
        messageCount: 2,
        userMessageCount: 1,
        toolCallCount: 3,
        inputTokenCount: 12847,
        outputTokenCount: 8203,
        costUsd: 0.42,
        toolBreakdown: [
          { toolName: 'edit', count: 14 },
          { toolName: 'bash', count: 6 },
          { toolName: 'read', count: 3 },
        ],
        fileChanges: {
          readCount: 3,
          modifiedCount: 7,
          createdCount: 2,
          deletedCount: 1,
        },
      },
    });
  });

  test('rejects history requests without an explicit session id', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/history?limit=2' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayHistory).not.toHaveBeenCalled();
    expect(state.getGatewayHistorySummary).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Missing `sessionId` query parameter.',
    });
  });

  test('rejects malformed canonical session ids for history requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/history?sessionId=agent:main:channel:discord:chat',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayHistory).not.toHaveBeenCalled();
    expect(state.getGatewayHistorySummary).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Malformed canonical `sessionId`.',
    });
  });

  test('returns admin overview for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/overview' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminOverview).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      configPath: '/tmp/config.json',
      status: { status: 'ok', sessions: 2 },
    });
  });

  test('returns admin agents for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/agents' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminAgents).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      agents: [
        {
          id: 'main',
          name: 'Main Agent',
          model: 'gpt-5',
          chatbotId: null,
          enableRag: true,
          workspace: null,
          workspacePath: '/tmp/main/workspace',
        },
      ],
    });
  });

  test('returns agents for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/agents' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAgents).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      totals: {
        agents: {
          all: 1,
          active: 1,
        },
        sessions: {
          all: 1,
          active: 1,
        },
      },
      agents: [
        {
          id: 'main',
          sessionCount: 1,
          status: 'active',
        },
      ],
      sessions: [
        {
          id: DEFAULT_WEB_SESSION_ID,
          status: 'active',
          fullAutoEnabled: true,
        },
      ],
    });
  });

  test('returns admin models for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/models' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminModels).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      defaultModel: 'gpt-5',
      hybridaiModels: ['gpt-5'],
    });
  });

  test('returns admin scheduler for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/scheduler' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminScheduler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ jobs: [] });
  });

  test('returns filtered admin audit entries for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/audit?query=approval&sessionId=s1&eventType=approval.response&limit=25',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminAudit).toHaveBeenCalledWith({
      eventType: 'approval.response',
      limit: 25,
      query: 'approval',
      sessionId: 's1',
    });
    expect(res.statusCode).toBe(200);
  });

  test('returns admin tools for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/tools' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminTools).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      totals: {
        totalTools: 2,
        recentExecutions: 1,
      },
      groups: [
        {
          label: 'Files',
        },
      ],
    });
  });

  test('returns admin plugins for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/plugins' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminPlugins).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      totals: {
        totalPlugins: 2,
        failedPlugins: 1,
      },
      plugins: [
        {
          id: 'demo-plugin',
          status: 'loaded',
        },
        {
          id: 'broken-plugin',
          status: 'failed',
        },
      ],
    });
  });

  test('returns admin skills for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/skills' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminSkills).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      extraDirs: [],
      disabled: [],
      channelDisabled: {},
      skills: [],
    });
  });

  test('toggles admin skills for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/skills',
      body: {
        name: 'pdf',
        enabled: false,
        channel: 'teams',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.setGatewayAdminSkillEnabled).toHaveBeenCalledWith({
      channel: 'teams',
      enabled: false,
      name: 'pdf',
    });
    expect(res.statusCode).toBe(200);
  });

  test('returns 400 for unsupported admin skill channels', async () => {
    const state = await importFreshHealth();
    state.setGatewayAdminSkillEnabled.mockImplementation(() => {
      throw new state.GatewayRequestError(
        400,
        'Unsupported skill channel: irc',
      );
    });
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/skills',
      body: {
        name: 'pdf',
        enabled: false,
        channel: 'irc',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Unsupported skill channel: irc',
    });
  });

  test('returns 400 for unknown admin skills', async () => {
    const state = await importFreshHealth();
    state.setGatewayAdminSkillEnabled.mockImplementation(() => {
      throw new state.GatewayRequestError(
        400,
        'Skill `unknown` was not found.',
      );
    });
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/skills',
      body: {
        name: 'unknown',
        enabled: false,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Skill `unknown` was not found.',
    });
  });

  test('allows query-token auth for SSE admin events', async () => {
    const state = await importFreshHealth({
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: '/api/events?token=web-token',
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe(
      'text/event-stream; charset=utf-8',
    );
    expect(res.body).toContain('event: overview');
    expect(res.body).toContain('event: status');
  });

  test('routes web slash commands from /api/chat through handleGatewayCommand', async () => {
    const state = await importFreshHealth();
    state.handleGatewayCommand.mockResolvedValueOnce({
      kind: 'info',
      title: 'Runtime Status',
      text: 'All systems nominal.',
      sessionId: 'session-web-slash',
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: {
        sessionId: 'session-web-slash',
        channelId: 'web',
        userId: 'user-web',
        username: 'web',
        content: '/status',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.handleGatewayCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-web-slash',
        channelId: 'web',
        args: ['status'],
        userId: 'user-web',
      }),
    );
    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'success',
      result: '**Runtime Status**\nAll systems nominal.',
      sessionId: 'session-web-slash',
    });
  });

  test('routes web slash commands through the streaming /api/chat path', async () => {
    const state = await importFreshHealth();
    state.handleGatewayCommand.mockResolvedValueOnce({
      kind: 'info',
      title: 'Runtime Status',
      text: 'All systems nominal.',
      sessionId: 'session-web-slash-stream',
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: {
        sessionId: 'session-web-slash-stream',
        channelId: 'web',
        userId: 'user-web',
        username: 'web',
        content: '/status',
        stream: true,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.handleGatewayCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-web-slash-stream',
        channelId: 'web',
        args: ['status'],
      }),
    );
    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
    expect(
      res.body
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        type: 'result',
        result: expect.objectContaining({
          status: 'success',
          result: '**Runtime Status**\nAll systems nominal.',
          sessionId: 'session-web-slash-stream',
        }),
      },
    ]);
  });

  test('threads updated session ids through expanded web slash commands', async () => {
    const state = await importFreshHealth();
    const seenSessionIds: string[] = [];
    state.handleGatewayCommand.mockImplementation(
      async (request: { args: string[]; sessionId: string }) => {
        seenSessionIds.push(request.sessionId);
        if (request.args[0] === 'bot') {
          return {
            kind: 'info' as const,
            title: 'Bot',
            text: 'bot details',
            sessionId: 'session-web-info-new',
          };
        }
        if (request.args[0] === 'model') {
          return {
            kind: 'info' as const,
            title: 'Model',
            text: 'model details',
            sessionId: request.sessionId,
          };
        }
        return {
          kind: 'info' as const,
          title: 'Runtime Status',
          text: 'status details',
          sessionId: request.sessionId,
        };
      },
    );
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: {
        sessionId: 'session-web-info',
        channelId: 'web',
        userId: 'user-web',
        username: 'web',
        content: '/info',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(seenSessionIds).toEqual([
      'session-web-info',
      'session-web-info-new',
      'session-web-info-new',
    ]);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'success',
      sessionId: 'session-web-info-new',
      result: [
        '**Bot**\nbot details',
        '**Model**\nmodel details',
        '**Runtime Status**\nstatus details',
      ].join('\n\n'),
    });
  });

  test('logs debug details when expanded web slash commands produce no visible output', async () => {
    const state = await importFreshHealth();
    state.handleGatewayCommand.mockResolvedValue({
      kind: 'plain',
      text: '',
      sessionId: 'session-web-empty',
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: {
        sessionId: 'session-web-empty',
        channelId: 'web',
        userId: 'user-web',
        username: 'web',
        content: '/info',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(JSON.parse(res.body)).toMatchObject({
      status: 'success',
      result: 'Done.',
      sessionId: 'session-web-empty',
    });
    expect(state.loggerDebug).toHaveBeenCalledWith(
      {
        sessionId: 'session-web-empty',
        channelId: 'web',
        slashCommands: [['bot', 'info'], ['model', 'info'], ['status']],
      },
      'Expanded web slash commands produced no visible output',
    );
  });

  test('handles /approve view from the web chat path', async () => {
    const state = await importFreshHealth();
    const pendingApprovals = await import(
      '../src/gateway/pending-approvals.js'
    );
    await pendingApprovals.setPendingApproval('session-web-approve', {
      approvalId: 'approve-123',
      prompt: 'I need approval before continuing.',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      userId: 'user-web',
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: {
        sessionId: 'session-web-approve',
        channelId: 'web',
        userId: 'user-web',
        username: 'web',
        content: '/approve view',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.handleGatewayCommand).not.toHaveBeenCalled();
    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'success',
      result: '**Pending Approval**\nI need approval before continuing.',
      sessionId: 'session-web-approve',
    });

    await pendingApprovals.clearPendingApproval('session-web-approve');
  });

  test('normalizes silent message-send chat responses', async () => {
    const state = await importFreshHealth();
    state.handleGatewayMessage.mockImplementation(
      async (request: { sessionId: string }) => ({
        status: 'success' as const,
        result: '__MESSAGE_SEND_HANDLED__',
        sessionId: request.sessionId,
        toolsUsed: [],
        toolExecutions: [
          {
            name: 'message',
            arguments: JSON.stringify({ action: 'send' }),
            result: '',
            isError: false,
          },
        ],
        artifacts: [],
      }),
    );
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: { content: 'send this' },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.handleGatewayMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'web',
        content: 'send this',
        sessionId: expect.stringMatching(WEB_SESSION_ID_RE),
        userId: expect.stringMatching(WEB_SESSION_ID_RE),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'success',
      result: 'Message sent.',
      sessionId: expect.stringMatching(WEB_SESSION_ID_RE),
    });
  });

  test('accepts media-only chat requests and forwards media to the gateway handler', async () => {
    const state = await importFreshHealth();
    const media = [
      {
        path: '/uploaded-media-cache/2026-03-24/1710000000000-abcd-report.pdf',
        url: '/api/artifact?path=%2Fuploaded-media-cache%2F2026-03-24%2F1710000000000-abcd-report.pdf',
        originalUrl:
          '/api/artifact?path=%2Fuploaded-media-cache%2F2026-03-24%2F1710000000000-abcd-report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        filename: 'report.pdf',
      },
    ];
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: {
        content: '',
        media,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.handleGatewayMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Attached file: report.pdf',
        media,
      }),
    );
    expect(res.statusCode).toBe(200);
  });

  test('accepts uploaded-cache absolute paths for media-only chat requests', async () => {
    const dataDir = makeTempDataDir();
    const hostPath = path.join(
      dataDir,
      'uploaded-media-cache',
      '2026-03-24',
      '1710000000000-abcd-report.pdf',
    );
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.writeFileSync(hostPath, 'pdf payload', 'utf8');

    const state = await importFreshHealth({ dataDir });
    const media = [
      {
        path: hostPath,
        url: `/api/artifact?path=${encodeURIComponent(hostPath)}`,
        originalUrl: `/api/artifact?path=${encodeURIComponent(hostPath)}`,
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        filename: 'report.pdf',
      },
    ];
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: {
        content: '',
        media,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.handleGatewayMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Attached file: report.pdf',
        media,
      }),
    );
    expect(res.statusCode).toBe(200);
  });

  test('rejects media-only chat requests with malformed media items', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: {
        content: '',
        media: [
          {
            path: 42,
            url: '/api/artifact?path=%2Fuploaded-media-cache%2Fbad.png',
            originalUrl: '/api/artifact?path=%2Fuploaded-media-cache%2Fbad.png',
            mimeType: 'image/png',
            sizeBytes: 123,
            filename: 'bad.png',
          },
        ],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Missing `media[0].path`.',
    });
  });

  test('rejects media-only chat requests with forged non-cache media paths', async () => {
    const dataDir = makeTempDataDir();
    const forgedPath = path.join(
      dataDir,
      'agents',
      'agent-1',
      'workspace',
      'secret.png',
    );
    const state = await importFreshHealth({ dataDir });
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: {
        content: '',
        media: [
          {
            path: forgedPath,
            url: `/api/artifact?path=${encodeURIComponent(forgedPath)}`,
            originalUrl: `/api/artifact?path=${encodeURIComponent(forgedPath)}`,
            mimeType: 'image/png',
            sizeBytes: 123,
            filename: 'secret.png',
          },
        ],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error:
        'Invalid `media[0].path`. Only uploaded or Discord media cache files are accepted.',
    });
  });

  test('rejects api command requests without an explicit session id', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/command',
      body: { args: ['help'] },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.handleGatewayCommand).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Missing `sessionId` in request body.',
    });
  });

  test('rejects malformed canonical session ids for command requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/command',
      body: {
        args: ['help'],
        sessionId: 'agent:main:channel:discord:chat',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.handleGatewayCommand).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Malformed canonical `sessionId`.',
    });
  });

  test('returns 400 for malformed json request bodies', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: '{"content":',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Invalid JSON body',
    });
    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
  });

  test('stores uploaded media in the managed cache and returns a media descriptor', async () => {
    const dataDir = makeTempDataDir();
    const state = await importFreshHealth({ dataDir });
    const req = makeRequest({
      method: 'POST',
      url: '/api/media/upload',
      headers: {
        'content-type': 'image/png',
        'x-hybridclaw-filename': encodeURIComponent('Screen Shot.png'),
      },
      body: Buffer.from('png-bytes'),
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body) as {
      media: {
        path: string;
        filename: string;
        mimeType: string;
        sizeBytes: number;
        url: string;
      };
    };
    expect(payload.media).toMatchObject({
      path: expect.stringMatching(
        /^\/uploaded-media-cache\/\d{4}-\d{2}-\d{2}\//,
      ),
      filename: 'Screen-Shot.png',
      mimeType: 'image/png',
      sizeBytes: 'png-bytes'.length,
      url: expect.stringContaining('/api/artifact?path='),
    });

    const storedPath = path.join(
      dataDir,
      payload.media.path.replace(
        /^\/uploaded-media-cache/,
        'uploaded-media-cache',
      ),
    );
    expect(fs.readFileSync(storedPath, 'utf8')).toBe('png-bytes');
  });

  test('rejects unsupported upload media types like text/html', async () => {
    const dataDir = makeTempDataDir();
    const state = await importFreshHealth({ dataDir });
    const req = makeRequest({
      method: 'POST',
      url: '/api/media/upload',
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-hybridclaw-filename': encodeURIComponent('index.html'),
      },
      body: Buffer.from('<script>alert(1)</script>'),
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(415);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Unsupported media type: text/html.',
    });
    expect(fs.existsSync(path.join(dataDir, 'uploaded-media-cache'))).toBe(
      false,
    );
  });

  test('returns 429 when the media upload quota is exhausted', async () => {
    const dataDir = makeTempDataDir();
    const state = await importFreshHealth({
      dataDir,
      mediaUploadQuotaDecision: {
        allowed: false,
        remainingBytes: 0,
        retryAfterMs: 12_000,
        usedBytes: 100 * 1024 * 1024,
      },
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/media/upload',
      headers: {
        'content-type': 'image/png',
        'x-hybridclaw-filename': encodeURIComponent('Screen Shot.png'),
      },
      body: Buffer.from('png-bytes'),
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.consumeGatewayMediaUploadQuota).toHaveBeenCalledWith({
      key: 'loopback:127.0.0.1',
      bytes: 'png-bytes'.length,
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('12');
    expect(JSON.parse(res.body)).toEqual({
      error: 'Media upload quota exceeded. Try again later.',
    });
    expect(fs.existsSync(path.join(dataDir, 'uploaded-media-cache'))).toBe(
      false,
    );
  });

  test('starts with an empty DATA_DIR and returns 503 for media uploads', async () => {
    const state = await importFreshHealth({ dataDir: '' });
    const req = makeRequest({
      method: 'POST',
      url: '/api/media/upload',
      headers: {
        'content-type': 'image/png',
        'x-hybridclaw-filename': encodeURIComponent('Screen Shot.png'),
      },
      body: Buffer.from('png-bytes'),
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Uploaded media cache unavailable.',
    });
  });

  test('requires reviewedBy for adaptive skill amendment review actions', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/skills/amendments/apple-music/apply',
      body: {},
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Missing reviewedBy.',
    });
  });

  test('streams structured approval events before the final result payload', async () => {
    const state = await importFreshHealth();
    state.handleGatewayMessage.mockImplementation(
      async (req: {
        onApprovalProgress?: (approval: {
          approvalId: string;
          prompt: string;
          intent: string;
          reason: string;
          allowSession: boolean;
          allowAgent: boolean;
          expiresAt: number;
        }) => void;
      }) => {
        req.onApprovalProgress?.({
          approvalId: 'approve123',
          prompt: 'I need your approval before I control a local app.',
          intent: 'control a local app with `open -a Music`',
          reason: 'this command controls host GUI or application state',
          allowSession: true,
          allowAgent: false,
          expiresAt: 1_710_000_000_000,
        });
        return {
          status: 'success',
          result: 'I need your approval before I control a local app.',
          toolsUsed: ['bash'],
          pendingApproval: {
            approvalId: 'approve123',
            prompt: 'I need your approval before I control a local app.',
            intent: 'control a local app with `open -a Music`',
            reason: 'this command controls host GUI or application state',
            allowSession: true,
            allowAgent: false,
            expiresAt: 1_710_000_000_000,
          },
          artifacts: [],
        };
      },
    );
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: { content: 'play music', stream: true },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    const events = res.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      {
        type: 'approval',
        approvalId: 'approve123',
        prompt: 'I need your approval before I control a local app.',
        intent: 'control a local app with `open -a Music`',
        reason: 'this command controls host GUI or application state',
        allowSession: true,
        allowAgent: false,
        expiresAt: 1_710_000_000_000,
      },
      {
        type: 'result',
        result: expect.objectContaining({
          status: 'success',
          result:
            'Approval needed for: control a local app with `open -a Music`\nWhy: this command controls host GUI or application state\nApproval ID: approve123',
        }),
      },
    ]);
  });

  test('preserves the full approval prompt in approval events when tool output is hidden', async () => {
    const state = await importFreshHealth();
    state.getSessionById.mockReturnValue({ show_mode: 'none' });
    state.handleGatewayMessage.mockImplementation(
      async (req: {
        onApprovalProgress?: (approval: {
          approvalId: string;
          prompt: string;
          intent: string;
          reason: string;
          allowSession: boolean;
          allowAgent: boolean;
          expiresAt: number;
        }) => void;
      }) => {
        req.onApprovalProgress?.({
          approvalId: 'approve123',
          prompt: 'I need your approval before I control a local app.',
          intent: 'control a local app with `open -a Music`',
          reason: 'this command controls host GUI or application state',
          allowSession: true,
          allowAgent: false,
          expiresAt: 1_710_000_000_000,
        });
        return {
          status: 'success',
          result: 'I need your approval before I control a local app.',
          toolsUsed: ['bash'],
          toolExecutions: [
            {
              name: 'bash',
              arguments: 'open -a Music',
              result: 'I need your approval before I control a local app.',
              durationMs: 12,
              approvalDecision: 'required',
            },
          ],
          pendingApproval: {
            approvalId: 'approve123',
            prompt: 'I need your approval before I control a local app.',
            intent: 'control a local app with `open -a Music`',
            reason: 'this command controls host GUI or application state',
            allowSession: true,
            allowAgent: false,
            expiresAt: 1_710_000_000_000,
          },
          artifacts: [],
        };
      },
    );
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: { content: 'play music', stream: true },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    const events = res.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events[0]).toEqual({
      type: 'approval',
      approvalId: 'approve123',
      prompt: 'I need your approval before I control a local app.',
      intent: 'control a local app with `open -a Music`',
      reason: 'this command controls host GUI or application state',
      allowSession: true,
      allowAgent: false,
      expiresAt: 1_710_000_000_000,
    });
    expect(events[1]).toEqual({
      type: 'result',
      result: expect.objectContaining({
        status: 'success',
        result:
          'Approval needed for: control a local app with `open -a Music`\nWhy: this command controls host GUI or application state\nApproval ID: approve123',
        toolExecutions: [
          expect.objectContaining({
            name: '',
            arguments: '',
            result: 'I need your approval before I control a local app.',
            approvalDecision: 'required',
          }),
        ],
      }),
    });
  });

  test('filters tool visibility from web chat responses when show mode hides tools', async () => {
    const state = await importFreshHealth();
    state.getSessionById.mockReturnValue({ show_mode: 'thinking' });
    state.handleGatewayMessage.mockResolvedValue({
      status: 'success',
      result: 'Visible answer',
      toolsUsed: ['search'],
      toolExecutions: [
        {
          name: 'search',
          arguments: '{"q":"hi"}',
          result: 'ok',
          durationMs: 12,
        },
      ],
      artifacts: [],
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: { content: 'hello' },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(JSON.parse(res.body)).toMatchObject({
      status: 'success',
      result: 'Visible answer',
      toolsUsed: [],
      toolExecutions: [
        {
          name: '',
          arguments: '',
          result: '',
        },
      ],
    });
  });

  test('uses analyzed vision text when the final chat result is only Done', async () => {
    const state = await importFreshHealth();
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
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: { content: 'what is in this image?' },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(JSON.parse(res.body)).toMatchObject({
      status: 'success',
      result: 'A basil plant on a windowsill.',
    });
  });

  test('uses a tool failure summary when the final chat result is only Done', async () => {
    const state = await importFreshHealth();
    state.handleGatewayMessage.mockResolvedValue({
      status: 'success',
      result: 'Done.',
      toolsUsed: ['browser_navigate', 'browser_snapshot'],
      toolExecutions: [
        {
          name: 'browser_navigate',
          arguments: '{"url":"https://astroviewer.net/iss/"}',
          result: JSON.stringify({
            success: false,
            error:
              'browser command failed: npm warn deprecated glob@10.5.0: Old versions are not supported',
          }),
          durationMs: 8882,
          isError: true,
        },
        {
          name: 'browser_snapshot',
          arguments: '{"mode":"full"}',
          result: JSON.stringify({
            success: false,
            error:
              "browserType.launchPersistentContext: Executable doesn't exist at /tmp/chromium",
          }),
          durationMs: 5789,
          isError: true,
        },
      ],
      artifacts: [],
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: { content: 'Wann ist die ISS das nächste Mal über München?' },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(JSON.parse(res.body)).toMatchObject({
      status: 'success',
      result:
        'Tool calls failed: browser_navigate, browser_snapshot. Last error: browser runtime is not installed.',
    });
  });

  test('normalizes message action payloads before dispatching tool actions', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/message/action',
      body: {
        action: 'reply',
        channelId: '123',
        content: 'hello',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.normalizeDiscordToolAction).toHaveBeenCalledWith('reply');
    expect(state.runMessageToolAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'send',
        channelId: '123',
        content: 'hello',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  test('keeps /api/discord/action as a compatibility alias for message actions', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/discord/action',
      body: {
        action: 'reply',
        channelId: '123',
        content: 'hello',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.normalizeDiscordToolAction).toHaveBeenCalledWith('reply');
    expect(state.runMessageToolAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'send',
        channelId: '123',
        content: 'hello',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  test('dispatches plugin tool API requests through the gateway plugin runtime', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/plugin/tool',
      body: {
        toolName: 'memory_lookup',
        args: { question: 'What do you know?' },
        sessionId: 'session-plugin-api',
        channelId: 'web',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.runGatewayPluginTool).toHaveBeenCalledWith({
      toolName: 'memory_lookup',
      args: { question: 'What do you know?' },
      sessionId: 'session-plugin-api',
      channelId: 'web',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      result: 'plugin-tool-result',
    });
  });

  test('serves office artifacts from the agent data root with query-token auth', async () => {
    const dataDir = makeTempDataDir();
    const artifactPath = path.join(
      dataDir,
      'agents',
      'agent-1',
      'workspace',
      'quarterly-update.docx',
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, 'docx payload', 'utf8');

    const state = await importFreshHealth({
      dataDir,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: `/api/artifact?path=${encodeURIComponent(artifactPath)}&token=web-token`,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(res.headers['Content-Disposition']).toContain(
      'quarterly-update.docx',
    );
    expect(res.headers['Content-Length']).toBe(String('docx payload'.length));
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.body).toBe('docx payload');
  });

  test('serves uploaded-media-cache artifacts by runtime display path', async () => {
    const dataDir = makeTempDataDir();
    const relativePath = path.join(
      '2026-03-24',
      '1710000000000-abcd-upload.png',
    );
    const artifactPath = path.join(
      dataDir,
      'uploaded-media-cache',
      relativePath,
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, 'image payload', 'utf8');

    const state = await importFreshHealth({
      dataDir,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: `/api/artifact?path=${encodeURIComponent(`/uploaded-media-cache/${relativePath.replace(/\\/g, '/')}`)}&token=web-token`,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.body).toBe('image payload');
  });

  test('returns 503 for uploaded-media-cache artifacts when DATA_DIR is empty', async () => {
    const state = await importFreshHealth({
      dataDir: '',
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: `/api/artifact?path=${encodeURIComponent('/uploaded-media-cache/2026-03-24/1710000000000-abcd-upload.png')}&token=web-token`,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Uploaded media cache unavailable.',
    });
  });

  test('forces active artifact types to download with defensive headers', async () => {
    const dataDir = makeTempDataDir();
    const artifactPath = path.join(
      dataDir,
      'agents',
      'agent-1',
      'workspace',
      'dashboard.html',
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(
      artifactPath,
      '<script>window.pwned = true;</script>',
      'utf8',
    );

    const state = await importFreshHealth({
      dataDir,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: `/api/artifact?path=${encodeURIComponent(artifactPath)}&token=web-token`,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/octet-stream');
    expect(res.headers['Content-Disposition']).toContain(
      'attachment; filename="dashboard.html"',
    );
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Content-Security-Policy']).toBe(
      "sandbox; default-src 'none'",
    );
    expect(res.body).toContain('window.pwned');
  });

  test('mentions query-token auth in artifact auth failures', async () => {
    const dataDir = makeTempDataDir();
    const artifactPath = path.join(
      dataDir,
      'agents',
      'agent-1',
      'workspace',
      'quarterly-update.docx',
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, 'docx payload', 'utf8');

    const state = await importFreshHealth({
      dataDir,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: `/api/artifact?path=${encodeURIComponent(artifactPath)}`,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error:
        'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>` or pass `?token=<WEB_API_TOKEN>`.',
    });
  });

  test('rejects symlinked artifact paths that escape the allowed roots', async () => {
    const dataDir = makeTempDataDir();
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-health-outside-'),
    );
    tempDirs.push(outsideDir);
    const outsideFilePath = path.join(outsideDir, 'secret.docx');
    fs.writeFileSync(outsideFilePath, 'top secret', 'utf8');

    const symlinkPath = path.join(
      dataDir,
      'agents',
      'agent-1',
      'workspace',
      'secret-link.docx',
    );
    fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
    fs.symlinkSync(outsideFilePath, symlinkPath);

    const state = await importFreshHealth({
      dataDir,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: `/api/artifact?path=${encodeURIComponent(symlinkPath)}&token=web-token`,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Artifact not found.',
    });
  });

  test('returns 500 when artifact streaming fails before headers are sent', async () => {
    const dataDir = makeTempDataDir();
    const artifactPath = path.join(
      dataDir,
      'agents',
      'agent-1',
      'workspace',
      'broken.docx',
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, 'broken payload', 'utf8');

    const createReadStreamSpy = vi
      .spyOn(fs, 'createReadStream')
      .mockImplementationOnce(() => {
        const stream = new Readable({
          read() {
            this.destroy(new Error('boom'));
          },
        });
        return stream as unknown as fs.ReadStream;
      });

    const state = await importFreshHealth({
      dataDir,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: `/api/artifact?path=${encodeURIComponent(artifactPath)}&token=web-token`,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Failed to read artifact.',
    });
    createReadStreamSpy.mockRestore();
  });
});
