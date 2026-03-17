import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, test, vi } from 'vitest';

const DEFAULT_WEB_SESSION_ID = 'agent:main:channel:web:chat:dm:peer:default';
const WEB_SESSION_ID_RE = /^agent:main:channel:web:chat:dm:peer:[a-f0-9]{16}$/;

const tempDirs: string[] = [];

function makeTempDocsDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-health-'));
  const docsDir = path.join(root, 'docs');
  const consoleDistDir = path.join(root, 'console', 'dist');
  tempDirs.push(root);
  fs.mkdirSync(docsDir, { recursive: true });
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
            typeof params.body === 'string'
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
  const response = {
    writableEnded: false,
    headersSent: false,
    destroyed: false,
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(statusCode: number, headers: Record<string, string>) {
      response.statusCode = statusCode;
      response.headers = headers;
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
}) {
  vi.resetModules();

  const docsDir = options?.docsDir || makeTempDocsDir();
  const dataDir = options?.dataDir || makeTempDataDir();
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

  vi.doMock('node:http', () => ({
    default: { createServer },
    createServer,
  }));
  vi.doMock('../src/config/config.ts', () => ({
    DATA_DIR: dataDir,
    GATEWAY_API_TOKEN: options?.gatewayApiToken || '',
    HEALTH_HOST: '127.0.0.1',
    HEALTH_PORT: 9090,
    MSTEAMS_WEBHOOK_PATH: '/api/msteams/messages',
    WEB_API_TOKEN: options?.webApiToken || '',
  }));
  vi.doMock('../src/infra/install-root.js', () => ({
    resolveInstallPath: vi.fn((...segments: string[]) =>
      path.join(docsDir, ...segments),
    ),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  }));
  vi.doMock('../src/channels/msteams/runtime.js', () => ({
    handleMSTeamsWebhook,
  }));
  vi.doMock('../src/memory/db.js', () => ({
    claimQueuedProactiveMessages,
    getSessionById,
  }));
  vi.doMock('../src/gateway/gateway-service.js', () => ({
    createGatewayAdminAgent,
    deleteGatewayAdminAgent,
    deleteGatewayAdminSession,
    getGatewayAgents,
    getGatewayAdminAgents,
    getGatewayAdminAudit,
    getGatewayAdminChannels,
    getGatewayAdminConfig,
    getGatewayAdminMcp,
    getGatewayAdminModels,
    getGatewayAdminOverview,
    getGatewayAdminScheduler,
    getGatewayAdminSessions,
    getGatewayAdminSkills,
    getGatewayAdminTools,
    getGatewayHistory,
    getGatewayHistorySummary,
    getGatewayStatus,
    handleGatewayCommand,
    handleGatewayMessage,
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
    normalizeDiscordToolAction,
  }));

  const health = await import('../src/gateway/health.js');
  health.startHealthServer();

  if (!handler || !listenArgs) {
    throw new Error('Health server did not initialize.');
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
    getGatewayAdminModels,
    getGatewayAdminScheduler,
    getGatewayAdminMcp,
    getGatewayAdminAudit,
    getGatewayAdminSkills,
    getGatewayAdminTools,
    createGatewayAdminAgent,
    updateGatewayAdminAgent,
    deleteGatewayAdminAgent,
    setGatewayAdminSkillEnabled,
    handleGatewayMessage,
    handleGatewayCommand,
    getSessionById,
    runMessageToolAction,
    normalizeDiscordToolAction,
    claimQueuedProactiveMessages,
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
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('gateway health server', () => {
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
    await settle();

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

  test('serves the standalone agents docs page via /agents alias', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/agents' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('<h1>Agents</h1>');
  });

  test('serves admin SPA files and falls back to index.html', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/admin/sessions' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('<h1>Admin</h1>');
  });

  test('returns history for authorized loopback API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/history?sessionId=s1&limit=2' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

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
