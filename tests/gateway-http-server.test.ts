import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, test, vi } from 'vitest';

const DEFAULT_WEB_SESSION_ID = 'agent:main:channel:web:chat:dm:peer:default';
const WEB_SESSION_ID_RE = /^agent:[^:]+:channel:web:chat:dm:peer:[a-f0-9]{16}$/;
const OPENAI_SESSION_ID_RE =
  /^agent:[^:]+:channel:openai:chat:dm:peer:[a-f0-9]{16}$/;
const OPENAI_EXECUTION_SESSION_ID_RE =
  /^agent:[^:]+:channel:openai:chat:dm:peer:(?:[a-f0-9]{16}|exec-[a-f0-9]{24})$/;

const tempDirs: string[] = [];
const ORIGINAL_HOME = process.env.HOME;
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
  const contentDocsDir = path.join(docsDir, 'content');
  const gettingStartedDir = path.join(contentDocsDir, 'getting-started');
  const channelsDir = path.join(contentDocsDir, 'channels');
  const extensibilityDir = path.join(contentDocsDir, 'extensibility');
  const guidesDir = path.join(contentDocsDir, 'guides');
  const developerGuideDir = path.join(contentDocsDir, 'developer-guide');
  const referenceDir = path.join(contentDocsDir, 'reference');
  const consoleDistDir = path.join(root, 'console', 'dist');
  tempDirs.push(root);
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(contentDocsDir, { recursive: true });
  fs.mkdirSync(gettingStartedDir, { recursive: true });
  fs.mkdirSync(channelsDir, { recursive: true });
  fs.mkdirSync(extensibilityDir, { recursive: true });
  fs.mkdirSync(guidesDir, { recursive: true });
  fs.mkdirSync(developerGuideDir, { recursive: true });
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
    path.join(contentDocsDir, '_category_.json'),
    JSON.stringify({ label: 'Docs', position: 1, collapsed: false }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(contentDocsDir, 'README.md'),
    [
      '---',
      'title: HybridClaw Docs',
      'description: HybridClaw documentation home.',
      'sidebar_position: 1',
      '---',
      '',
      '# HybridClaw Docs',
      '',
      'Start with [Getting Started](./getting-started), [Channels](./channels), [Guides](./guides), [Reference](./reference), or [Extensibility](./extensibility).',
      '',
      '## Getting Started',
      '',
      'This section introduces the docs.',
      '',
      '### First Steps',
      '',
      'Read the overview, then pick a subsystem.',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(gettingStartedDir, '_category_.json'),
    JSON.stringify({
      label: 'Getting Started',
      position: 1,
      collapsed: false,
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(gettingStartedDir, 'README.md'),
    [
      '---',
      'title: Getting Started',
      'description: Install and launch HybridClaw.',
      'sidebar_position: 1',
      '---',
      '',
      '# Getting Started',
      '',
      'Install the CLI and launch your first HybridClaw surfaces from here.',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(channelsDir, '_category_.json'),
    JSON.stringify({ label: 'Channels', position: 2, collapsed: false }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(channelsDir, 'README.md'),
    [
      '---',
      'title: Channels',
      'description: Transport-specific setup guides.',
      'sidebar_position: 1',
      '---',
      '',
      '# Channels',
      '',
      'Read the deeper setup guides for Slack, iMessage, and Microsoft Teams.',
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
    path.join(developerGuideDir, '_category_.json'),
    JSON.stringify({
      label: 'Developer Guide',
      position: 5,
      collapsed: false,
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(developerGuideDir, 'README.md'),
    [
      '---',
      'title: Developer Guide',
      'description: Maintainer and runtime internals.',
      'sidebar_position: 1',
      '---',
      '',
      '# Developer Guide',
      '',
      'Read the architecture and runtime internals from here.',
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

function writeRuntimeConfig(
  homeDir: string,
  mutator?: (config: Record<string, unknown>) => void,
): void {
  const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as Record<string, unknown>;
  const ops = config.ops as Record<string, unknown>;
  ops.dbPath = path.join(homeDir, '.hybridclaw', 'data', 'hybridclaw.db');
  mutator?.(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
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
  let upgradeHandler:
    | ((req: unknown, socket: unknown, head: unknown) => void)
    | null = null;
  let listenArgs: { port: number; host: string } | null = null;
  const startTerminalSession = vi.fn(() => ({
    sessionId: 'terminal-session-1',
    websocketPath: '/api/admin/terminal/stream?sessionId=terminal-session-1',
  }));
  const stopTerminalSession = vi.fn(() => true);
  const handleTerminalUpgrade = vi.fn(() => true);
  const broadcastShutdownTerminal = vi.fn();
  const disposeTerminalManager = vi.fn();

  const createServer = vi.fn((nextHandler) => {
    handler = nextHandler;
    return {
      on: vi.fn(
        (event: string, nextUpgradeHandler: (...args: unknown[]) => void) => {
          if (event === 'upgrade') {
            upgradeHandler = nextUpgradeHandler;
          }
        },
      ),
      listen: vi.fn((port: number, host: string, callback?: () => void) => {
        listenArgs = { port, host };
        callback?.();
      }),
    };
  });

  const getGatewayStatus = vi.fn(async () => ({ status: 'ok', sessions: 2 }));
  const loggerDebug = vi.fn();
  const loggerError = vi.fn();
  const loggerInfo = vi.fn();
  const loggerWarn = vi.fn();
  const getGatewayHistory = vi.fn(() => ({
    sessionKey: null,
    mainSessionKey: null,
    branchFamilies: [],
    history: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ],
  }));
  const getGatewayRecentChatSessions = vi.fn(() => [
    {
      sessionId: 'web-session-2',
      title: '"Follow-up question from user A"',
      lastActive: '2026-03-24T10:00:00.000Z',
      messageCount: 1,
    },
    {
      sessionId: 'web-session-1',
      title: '"First web question from user A" ... "Assistant reply A1"',
      lastActive: '2026-03-24T09:01:00.000Z',
      messageCount: 2,
    },
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
  const getGatewayAssistantPresentationForSession = vi.fn(() => ({
    agentId: 'charly',
    displayName: 'Charly',
    imageUrl: '/api/agent-avatar?agentId=charly',
  }));
  const getGatewayBootstrapAutostartState = vi.fn(() => null);
  const ensureGatewayBootstrapAutostart = vi.fn(async () => {});
  const getAgentById = vi.fn((agentId: string) =>
    agentId === 'charly'
      ? {
          id: 'charly',
          name: 'Charly Agent',
          displayName: 'Charly',
          imageAsset: 'avatars/charly.png',
        }
      : null,
  );
  const resolveAgentConfig = vi.fn((agentId?: string | null) => ({
    id: agentId?.trim() || 'main',
    name: 'Main Agent',
  }));
  const resolveAgentWorkspaceId = vi.fn(
    (agentId?: string | null) => agentId?.trim() || 'main',
  );
  const getSessionById = vi.fn(() => ({ show_mode: 'all' }));
  const getOrCreateSession = vi.fn((sessionId: string) => ({
    id: sessionId,
    session_key: sessionId,
    main_session_key: sessionId,
  }));
  const storeMessage = vi.fn(() => 1);
  const buildConversationContext = vi.fn(() => ({
    messages: [{ role: 'system', content: 'Mock HybridClaw system prompt' }],
    skills: [],
    historyStats: {},
  }));
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'hybridai' as const,
    apiKey: 'test-key',
    baseUrl: 'https://hybridai.one',
    chatbotId: 'bot_1',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
  }));
  const modelRequiresChatbotId = vi.fn(() => false);
  const callOpenAICompatibleModel = vi.fn(async () => ({
    id: 'resp_tool',
    model: 'gpt-5',
    choices: [
      {
        message: {
          role: 'assistant' as const,
          content: 'ok',
        },
        finish_reason: 'stop',
      },
    ],
  }));
  const callOpenAICompatibleModelStream = vi.fn(async () => ({
    id: 'resp_tool_stream',
    model: 'gpt-5',
    choices: [
      {
        message: {
          role: 'assistant' as const,
          content: 'ok',
        },
        finish_reason: 'stop',
      },
    ],
  }));
  const mapOpenAICompatibleUsageToTokenStats = vi.fn(() => undefined);
  const forkSessionBranch = vi.fn(() => ({
    session: {
      id: 'branch-session-1',
      session_key: 'branch-session-1',
      main_session_key: 'agent:main:channel:web:chat:dm:peer:family-a',
    },
    copiedMessageCount: 2,
  }));
  const handleGatewayMessage = vi.fn(async () => ({
    status: 'success' as const,
    result: '__MESSAGE_SEND_HANDLED__',
    toolsUsed: [],
    userMessageId: 11,
    assistantMessageId: 12,
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
  const readSystemPromptMessage = vi.fn(
    (messages: Array<{ role?: string; content?: unknown }>) => {
      const first = messages[0];
      return first?.role === 'system' && typeof first.content === 'string'
        ? first.content
        : null;
    },
  );
  const resolveGatewayChatbotId = vi.fn(async () => ({
    chatbotId: 'bot_1',
    source: 'configured' as const,
  }));
  const handleGatewayPluginWebhook = vi.fn(async (_req, res) => {
    res.statusCode = 202;
    res.end('plugin-webhook');
  });
  const renderGatewayCommand = vi.fn(
    (result: { title?: string; text: string }) =>
      result.title ? `${result.title}\n${result.text}` : result.text,
  );
  const runGatewayPluginTool = vi.fn(async () => 'plugin-tool-result');
  const getGatewayAdminOverview = vi.fn(async () => ({
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
  const getGatewayAdminEmailMailbox = vi.fn(() => ({
    enabled: true,
    address: 'agent@example.com',
    folders: [
      {
        path: 'INBOX',
        name: 'Inbox',
        specialUse: '\\Inbox',
        total: 12,
        unseen: 3,
      },
    ],
    defaultFolder: 'INBOX',
  }));
  const getGatewayAdminEmailFolder = vi.fn(async () => ({
    folder: 'INBOX',
    offset: 0,
    limit: 20,
    previousOffset: null,
    nextOffset: null,
    messages: [
      {
        folder: 'INBOX',
        uid: 44,
        messageId: '<msg-44@example.com>',
        subject: 'Quarterly plan',
        fromAddress: 'finance@example.com',
        fromName: 'Finance Ops',
        preview: 'Please review the updated budget.',
        receivedAt: '2026-03-11T10:00:00.000Z',
        seen: false,
        flagged: false,
        answered: true,
        hasAttachments: false,
      },
    ],
  }));
  const getGatewayAdminEmailMessage = vi.fn(async () => ({
    message: {
      folder: 'INBOX',
      uid: 44,
      messageId: '<msg-44@example.com>',
      subject: 'Quarterly plan',
      fromAddress: 'finance@example.com',
      fromName: 'Finance Ops',
      preview: 'Please review the updated budget.',
      receivedAt: '2026-03-11T10:00:00.000Z',
      seen: false,
      flagged: false,
      answered: true,
      hasAttachments: false,
      to: [{ name: 'Agent', address: 'agent@example.com' }],
      cc: [],
      bcc: [],
      replyTo: [],
      text: 'Full message body',
      attachments: [],
      metadata: {
        agentId: 'main',
        model: 'hybridai/gpt-5',
        provider: 'hybridai',
        totalTokens: 1234,
        tokenSource: 'api',
      },
    },
    thread: [
      {
        folder: 'INBOX',
        uid: 40,
        messageId: '<msg-40@example.com>',
        subject: 'Quarterly plan',
        fromAddress: 'finance@example.com',
        fromName: 'Finance Ops',
        preview: 'Earlier thread context',
        receivedAt: '2026-03-10T10:00:00.000Z',
        seen: true,
        flagged: false,
        answered: false,
        hasAttachments: false,
        to: [{ name: 'Agent', address: 'agent@example.com' }],
        cc: [],
        bcc: [],
        replyTo: [],
        text: 'Earlier thread context',
        attachments: [],
        metadata: null,
      },
      {
        folder: 'INBOX',
        uid: 44,
        messageId: '<msg-44@example.com>',
        subject: 'Quarterly plan',
        fromAddress: 'finance@example.com',
        fromName: 'Finance Ops',
        preview: 'Please review the updated budget.',
        receivedAt: '2026-03-11T10:00:00.000Z',
        seen: false,
        flagged: false,
        answered: true,
        hasAttachments: false,
        to: [{ name: 'Agent', address: 'agent@example.com' }],
        cc: [],
        bcc: [],
        replyTo: [],
        text: 'Full message body',
        attachments: [],
        metadata: {
          agentId: 'main',
          model: 'hybridai/gpt-5',
          provider: 'hybridai',
          totalTokens: 1234,
          tokenSource: 'api',
        },
      },
    ],
  }));
  const deleteGatewayAdminEmailMessage = vi.fn(async () => ({
    deleted: true,
    targetFolder: 'Trash',
    permanent: false,
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
  const getGatewayAgents = vi.fn(async () => ({
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
    providerStatus: {},
    models: [],
  }));
  const mainAdminAgentMarkdownFiles = [
    {
      name: 'AGENTS.md',
      path: '/tmp/main/workspace/AGENTS.md',
      exists: true,
      updatedAt: '2026-04-13T10:00:00.000Z',
      sizeBytes: 120,
    },
    {
      name: 'USER.md',
      path: '/tmp/main/workspace/USER.md',
      exists: false,
      updatedAt: null,
      sizeBytes: null,
    },
  ];
  const writerAdminAgentMarkdownFiles = [
    {
      name: 'AGENTS.md',
      path: '/tmp/writer/workspace/AGENTS.md',
      exists: true,
      updatedAt: '2026-04-13T11:00:00.000Z',
      sizeBytes: 64,
    },
    {
      name: 'USER.md',
      path: '/tmp/writer/workspace/USER.md',
      exists: true,
      updatedAt: '2026-04-13T12:00:00.000Z',
      sizeBytes: 72,
    },
  ];
  const mainAdminAgentMarkdownRevisions = [
    {
      id: 'main-rev-1',
      createdAt: '2026-04-13T09:00:00.000Z',
      sizeBytes: 96,
      sha256: 'mainsha',
      source: 'save' as const,
    },
  ];
  const writerAdminAgentMarkdownRevisions = [
    {
      id: 'writer-rev-1',
      createdAt: '2026-04-13T11:30:00.000Z',
      sizeBytes: 72,
      sha256: 'writersha',
      source: 'restore' as const,
    },
  ];
  const getTestAdminAgentMarkdownFiles = (agentId: string) =>
    agentId === 'writer'
      ? writerAdminAgentMarkdownFiles
      : mainAdminAgentMarkdownFiles;
  const getTestAdminAgentMarkdownRevisions = (agentId: string) =>
    agentId === 'writer'
      ? writerAdminAgentMarkdownRevisions
      : mainAdminAgentMarkdownRevisions;
  const getTestAdminAgentMarkdownFile = (agentId: string, fileName: string) =>
    getTestAdminAgentMarkdownFiles(agentId).find(
      (entry) => entry.name === fileName,
    );
  const makeTestAdminAgent = (agentId: string) => ({
    id: agentId,
    name: agentId === 'writer' ? 'Writer' : 'Main Agent',
    model: agentId === 'writer' ? null : 'gpt-5',
    skills: null,
    chatbotId: null,
    enableRag: agentId === 'writer' ? null : true,
    workspace: null,
    workspacePath: `/tmp/${agentId}/workspace`,
    markdownFiles: getTestAdminAgentMarkdownFiles(agentId),
  });
  const getGatewayAdminAgents = vi.fn(() => ({
    agents: [
      {
        id: 'main',
        name: 'Main Agent',
        model: 'gpt-5',
        skills: null,
        chatbotId: null,
        enableRag: true,
        workspace: null,
        workspacePath: '/tmp/main/workspace',
        markdownFiles: mainAdminAgentMarkdownFiles,
      },
    ],
  }));
  const getGatewayAdminAgentMarkdownFile = vi.fn(
    (agentId: string, fileName: string) => ({
      agent: makeTestAdminAgent(agentId),
      file: {
        ...getTestAdminAgentMarkdownFile(agentId, fileName),
        content: `# ${agentId}:${fileName}\n`,
        revisions: getTestAdminAgentMarkdownRevisions(agentId),
      },
    }),
  );
  const getGatewayAdminAgentMarkdownRevision = vi.fn(
    (params: { agentId: string; fileName: string; revisionId: string }) => ({
      agent: makeTestAdminAgent(params.agentId),
      fileName: params.fileName,
      revision: {
        ...getTestAdminAgentMarkdownRevisions(params.agentId)[0],
        id: params.revisionId,
        content: `# revision ${params.agentId}:${params.fileName}:${params.revisionId}\n`,
      },
    }),
  );
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
    slack: {
      enabled: false,
      groupPolicy: 'allowlist',
      dmPolicy: 'allowlist',
      defaultRequireMention: true,
      defaultReplyStyle: 'thread',
    },
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
  const createGatewayAdminSkill = vi.fn(() => ({
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
      skills?: string[] | null;
      chatbotId?: string | null;
      enableRag?: boolean | null;
      workspace?: string | null;
    }) => ({
      agent: {
        id: payload.id || 'main',
        name: payload.name || null,
        model: payload.model || null,
        skills: payload.skills ?? null,
        chatbotId: payload.chatbotId || null,
        enableRag:
          typeof payload.enableRag === 'boolean' ? payload.enableRag : null,
        workspace: payload.workspace || null,
        workspacePath: '/tmp/main/workspace',
        markdownFiles: mainAdminAgentMarkdownFiles,
      },
    }),
  );
  const updateGatewayAdminAgent = vi.fn(
    (
      agentId: string,
      payload: {
        name?: string | null;
        model?: string | null;
        skills?: string[] | null;
        chatbotId?: string | null;
        enableRag?: boolean | null;
        workspace?: string | null;
      },
    ) => ({
      agent: {
        id: agentId,
        name: payload.name || null,
        model: payload.model || null,
        skills: payload.skills ?? null,
        chatbotId: payload.chatbotId || null,
        enableRag:
          typeof payload.enableRag === 'boolean' ? payload.enableRag : null,
        workspace: payload.workspace || null,
        workspacePath: `/tmp/${agentId}/workspace`,
        markdownFiles:
          agentId === 'writer'
            ? writerAdminAgentMarkdownFiles
            : mainAdminAgentMarkdownFiles,
      },
    }),
  );
  const saveGatewayAdminAgentMarkdownFile = vi.fn(
    (params: { agentId: string; fileName: string; content: string }) => ({
      agent: makeTestAdminAgent(params.agentId),
      file: {
        ...getTestAdminAgentMarkdownFile(params.agentId, params.fileName),
        content: params.content,
        revisions: getTestAdminAgentMarkdownRevisions(params.agentId),
      },
    }),
  );
  const restoreGatewayAdminAgentMarkdownRevision = vi.fn(
    (params: { agentId: string; fileName: string; revisionId: string }) => ({
      agent: makeTestAdminAgent(params.agentId),
      file: {
        ...getTestAdminAgentMarkdownFile(params.agentId, params.fileName),
        content: `# restored ${params.revisionId}\n`,
        revisions: getTestAdminAgentMarkdownRevisions(params.agentId),
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
  const moveGatewayAdminSchedulerJob = vi.fn(() => ({
    jobs: [],
  }));
  const removeGatewayAdminMcpServer = vi.fn(() => ({
    servers: [],
  }));
  const saveGatewayAdminConfig = vi.fn((value) => value);
  const saveGatewayAdminModels = vi.fn(async () => ({
    defaultModel: 'gpt-5',
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
  const uploadGatewayAdminSkillZip = vi.fn(async () => ({
    extraDirs: [],
    disabled: [],
    channelDisabled: {},
    skills: [],
  }));
  const getGatewayAdminJobsContext = vi.fn(() => ({
    agents: [{ id: 'main', name: 'Main Agent' }],
    sessions: [
      {
        sessionId: 'scheduler:job-1',
        agentId: 'main',
        startedAt: '2026-03-27T08:00:00.000Z',
        lastActive: '2026-03-27T08:05:00.000Z',
        status: 'active',
        lastAnswer: 'Done.',
        output: ['recent output'],
      },
    ],
  }));
  const runMessageToolAction = vi.fn(async () => ({ ok: true }));
  const normalizeDiscordToolAction = vi.fn((value: string) =>
    value === 'reply' ? 'send' : null,
  );
  const handleIMessageWebhook = vi.fn(async () => {});
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
  const listLoadedPluginCommands = vi.fn(() => [
    { name: 'demo_status', description: 'Run the demo plugin status command' },
  ]);
  const stopSessionExecution = vi.fn(() => false);
  const requestGatewayRestart = vi.fn(() => ({
    restartSupported: true,
    restartReason: null,
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
    HYBRIDAI_MODEL: 'gpt-5',
    MAX_CONCURRENT_CONTAINERS: 5,
    IMESSAGE_WEBHOOK_PATH: '/api/imessage/webhook',
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
  vi.doMock('../src/channels/imessage/runtime.js', () => ({
    handleIMessageWebhook,
  }));
  vi.doMock('../src/memory/db.js', () => ({
    claimQueuedProactiveMessages,
    getSessionById,
    resetSessionIfExpired: vi.fn(() => null),
  }));
  vi.doMock('../src/memory/memory-service.js', () => ({
    memoryService: {
      forkSessionBranch,
      getOrCreateSession,
      storeMessage,
    },
  }));
  vi.doMock('../src/agents/agent-registry.js', () => ({
    getAgentById,
    resolveAgentConfig,
    resolveAgentWorkspaceId,
  }));
  vi.doMock('../src/agent/executor.js', () => ({
    stopSessionExecution,
  }));
  vi.doMock('../src/gateway/gateway-service.js', () => ({
    createGatewayAdminAgent,
    createGatewayAdminSkill,
    deleteGatewayAdminAgent,
    deleteGatewayAdminSession,
    ensureGatewayBootstrapAutostart,
    GatewayRequestError,
    getGatewayAgents,
    getGatewayAdminAgents,
    getGatewayAdminAgentMarkdownFile,
    getGatewayAdminAgentMarkdownRevision,
    getGatewayAdminAudit,
    getGatewayAdminChannels,
    getGatewayAdminConfig,
    deleteGatewayAdminEmailMessage,
    getGatewayAdminEmailFolder,
    getGatewayAdminEmailMailbox,
    getGatewayAdminEmailMessage,
    getGatewayAdminJobsContext,
    getGatewayAdminMcp,
    getGatewayAdminModels,
    getGatewayAdminOverview,
    getGatewayAdminSessions,
    getGatewayAdminSkills,
    getGatewayAdminTools,
    getGatewayAssistantPresentationForSession,
    getGatewayBootstrapAutostartState,
    getGatewayHistory,
    getGatewayRecentChatSessions,
    getGatewayHistorySummary,
    getGatewayStatus,
    handleGatewayCommand,
    readSystemPromptMessage,
    renderGatewayCommand,
    resolveGatewayChatbotId,
    removeGatewayAdminChannel,
    removeGatewayAdminMcpServer,
    restoreGatewayAdminAgentMarkdownRevision,
    saveGatewayAdminConfig,
    saveGatewayAdminAgentMarkdownFile,
    saveGatewayAdminModels,
    setGatewayAdminSkillEnabled,
    updateGatewayAdminAgent,
    uploadGatewayAdminSkillZip,
    upsertGatewayAdminChannel,
    upsertGatewayAdminMcpServer,
  }));
  vi.doMock('../src/gateway/gateway-chat-service.js', () => ({
    handleGatewayMessage,
  }));
  vi.doMock('../src/agent/conversation.js', () => ({
    buildConversationContext,
  }));
  vi.doMock('../src/providers/factory.js', () => ({
    modelRequiresChatbotId,
    resolveModelRuntimeCredentials,
  }));
  vi.doMock('../src/gateway/openai-compatible-model.ts', () => ({
    callOpenAICompatibleModel,
    callOpenAICompatibleModelStream,
    mapOpenAICompatibleUsageToTokenStats,
  }));
  vi.doMock('../src/gateway/gateway-scheduled-task-service.js', () => ({
    getGatewayAdminScheduler,
    moveGatewayAdminSchedulerJob,
    removeGatewayAdminSchedulerJob,
    setGatewayAdminSchedulerJobPaused,
    upsertGatewayAdminSchedulerJob,
  }));
  vi.doMock('../src/gateway/gateway-plugin-service.js', () => ({
    getGatewayAdminPlugins,
    handleGatewayPluginWebhook,
    runGatewayPluginTool,
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
  vi.doMock('../src/plugins/plugin-manager.js', () => ({
    findLoadedPluginCommand: vi.fn(() => undefined),
    listLoadedPluginCommands,
  }));
  vi.doMock('../src/gateway/admin-terminal.ts', () => ({
    createAdminTerminalManager: vi.fn(() => ({
      startSession: startTerminalSession,
      stopSession: stopTerminalSession,
      handleUpgrade: handleTerminalUpgrade,
      broadcastShutdown: broadcastShutdownTerminal,
      dispose: disposeTerminalManager,
    })),
  }));
  vi.doMock('../src/gateway/gateway-restart.js', () => ({
    requestGatewayRestart,
  }));

  const gatewayHttpServer = await import(
    '../src/gateway/gateway-http-server.js'
  );
  const httpServer = gatewayHttpServer.startGatewayHttpServer();

  if (!handler || !listenArgs) {
    throw new Error('Gateway HTTP server did not initialize.');
  }

  return {
    dataDir,
    handler,
    httpServer,
    listenArgs,
    getGatewayStatus,
    ensureGatewayBootstrapAutostart,
    getGatewayAssistantPresentationForSession,
    getGatewayBootstrapAutostartState,
    getGatewayHistory,
    getGatewayRecentChatSessions,
    getGatewayHistorySummary,
    forkSessionBranch,
    getGatewayAdminOverview,
    deleteGatewayAdminEmailMessage,
    getGatewayAdminEmailFolder,
    getGatewayAdminEmailMailbox,
    getGatewayAdminEmailMessage,
    getGatewayAgents,
    getGatewayAdminAgents,
    getGatewayAdminAgentMarkdownFile,
    getGatewayAdminAgentMarkdownRevision,
    runGatewayPluginTool,
    getGatewayAdminModels,
    getGatewayAdminPlugins,
    getGatewayAdminScheduler,
    getGatewayAdminMcp,
    getGatewayAdminAudit,
    getGatewayAdminSkills,
    getGatewayAdminJobsContext,
    getGatewayAdminTools,
    startTerminalSession,
    stopTerminalSession,
    handleTerminalUpgrade,
    broadcastShutdownTerminal,
    upgradeHandler,
    moveGatewayAdminSchedulerJob,
    requestGatewayRestart,
    createGatewayAdminAgent,
    createGatewayAdminSkill,
    restoreGatewayAdminAgentMarkdownRevision,
    updateGatewayAdminAgent,
    saveGatewayAdminAgentMarkdownFile,
    deleteGatewayAdminAgent,
    GatewayRequestError,
    setGatewayAdminSkillEnabled,
    uploadGatewayAdminSkillZip,
    handleGatewayMessage,
    handleGatewayCommand,
    handleGatewayPluginWebhook,
    renderGatewayCommand,
    getSessionById,
    getOrCreateSession,
    storeMessage,
    getAgentById,
    buildConversationContext,
    callOpenAICompatibleModel,
    callOpenAICompatibleModelStream,
    loggerDebug,
    loggerError,
    loggerWarn,
    stopSessionExecution,
    mapOpenAICompatibleUsageToTokenStats,
    modelRequiresChatbotId,
    readSystemPromptMessage,
    resolveGatewayChatbotId,
    resolveModelRuntimeCredentials,
    handleIMessageWebhook,
    runMessageToolAction,
    normalizeDiscordToolAction,
    claimQueuedProactiveMessages,
    consumeGatewayMediaUploadQuota,
    listLoadedPluginCommands,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('node:http');
  vi.doUnmock('node:dns/promises');
  vi.doUnmock('../src/config/config.ts');
  vi.doUnmock('../src/infra/install-root.js');
  vi.doUnmock('../src/logger.js');
  vi.doUnmock('../src/agent/conversation.js');
  vi.doUnmock('../src/memory/db.js');
  vi.doUnmock('../src/gateway/gateway-service.js');
  vi.doUnmock('../src/gateway/gateway-chat-service.js');
  vi.doUnmock('../src/gateway/openai-compatible-model.ts');
  vi.doUnmock('../src/gateway/gateway-scheduled-task-service.js');
  vi.doUnmock('../src/providers/factory.js');
  vi.doUnmock('../src/channels/imessage/runtime.js');
  vi.doUnmock('../src/channels/msteams/runtime.js');
  vi.doUnmock('../src/channels/message/tool-actions.js');
  vi.doUnmock('../src/channels/discord/tool-actions.js');
  vi.doUnmock('../src/gateway/media-upload-quota.ts');
  vi.doUnmock('../src/plugins/plugin-manager.js');
  vi.doUnmock('../src/gateway/gateway-restart.js');
  vi.resetModules();
  if (ORIGINAL_HYBRIDCLAW_AUTH_SECRET === undefined) {
    delete process.env.HYBRIDCLAW_AUTH_SECRET;
  } else {
    process.env.HYBRIDCLAW_AUTH_SECRET = ORIGINAL_HYBRIDCLAW_AUTH_SECRET;
  }
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
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
    await vi.waitFor(() => expect(res.statusCode).toBe(200));

    expect(state.listenArgs).toEqual({ host: '127.0.0.1', port: 9090 });
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

  test('rejects unauthorized OpenAI-compatible API requests from non-loopback addresses', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/v1/models',
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: {
        message: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
        type: 'authentication_error',
        param: null,
        code: null,
      },
    });
  });

  test('serves OpenAI-compatible model discovery from /v1/models', async () => {
    const state = await importFreshHealth();
    state.getGatewayAdminModels.mockResolvedValueOnce({
      defaultModel: 'gpt-5',
      providerStatus: {},
      models: [{ id: 'gpt-5' }, { id: 'openai-codex/gpt-5-codex' }],
    });
    const req = makeRequest({ url: '/v1/models' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      object: 'list',
      data: [
        {
          id: 'gpt-5',
          object: 'model',
          created: 0,
          owned_by: 'hybridclaw',
        },
        {
          id: 'openai-codex/gpt-5-codex',
          object: 'model',
          created: 0,
          owned_by: 'hybridclaw',
        },
      ],
    });
  });

  test('translates OpenAI chat completions requests into gateway chat requests', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth();
    state.handleGatewayMessage.mockResolvedValueOnce({
      status: 'success',
      result: 'HybridClaw reply',
      toolsUsed: [],
      tokenUsage: {
        modelCalls: 1,
        apiUsageAvailable: true,
        apiPromptTokens: 12,
        apiCompletionTokens: 7,
        apiTotalTokens: 19,
        apiCacheUsageAvailable: false,
        apiCacheReadTokens: 0,
        apiCacheWriteTokens: 0,
        estimatedPromptTokens: 12,
        estimatedCompletionTokens: 7,
        estimatedTotalTokens: 19,
      },
    });
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5',
        user: 'sdk-user',
        messages: [
          { role: 'system', content: 'You are concise.' },
          { role: 'assistant', content: 'Earlier answer.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this image.' },
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/cat.png' },
              },
            ],
          },
        ],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.getOrCreateSession).toHaveBeenCalledTimes(1);
    expect(state.storeMessage).toHaveBeenCalledTimes(2);
    expect(state.storeMessage).toHaveBeenNthCalledWith(1, {
      sessionId: expect.stringMatching(OPENAI_SESSION_ID_RE),
      userId: expect.stringMatching(OPENAI_SESSION_ID_RE),
      username: 'sdk-user',
      role: 'system',
      content: 'You are concise.',
    });
    expect(state.storeMessage).toHaveBeenNthCalledWith(2, {
      sessionId: expect.stringMatching(OPENAI_SESSION_ID_RE),
      userId: expect.stringMatching(OPENAI_SESSION_ID_RE),
      username: 'sdk-user',
      role: 'assistant',
      content: 'Earlier answer.',
    });
    expect(state.handleGatewayMessage).toHaveBeenCalledWith({
      sessionId: expect.stringMatching(OPENAI_SESSION_ID_RE),
      executionSessionId: expect.stringMatching(OPENAI_EXECUTION_SESSION_ID_RE),
      guildId: null,
      channelId: 'openai',
      userId: expect.stringMatching(OPENAI_SESSION_ID_RE),
      username: 'sdk-user',
      content: 'Describe this image.',
      media: [
        {
          path: null,
          url: 'https://example.com/cat.png',
          originalUrl: 'https://example.com/cat.png',
          filename: 'cat.png',
          sizeBytes: 0,
          mimeType: 'image/png',
        },
      ],
      model: 'gpt-5',
      source: 'gateway.chat.openai-compatible',
    });
    expect(state.stopSessionExecution).not.toHaveBeenCalled();

    const payload = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(payload.object).toBe('chat.completion');
    expect(payload.model).toBe('gpt-5');
    expect(payload.choices[0]).toEqual({
      index: 0,
      message: {
        role: 'assistant',
        content: 'HybridClaw reply',
      },
      finish_reason: 'stop',
    });
    expect(payload.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 7,
      total_tokens: 19,
    });
  });

  test('reuses the OpenAI executor session across repeated requests in the same conversation seed', async () => {
    const state = await importFreshHealth();
    const makeBody = (finalPrompt: string) => ({
      model: 'gpt-5',
      user: 'sdk-user',
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: 'Task: fix the bug.' },
        { role: 'assistant', content: 'I will inspect it.' },
        { role: 'user', content: finalPrompt },
      ],
    });

    const firstReq = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: makeBody('Step 1'),
    });
    const firstRes = makeResponse();
    state.handler(firstReq as never, firstRes as never);
    await waitForResponse(firstRes, (next) => next.writableEnded);

    const secondReq = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: makeBody('Step 2'),
    });
    const secondRes = makeResponse();
    state.handler(secondReq as never, secondRes as never);
    await waitForResponse(secondRes, (next) => next.writableEnded);

    const firstCall = state.handleGatewayMessage.mock.calls[0]?.[0];
    const secondCall = state.handleGatewayMessage.mock.calls[1]?.[0];
    expect(firstCall?.sessionId).toMatch(OPENAI_SESSION_ID_RE);
    expect(secondCall?.sessionId).toMatch(OPENAI_SESSION_ID_RE);
    expect(firstCall?.sessionId).not.toBe(secondCall?.sessionId);
    expect(firstCall?.executionSessionId).toMatch(
      OPENAI_EXECUTION_SESSION_ID_RE,
    );
    expect(secondCall?.executionSessionId).toBe(firstCall?.executionSessionId);
    expect(state.stopSessionExecution).not.toHaveBeenCalled();
  });

  test('falls back to one-off OpenAI execution sessions when the reusable pool is saturated', async () => {
    const state = await importFreshHealth();
    const resolvers: Array<(value: unknown) => void> = [];
    state.handleGatewayMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const requests = Array.from({ length: 6 }, (_, index) => ({
      req: makeRequest({
        method: 'POST',
        url: '/v1/chat/completions',
        body: {
          model: 'gpt-5',
          user: 'sdk-user',
          messages: [{ role: 'user', content: `Task ${index + 1}` }],
        },
      }),
      res: makeResponse(),
    }));

    for (const { req, res } of requests) {
      state.handler(req as never, res as never);
    }
    await settle();

    expect(state.handleGatewayMessage).toHaveBeenCalledTimes(6);
    const calls = state.handleGatewayMessage.mock.calls.map((call) => call[0]);
    const reusableIds = calls
      .slice(0, 5)
      .map((call) => String(call.executionSessionId || ''));
    expect(new Set(reusableIds).size).toBe(5);
    for (const id of reusableIds) {
      expect(id).toMatch(
        /^agent:[^:]+:channel:openai:chat:dm:peer:exec-[a-f0-9]{24}$/,
      );
    }
    const fallbackExecutionSessionId = String(
      calls[5]?.executionSessionId || '',
    );
    expect(fallbackExecutionSessionId).toMatch(
      /^agent:[^:]+:channel:openai:chat:dm:peer:[a-f0-9]{16}$/,
    );
    expect(fallbackExecutionSessionId).not.toContain('exec-');

    for (const resolve of resolvers) {
      resolve({
        status: 'success',
        result: 'ok',
        toolsUsed: [],
      });
    }
    await Promise.all(
      requests.map(({ res }) =>
        waitForResponse(res, (next) => next.writableEnded),
      ),
    );

    expect(state.stopSessionExecution).toHaveBeenCalledWith(
      fallbackExecutionSessionId,
    );
    for (const id of reusableIds) {
      expect(state.stopSessionExecution).not.toHaveBeenCalledWith(id);
    }
  });

  test('routes eval-profiled OpenAI requests to the selected current agent with system ablation', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5__hc_eval=agent=charly,ablate-system',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.handleGatewayMessage).toHaveBeenCalledWith({
      sessionId: expect.stringMatching(OPENAI_SESSION_ID_RE),
      executionSessionId: expect.stringMatching(OPENAI_EXECUTION_SESSION_ID_RE),
      guildId: null,
      channelId: 'openai',
      userId: expect.stringMatching(OPENAI_SESSION_ID_RE),
      username: 'openai',
      content: 'hello',
      agentId: 'charly',
      model: 'gpt-5',
      promptMode: 'none',
      source: 'gateway.chat.openai-compatible',
    });

    const payload = JSON.parse(res.body);
    expect(payload.model).toBe('gpt-5__hc_eval=agent=charly,ablate-system');
  });

  test('routes OpenAI requests with HybridClaw eval-profile header using the plain model name', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-hybridclaw-eval-profile': 'agent=charly,ablate-system',
      },
      body: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.handleGatewayMessage).toHaveBeenCalledWith({
      sessionId: expect.stringMatching(OPENAI_SESSION_ID_RE),
      executionSessionId: expect.stringMatching(OPENAI_EXECUTION_SESSION_ID_RE),
      guildId: null,
      channelId: 'openai',
      userId: expect.stringMatching(OPENAI_SESSION_ID_RE),
      username: 'openai',
      content: 'hello',
      agentId: 'charly',
      model: 'gpt-5',
      promptMode: 'none',
      source: 'gateway.chat.openai-compatible',
    });

    const payload = JSON.parse(res.body);
    expect(payload.model).toBe('gpt-5');
  });

  test('routes eval-profiled OpenAI requests to a fresh temporary agent workspace', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5__hc_eval=fresh-agent,omit=bootstrap+soul',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.handleGatewayMessage).toHaveBeenCalledWith({
      sessionId: expect.stringMatching(OPENAI_SESSION_ID_RE),
      guildId: null,
      channelId: 'openai',
      userId: expect.stringMatching(OPENAI_SESSION_ID_RE),
      username: 'openai',
      content: 'hello',
      agentId: expect.stringMatching(/^eval-[a-f0-9]{16}$/),
      model: 'gpt-5',
      omitPromptParts: ['bootstrap', 'soul'],
      source: 'gateway.chat.openai-compatible',
      executionSessionId: expect.stringMatching(OPENAI_EXECUTION_SESSION_ID_RE),
    });
    expect(state.stopSessionExecution).toHaveBeenCalledWith(
      expect.stringMatching(OPENAI_EXECUTION_SESSION_ID_RE),
    );
  });

  test('streams OpenAI-compatible chat completion chunks with usage', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth();
    state.handleGatewayMessage.mockImplementationOnce(
      async ({ onTextDelta }: { onTextDelta?: (delta: string) => void }) => {
        onTextDelta?.('Hello');
        onTextDelta?.(' world');
        return {
          status: 'success' as const,
          result: 'Hello world',
          toolsUsed: [],
          tokenUsage: {
            modelCalls: 1,
            apiUsageAvailable: true,
            apiPromptTokens: 3,
            apiCompletionTokens: 2,
            apiTotalTokens: 5,
            apiCacheUsageAvailable: false,
            apiCacheReadTokens: 0,
            apiCacheWriteTokens: 0,
            estimatedPromptTokens: 3,
            estimatedCompletionTokens: 2,
            estimatedTotalTokens: 5,
          },
        };
      },
    );
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'Hello?' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe(
      'text/event-stream; charset=utf-8',
    );
    expect(res.body).toContain('"role":"assistant"');
    expect(res.body).toContain('"content":"Hello"');
    expect(res.body).toContain('"content":" world"');
    expect(res.body).toContain('"finish_reason":"stop"');
    expect(res.body).toContain(
      '"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}',
    );
    expect(res.body).toContain('data: [DONE]');
  });

  test('rejects OpenAI chat completions requests where n is not 1', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5',
        n: 2,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    const payload = JSON.parse(res.body);
    expect(res.statusCode).toBe(400);
    expect(payload).toMatchObject({
      error: {
        type: 'invalid_request_error',
      },
    });
    expect(payload.error.message).toContain('n=1');
  });

  test('accepts OpenAI chat completions requests with client-defined tools', async () => {
    const state = await importFreshHealth();
    state.callOpenAICompatibleModel.mockResolvedValueOnce({
      id: 'resp_tools_supported',
      model: 'gpt-5',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_weather',
                type: 'function',
                function: {
                  name: 'lookup_weather',
                  arguments: '{"city":"Berlin"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5',
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup_weather',
            },
          },
        ],
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    const payload = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(payload.choices[0]?.message?.tool_calls).toEqual([
      {
        id: 'call_weather',
        type: 'function',
        function: {
          name: 'lookup_weather',
          arguments: '{"city":"Berlin"}',
        },
      },
    ]);
    expect(payload.choices[0]?.finish_reason).toBe('tool_calls');
  });

  test('rejects OpenAI chat completions requests whose final message is not from the user', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'I can help with that.' },
        ],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    const payload = JSON.parse(res.body);
    expect(res.statusCode).toBe(400);
    expect(payload).toMatchObject({
      error: {
        type: 'invalid_request_error',
      },
    });
    expect(payload.error.message).toMatch(/final|user/i);
  });

  test('rejects OpenAI chat completions requests with invalid message content shape', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: { text: 'hello' } }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    const payload = JSON.parse(res.body);
    expect(res.statusCode).toBe(400);
    expect(payload).toMatchObject({
      error: {
        type: 'invalid_request_error',
      },
    });
    expect(payload.error.message).toMatch(/content|messages/i);
  });

  test('accepts OpenAI chat completions requests with client tools and returns tool calls', async () => {
    const state = await importFreshHealth();
    state.callOpenAICompatibleModel.mockResolvedValueOnce({
      id: 'resp_tool',
      model: 'gpt-5',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'lookup_customer',
                  arguments: '{"id":"42"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });
    state.mapOpenAICompatibleUsageToTokenStats.mockReturnValueOnce({
      modelCalls: 1,
      apiUsageAvailable: true,
      apiPromptTokens: 10,
      apiCompletionTokens: 5,
      apiTotalTokens: 15,
      apiCacheUsageAvailable: false,
      apiCacheReadTokens: 0,
      apiCacheWriteTokens: 0,
      estimatedPromptTokens: 10,
      estimatedCompletionTokens: 5,
      estimatedTotalTokens: 15,
    });
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5',
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup_customer',
              description: 'Lookup a customer',
              parameters: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                },
                required: ['id'],
              },
            },
          },
        ],
        messages: [{ role: 'user', content: 'Find customer 42' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    const payload = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(payload.choices[0]?.message?.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'lookup_customer',
          arguments: '{"id":"42"}',
        },
      },
    ]);
    expect(payload.choices[0]?.finish_reason).toBe('tool_calls');
    expect(state.callOpenAICompatibleModel).toHaveBeenCalledTimes(1);
    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
  });

  test('streams OpenAI tool calls for client tool requests', async () => {
    const state = await importFreshHealth();
    state.callOpenAICompatibleModelStream.mockImplementationOnce(
      async (params: { onTextDelta: (delta: string) => void }) => {
        params.onTextDelta('partial text');
        return {
          id: 'resp_tool_stream',
          model: 'gpt-5',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_stream_1',
                    type: 'function',
                    function: {
                      name: 'lookup_customer',
                      arguments: '{"id":"42"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 6,
            total_tokens: 18,
          },
        };
      },
    );
    state.mapOpenAICompatibleUsageToTokenStats.mockReturnValueOnce({
      modelCalls: 1,
      apiUsageAvailable: true,
      apiPromptTokens: 12,
      apiCompletionTokens: 6,
      apiTotalTokens: 18,
      apiCacheUsageAvailable: false,
      apiCacheReadTokens: 0,
      apiCacheWriteTokens: 0,
      estimatedPromptTokens: 12,
      estimatedCompletionTokens: 6,
      estimatedTotalTokens: 18,
    });
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5',
        stream: true,
        stream_options: { include_usage: true },
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup_customer',
            },
          },
        ],
        messages: [{ role: 'user', content: 'Find customer 42' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"content":"partial text"');
    expect(res.body).toContain('"tool_calls"');
    expect(res.body).toContain('"finish_reason":"tool_calls"');
    expect(state.callOpenAICompatibleModelStream).toHaveBeenCalledTimes(1);
    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
  });

  test('rejects OpenAI chat completions requests with stream_options when stream is not enabled', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5',
        stream: false,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    const payload = JSON.parse(res.body);
    expect(res.statusCode).toBe(400);
    expect(payload).toMatchObject({
      error: {
        type: 'invalid_request_error',
      },
    });
    expect(payload.error.message).toMatch(/stream_options|stream/i);
  });

  test('rejects OpenAI chat completions requests with private media URLs', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe this' },
              {
                type: 'image_url',
                image_url: { url: 'http://localhost/private.png' },
              },
            ],
          },
        ],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    const payload = JSON.parse(res.body);
    expect(res.statusCode).toBe(400);
    expect(payload).toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_url',
      },
    });
    expect(payload.error.message).toMatch(/private|loopback|image_url/i);
  });

  test('returns full OpenAI-style errors for unknown /v1 routes', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/v1/does-not-exist' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: {
        message: 'Not Found',
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
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

  test('delegates iMessage webhook requests to the iMessage runtime', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/imessage/webhook',
      body: { type: 'new-message' },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(
      res,
      () => state.handleIMessageWebhook.mock.calls.length > 0,
    );

    expect(state.handleIMessageWebhook).toHaveBeenCalledTimes(1);
  });

  test('delegates plugin webhook requests before API auth is enforced', async () => {
    const state = await importFreshHealth({ webApiToken: 'secret-token' });
    const req = makeRequest({
      method: 'POST',
      url: '/api/plugin-webhooks/demo-plugin/email-inbound',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(
      res,
      () => state.handleGatewayPluginWebhook.mock.calls.length > 0,
    );

    expect(state.handleGatewayPluginWebhook).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('plugin-webhook');
  });

  test('returns a generic 500 when a webhook handler throws unexpectedly', async () => {
    const state = await importFreshHealth();
    state.handleGatewayPluginWebhook.mockRejectedValueOnce(
      new Error('secret webhook failure details'),
    );
    const req = makeRequest({
      method: 'POST',
      url: '/api/plugin-webhooks/demo-plugin/email-inbound',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(
      res,
      () => state.handleGatewayPluginWebhook.mock.calls.length > 0,
    );

    expect(state.handleGatewayPluginWebhook).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('Internal server error');
    expect(res.body).not.toContain('secret webhook failure details');
    expect(state.loggerError).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Webhook handler failed',
    );
  });

  test('renders docs markdown as a browsable HTML page', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/docs' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain(
      '<title>HybridClaw Docs | HybridClaw Docs</title>',
    );
    expect(res.body).toContain('<h1 id="hybridclaw-docs">HybridClaw Docs');
    expect(res.body).toContain('href="/docs/getting-started"');
    expect(res.body).toContain('href="/docs/channels"');
    expect(res.body).toContain('href="/docs/guides"');
    expect(res.body).toContain('href="/docs/reference"');
    expect(res.body).toContain('href="/docs/extensibility"');
    expect(res.body).toContain('href="/docs/developer-guide"');
    expect(res.body).toContain('aria-label="Search docs"');
    expect(res.body).toContain('>Home</a>');
    expect(res.body).toContain('>GitHub');
    expect(res.body).toContain('>Discord');
    expect(res.body).toContain('On this page');
    expect(res.body).toContain('href="#getting-started"');
    expect(res.body).toContain('data-doc-copy-markdown');
    expect(res.body).toContain('href="/docs/README.md"');
    expect(res.body).not.toContain(
      'class="docs-sidebar-link is-active" href="/docs"',
    );
    expect(res.body).not.toContain('><span>HybridClaw Docs</span></a>');
  });

  test('redirects legacy /development docs routes to /docs', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/development/guides' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(308);
    expect(res.headers.Location).toBe('/docs/guides');
    expect(res.headers['X-HybridClaw-Docs-Redirect']).toBe('legacy');
  });

  test('redirects legacy /docs aliases to the canonical docs structure', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/docs/internals' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(308);
    expect(res.headers.Location).toBe('/docs/developer-guide');
    expect(res.headers['X-HybridClaw-Docs-Redirect']).toBe('legacy');
  });

  test('redirects the legacy getting-started channel guide to the canonical channels overview', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/docs/getting-started/channels' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(308);
    expect(res.headers.Location).toBe('/docs/channels/overview');
    expect(res.headers['X-HybridClaw-Docs-Redirect']).toBe('legacy');
  });

  test('renders section index pages from folder-based routes', async () => {
    const state = await importFreshHealth();

    for (const [pathname, title, heading, anchor] of [
      ['/docs/guides', 'Guides', 'Guides', '#tutorials'],
      ['/docs/reference', 'Reference', 'Reference', '#commands'],
      ['/docs/guides/', 'Guides', 'Guides', '#tutorials'],
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

  test('serves raw markdown when requesting a docs .md path', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/docs/extensibility/README.md' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/markdown; charset=utf-8');
    expect(res.body).toContain('title: Extensibility');
    expect(res.body).toContain('# Extensibility');
    expect(res.body).not.toContain('<!doctype html>');
  });

  test('renders server-side docs search results for ?search queries', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/docs?search=commands' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain(
      '<title>Search: commands | HybridClaw Docs</title>',
    );
    expect(res.body).toContain(
      '<h1 id="docs-search-results">Docs Search Results',
    );
    expect(res.body).toContain('Query: <code>commands</code>');
    expect(res.body).toContain('href="/docs/reference#commands"');
  });

  test('serves docs search results as markdown on .md routes', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/docs/README.md?search=guides' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/markdown; charset=utf-8');
    expect(res.body).toContain('# Docs Search Results');
    expect(res.body).toContain('Query: `guides`');
    expect(res.body).toContain('[Guides](/docs/guides/README.md)');
    expect(res.body).not.toContain('<!doctype html>');
  });

  test('reuses the cached docs snapshot across repeated requests', async () => {
    const installRoot = makeTempDocsDir();
    const state = await importFreshHealth({ docsDir: installRoot });
    const guidesReadmePath = path.join(
      installRoot,
      'docs',
      'content',
      'guides',
      'README.md',
    );

    const firstReq = makeRequest({ url: '/docs/guides' });
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

    const secondReq = makeRequest({ url: '/docs/guides' });
    const secondRes = makeResponse();
    state.handler(secondReq as never, secondRes as never);

    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.body).toContain('Browse the practical docs from here.');
    expect(secondRes.body).not.toContain(
      'This should only appear after the cache expires.',
    );
  });

  test('rejects symlinked markdown pages outside the docs content tree', async () => {
    const installRoot = makeTempDocsDir();
    const secretPath = path.join(installRoot, 'outside-secret.md');
    fs.writeFileSync(secretPath, '# Secret\n', 'utf8');
    fs.symlinkSync(
      secretPath,
      path.join(installRoot, 'docs', 'content', 'guides', 'secret.md'),
    );

    const state = await importFreshHealth({ docsDir: installRoot });
    const req = makeRequest({ url: '/docs/guides/secret' });
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
      path.join(installRoot, 'docs', 'content', 'guides', '_category_.json'),
    );

    const state = await importFreshHealth({ docsDir: installRoot });
    const req = makeRequest({ url: '/docs/guides/heading-order' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('Compromised');
    expect(res.body).toContain('<summary>Guides</summary>');
  });

  test('does not render non-http image sources in docs content', async () => {
    const installRoot = makeTempDocsDir();
    fs.writeFileSync(
      path.join(installRoot, 'docs', 'content', 'guides', 'image-schemes.md'),
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
    const req = makeRequest({ url: '/docs/guides/image-schemes' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<img src="javascript:alert(1)"');
    expect(res.body).toContain('Bad');
    expect(res.body).toContain('id="docs-markdown-source"');
    expect(res.body).toContain('javascript:alert(1)');
  });

  test('returns a visible error for malformed docs frontmatter', async () => {
    const installRoot = makeTempDocsDir({ includeMalformedFrontmatter: true });
    const state = await importFreshHealth({ docsDir: installRoot });
    const req = makeRequest({ url: '/docs/reference/broken' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(500);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('Docs failed to render');
    expect(res.body).toContain('Invalid frontmatter in reference/broken.md');
  });

  test('keeps heading anchors aligned when deep headings appear before repeated sections', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/docs/guides/heading-order' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="#repeated-section"');
    expect(res.body).toContain('href="#repeated-section-2"');
    expect(res.body).toContain('<h2 id="repeated-section">Repeated Section');
    expect(res.body).toContain('<h2 id="repeated-section-2">Repeated Section');
  });

  test('renders individual docs pages by slug', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/docs/extensibility' });
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

    expect(state.ensureGatewayBootstrapAutostart).toHaveBeenCalledWith({
      sessionId: 's1',
    });
    expect(state.getGatewayHistory).toHaveBeenCalledWith('s1', 2);
    expect(state.getGatewayHistorySummary).toHaveBeenCalledWith('s1', {
      sinceMs: null,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      sessionId: 's1',
      sessionKey: undefined,
      mainSessionKey: undefined,
      assistantPresentation: {
        agentId: 'charly',
        displayName: 'Charly',
        imageUrl: '/api/agent-avatar?agentId=charly',
      },
      bootstrapAutostart: null,
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

  test('returns history immediately while BOOTSTRAP autostart is still starting', async () => {
    const state = await importFreshHealth();
    state.ensureGatewayBootstrapAutostart.mockImplementation(
      () => new Promise(() => {}),
    );
    state.getGatewayBootstrapAutostartState.mockReturnValue({
      status: 'starting',
      fileName: 'OPENING.md',
    });

    const req = makeRequest({
      url: '/api/history?sessionId=agent:charly:channel:web:chat:dm:peer:fresh&limit=2',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      sessionId: 'agent:charly:channel:web:chat:dm:peer:fresh',
      bootstrapAutostart: {
        status: 'starting',
        fileName: 'OPENING.md',
      },
    });
  });

  test('streams installed agent avatar assets', async () => {
    const state = await importFreshHealth();
    const avatarPath = path.join(
      state.dataDir,
      'agents',
      'charly',
      'workspace',
      'avatars',
      'charly.png',
    );
    fs.mkdirSync(path.dirname(avatarPath), { recursive: true });
    fs.writeFileSync(avatarPath, Buffer.from('89504e470d0a1a0a', 'hex'));
    const statSyncSpy = vi.spyOn(fs, 'statSync');

    const req = makeRequest({ url: '/api/agent-avatar?agentId=charly' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.getAgentById).toHaveBeenCalledWith('charly');
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.body.length).toBeGreaterThan(0);
    expect(statSyncSpy).not.toHaveBeenCalled();
  });

  test('allows bearer auth for installed agent avatar assets', async () => {
    const dataDir = makeTempDataDir();
    const avatarPath = path.join(
      dataDir,
      'agents',
      'charly',
      'workspace',
      'avatars',
      'charly.png',
    );
    fs.mkdirSync(path.dirname(avatarPath), { recursive: true });
    fs.writeFileSync(avatarPath, Buffer.from('89504e470d0a1a0a', 'hex'));

    const state = await importFreshHealth({
      dataDir,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: '/api/agent-avatar?agentId=charly',
      remoteAddress: '203.0.113.10',
      headers: {
        authorization: 'Bearer web-token',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.body.length).toBeGreaterThan(0);
  });

  test('rejects query-token auth for installed agent avatar assets', async () => {
    const dataDir = makeTempDataDir();
    const avatarPath = path.join(
      dataDir,
      'agents',
      'charly',
      'workspace',
      'avatars',
      'charly.png',
    );
    fs.mkdirSync(path.dirname(avatarPath), { recursive: true });
    fs.writeFileSync(avatarPath, Buffer.from('89504e470d0a1a0a', 'hex'));

    const state = await importFreshHealth({
      dataDir,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: '/api/agent-avatar?agentId=charly&token=web-token',
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

  test('rejects installed agent avatar assets that escape the workspace', async () => {
    const state = await importFreshHealth();
    state.getAgentById.mockImplementation((agentId: string) =>
      agentId === 'charly'
        ? {
            id: 'charly',
            name: 'Charly Agent',
            displayName: 'Charly',
            imageAsset: '../secret.png',
          }
        : null,
    );

    const req = makeRequest({ url: '/api/agent-avatar?agentId=charly' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Agent avatar not found.',
    });
  });

  test('rejects non-image workspace files as installed agent avatar assets', async () => {
    const dataDir = makeTempDataDir();
    const scriptPath = path.join(
      dataDir,
      'agents',
      'charly',
      'workspace',
      'scripts',
      'setup.sh',
    );
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho setup\n', 'utf8');

    const state = await importFreshHealth({
      dataDir,
      webApiToken: 'web-token',
    });
    state.getAgentById.mockImplementation((agentId: string) =>
      agentId === 'charly'
        ? {
            id: 'charly',
            name: 'Charly Agent',
            displayName: 'Charly',
            imageAsset: 'scripts/setup.sh',
          }
        : null,
    );

    const req = makeRequest({
      url: '/api/agent-avatar?agentId=charly',
      remoteAddress: '203.0.113.10',
      headers: {
        authorization: 'Bearer web-token',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Agent avatar not found.',
    });
  });

  test('forks a web chat branch from a message cutoff', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat/branch',
      body: {
        sessionId: 's1',
        beforeMessageId: 9,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.forkSessionBranch).toHaveBeenCalledWith({
      sessionId: 's1',
      beforeMessageId: 9,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      sessionId: 'branch-session-1',
      sessionKey: 'branch-session-1',
      mainSessionKey: 'agent:main:channel:web:chat:dm:peer:family-a',
      copiedMessageCount: 2,
    });
  });

  test('rejects invalid branch requests without a positive cutoff message id', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat/branch',
      body: {
        sessionId: 's1',
        beforeMessageId: 0,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.forkSessionBranch).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error:
        'Missing valid positive integer `beforeMessageId` in request body.',
    });
  });

  test('rejects branch requests with trailing non-numeric characters', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat/branch',
      body: {
        sessionId: 's1',
        beforeMessageId: '9abc',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.forkSessionBranch).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error:
        'Missing valid positive integer `beforeMessageId` in request body.',
    });
  });

  test('returns 500 when branch creation fails unexpectedly', async () => {
    const state = await importFreshHealth();
    state.forkSessionBranch.mockImplementation(() => {
      throw new Error('sqlite busy');
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat/branch',
      body: {
        sessionId: 's1',
        beforeMessageId: 9,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      error: 'sqlite busy',
    });
  });

  test('returns recent chat sessions for authorized loopback API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/chat/recent?userId=web-user-a&channelId=web&limit=10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.getGatewayRecentChatSessions).toHaveBeenCalledWith({
      userId: 'web-user-a',
      channelId: 'web',
      limit: 10,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      sessions: [
        {
          sessionId: 'web-session-2',
          title: '"Follow-up question from user A"',
          lastActive: '2026-03-24T10:00:00.000Z',
          messageCount: 1,
        },
        {
          sessionId: 'web-session-1',
          title: '"First web question from user A" ... "Assistant reply A1"',
          lastActive: '2026-03-24T09:01:00.000Z',
          messageCount: 2,
        },
      ],
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

  test('rejects recent chat requests without an explicit user id', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/chat/recent?limit=10' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayRecentChatSessions).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Missing `userId` query parameter.',
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

  test('returns live admin email mailbox metadata for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/email' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminEmailMailbox).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      enabled: true,
      address: 'agent@example.com',
      defaultFolder: 'INBOX',
    });
  });

  test('rejects unauthorized requests for live admin email mailbox metadata', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });
    const req = makeRequest({
      url: '/api/admin/email',
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.getGatewayAdminEmailMailbox).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
    });
  });

  test('returns live admin email messages for a selected folder', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/email/messages?folder=INBOX&limit=20',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminEmailFolder).toHaveBeenCalledWith({
      folder: 'INBOX',
      limit: 20,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      folder: 'INBOX',
      messages: [
        {
          uid: 44,
          subject: 'Quarterly plan',
        },
      ],
    });
  });

  test('passes mailbox pagination params for a selected folder', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/email/messages?folder=INBOX&limit=20&offset=40',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminEmailFolder).toHaveBeenCalledWith({
      folder: 'INBOX',
      limit: 20,
      offset: 40,
    });
    expect(res.statusCode).toBe(200);
  });

  test('returns live admin email message detail for a selected message', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/email/message?folder=INBOX&uid=44',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminEmailMessage).toHaveBeenCalledWith({
      folder: 'INBOX',
      uid: 44,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      message: {
        uid: 44,
        subject: 'Quarterly plan',
        text: 'Full message body',
      },
    });
  });

  test('returns live admin email message detail for a synthetic sent message', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/email/message?folder=Sent&uid=-2000113423',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminEmailMessage).toHaveBeenCalledWith({
      folder: 'Sent',
      uid: -2000113423,
    });
    expect(res.statusCode).toBe(200);
  });

  test('deletes a live admin email message for an authorized API request', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'DELETE',
      url: '/api/admin/email/message?folder=INBOX&uid=44',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.deleteGatewayAdminEmailMessage).toHaveBeenCalledWith({
      folder: 'INBOX',
      uid: 44,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      deleted: true,
      targetFolder: 'Trash',
      permanent: false,
    });
  });

  test('requests a managed gateway restart for authorized admin API calls', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback: TimerHandler) => {
        if (typeof callback === 'function') {
          callback();
        }
        return 0 as ReturnType<typeof setTimeout>;
      });
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/restart',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.requestGatewayRestart).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      status: 'ok',
      message: 'Gateway restart requested.',
    });
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  test('returns a conflict when gateway restart is unavailable', async () => {
    const state = await importFreshHealth();
    state.requestGatewayRestart.mockReturnValue({
      restartSupported: false,
      restartReason: 'Gateway restart is unavailable in this launch mode.',
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/restart',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Gateway restart is unavailable in this launch mode.',
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
          skills: null,
          chatbotId: null,
          enableRag: true,
          workspace: null,
          workspacePath: '/tmp/main/workspace',
          markdownFiles: [
            {
              name: 'AGENTS.md',
              path: '/tmp/main/workspace/AGENTS.md',
              exists: true,
              updatedAt: '2026-04-13T10:00:00.000Z',
              sizeBytes: 120,
            },
            {
              name: 'USER.md',
              path: '/tmp/main/workspace/USER.md',
              exists: false,
              updatedAt: null,
              sizeBytes: null,
            },
          ],
        },
      ],
    });
  });

  test('returns 404 for admin agent routes with a blank decoded agent id segment', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/agents/%20' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.updateGatewayAdminAgent).not.toHaveBeenCalled();
    expect(state.deleteGatewayAdminAgent).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not Found' });
  });

  test('passes skill allowlists through admin agent creation requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/agents',
      headers: {
        'content-type': 'application/json',
      },
      body: {
        id: 'writer',
        skills: ['draft-outline', ' copy-edit '],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.createGatewayAdminAgent).toHaveBeenCalledWith({
      id: 'writer',
      name: undefined,
      model: undefined,
      skills: ['draft-outline', 'copy-edit'],
      chatbotId: undefined,
      enableRag: undefined,
      workspace: undefined,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      agent: {
        id: 'writer',
        name: null,
        model: null,
        skills: ['draft-outline', 'copy-edit'],
        chatbotId: null,
        enableRag: null,
        workspace: null,
        workspacePath: '/tmp/main/workspace',
        markdownFiles: [
          {
            name: 'AGENTS.md',
            path: '/tmp/main/workspace/AGENTS.md',
            exists: true,
            updatedAt: '2026-04-13T10:00:00.000Z',
            sizeBytes: 120,
          },
          {
            name: 'USER.md',
            path: '/tmp/main/workspace/USER.md',
            exists: false,
            updatedAt: null,
            sizeBytes: null,
          },
        ],
      },
    });
  });

  test('returns 400 when admin agent skills is not an array or null', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/agents',
      headers: {
        'content-type': 'application/json',
      },
      body: {
        id: 'writer',
        skills: 'copy-edit',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.createGatewayAdminAgent).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Expected `skills` to be an array or null.',
    });
  });

  test('passes null skill allowlists through admin agent update requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/agents/writer',
      headers: {
        'content-type': 'application/json',
      },
      body: {
        skills: null,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.updateGatewayAdminAgent).toHaveBeenCalledWith('writer', {
      name: undefined,
      model: undefined,
      skills: null,
      chatbotId: undefined,
      enableRag: undefined,
      workspace: undefined,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      agent: {
        id: 'writer',
        name: null,
        model: null,
        skills: null,
        chatbotId: null,
        enableRag: null,
        workspace: null,
        workspacePath: '/tmp/writer/workspace',
        markdownFiles: [
          {
            name: 'AGENTS.md',
            path: '/tmp/writer/workspace/AGENTS.md',
            exists: true,
            updatedAt: '2026-04-13T11:00:00.000Z',
            sizeBytes: 64,
          },
          {
            name: 'USER.md',
            path: '/tmp/writer/workspace/USER.md',
            exists: true,
            updatedAt: '2026-04-13T12:00:00.000Z',
            sizeBytes: 72,
          },
        ],
      },
    });
  });

  test('returns the selected admin agent markdown file', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/agents/main/files/AGENTS.md',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminAgentMarkdownFile).toHaveBeenCalledWith(
      'main',
      'AGENTS.md',
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      agent: {
        id: 'main',
        name: 'Main Agent',
        model: 'gpt-5',
        skills: null,
        chatbotId: null,
        enableRag: true,
        workspace: null,
        workspacePath: '/tmp/main/workspace',
        markdownFiles: [
          {
            name: 'AGENTS.md',
            path: '/tmp/main/workspace/AGENTS.md',
            exists: true,
            updatedAt: '2026-04-13T10:00:00.000Z',
            sizeBytes: 120,
          },
          {
            name: 'USER.md',
            path: '/tmp/main/workspace/USER.md',
            exists: false,
            updatedAt: null,
            sizeBytes: null,
          },
        ],
      },
      file: {
        name: 'AGENTS.md',
        path: '/tmp/main/workspace/AGENTS.md',
        exists: true,
        updatedAt: '2026-04-13T10:00:00.000Z',
        sizeBytes: 120,
        content: '# main:AGENTS.md\n',
        revisions: [
          {
            id: 'main-rev-1',
            createdAt: '2026-04-13T09:00:00.000Z',
            sizeBytes: 96,
            sha256: 'mainsha',
            source: 'save',
          },
        ],
      },
    });
  });

  test('returns the selected admin agent markdown revision', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/agents/main/files/AGENTS.md/revisions/main-rev-1',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminAgentMarkdownRevision).toHaveBeenCalledWith({
      agentId: 'main',
      fileName: 'AGENTS.md',
      revisionId: 'main-rev-1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      agent: {
        id: 'main',
        name: 'Main Agent',
        model: 'gpt-5',
        skills: null,
        chatbotId: null,
        enableRag: true,
        workspace: null,
        workspacePath: '/tmp/main/workspace',
        markdownFiles: [
          {
            name: 'AGENTS.md',
            path: '/tmp/main/workspace/AGENTS.md',
            exists: true,
            updatedAt: '2026-04-13T10:00:00.000Z',
            sizeBytes: 120,
          },
          {
            name: 'USER.md',
            path: '/tmp/main/workspace/USER.md',
            exists: false,
            updatedAt: null,
            sizeBytes: null,
          },
        ],
      },
      fileName: 'AGENTS.md',
      revision: {
        id: 'main-rev-1',
        createdAt: '2026-04-13T09:00:00.000Z',
        sizeBytes: 96,
        sha256: 'mainsha',
        source: 'save',
        content: '# revision main:AGENTS.md:main-rev-1\n',
      },
    });
  });

  test('returns 404 for known admin agent markdown revision not-found errors', async () => {
    const state = await importFreshHealth();
    state.getGatewayAdminAgentMarkdownRevision.mockImplementationOnce(() => {
      throw new Error('Revision "missing-rev" was not found.');
    });
    const req = makeRequest({
      url: '/api/admin/agents/main/files/AGENTS.md/revisions/missing-rev',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Revision "missing-rev" was not found.',
    });
  });

  test('returns 400 for unrelated admin agent errors that contain "not found"', async () => {
    const state = await importFreshHealth();
    state.getGatewayAdminAgentMarkdownRevision.mockImplementationOnce(() => {
      throw new Error('Validation key not found in request body.');
    });
    const req = makeRequest({
      url: '/api/admin/agents/main/files/AGENTS.md/revisions/main-rev-1',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Validation key not found in request body.',
    });
  });

  test('saves the selected admin agent markdown file', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/agents/writer/files/USER.md',
      headers: {
        'content-type': 'application/json',
      },
      body: {
        content: '# Updated writer prompt\n',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.saveGatewayAdminAgentMarkdownFile).toHaveBeenCalledWith({
      agentId: 'writer',
      fileName: 'USER.md',
      content: '# Updated writer prompt\n',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      agent: {
        id: 'writer',
        name: 'Writer',
        model: null,
        skills: null,
        chatbotId: null,
        enableRag: null,
        workspace: null,
        workspacePath: '/tmp/writer/workspace',
        markdownFiles: [
          {
            name: 'AGENTS.md',
            path: '/tmp/writer/workspace/AGENTS.md',
            exists: true,
            updatedAt: '2026-04-13T11:00:00.000Z',
            sizeBytes: 64,
          },
          {
            name: 'USER.md',
            path: '/tmp/writer/workspace/USER.md',
            exists: true,
            updatedAt: '2026-04-13T12:00:00.000Z',
            sizeBytes: 72,
          },
        ],
      },
      file: {
        name: 'USER.md',
        path: '/tmp/writer/workspace/USER.md',
        exists: true,
        updatedAt: '2026-04-13T12:00:00.000Z',
        sizeBytes: 72,
        content: '# Updated writer prompt\n',
        revisions: [
          {
            id: 'writer-rev-1',
            createdAt: '2026-04-13T11:30:00.000Z',
            sizeBytes: 72,
            sha256: 'writersha',
            source: 'restore',
          },
        ],
      },
    });
  });

  test('restores the selected admin agent markdown revision', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/agents/writer/files/USER.md/revisions/writer-rev-1/restore',
      headers: {
        'content-type': 'application/json',
      },
      body: {},
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.restoreGatewayAdminAgentMarkdownRevision).toHaveBeenCalledWith(
      {
        agentId: 'writer',
        fileName: 'USER.md',
        revisionId: 'writer-rev-1',
      },
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      agent: {
        id: 'writer',
        name: 'Writer',
        model: null,
        skills: null,
        chatbotId: null,
        enableRag: null,
        workspace: null,
        workspacePath: '/tmp/writer/workspace',
        markdownFiles: [
          {
            name: 'AGENTS.md',
            path: '/tmp/writer/workspace/AGENTS.md',
            exists: true,
            updatedAt: '2026-04-13T11:00:00.000Z',
            sizeBytes: 64,
          },
          {
            name: 'USER.md',
            path: '/tmp/writer/workspace/USER.md',
            exists: true,
            updatedAt: '2026-04-13T12:00:00.000Z',
            sizeBytes: 72,
          },
        ],
      },
      file: {
        name: 'USER.md',
        path: '/tmp/writer/workspace/USER.md',
        exists: true,
        updatedAt: '2026-04-13T12:00:00.000Z',
        sizeBytes: 72,
        content: '# restored writer-rev-1\n',
        revisions: [
          {
            id: 'writer-rev-1',
            createdAt: '2026-04-13T11:30:00.000Z',
            sizeBytes: 72,
            sha256: 'writersha',
            source: 'restore',
          },
        ],
      },
    });
  });

  test('returns 400 when admin agent markdown content is not a string', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/agents/writer/files/USER.md',
      headers: {
        'content-type': 'application/json',
      },
      body: {
        content: 42,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.saveGatewayAdminAgentMarkdownFile).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Expected string `content` in request body.',
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

  test('returns lightweight jobs context for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/jobs/context' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminJobsContext).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      agents: [{ id: 'main', name: 'Main Agent' }],
      sessions: [
        {
          sessionId: 'scheduler:job-1',
          agentId: 'main',
          startedAt: '2026-03-27T08:00:00.000Z',
          lastActive: '2026-03-27T08:05:00.000Z',
          status: 'active',
          lastAnswer: 'Done.',
          output: ['recent output'],
        },
      ],
    });
  });

  test('starts an admin terminal session for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/terminal',
      body: {
        cols: 140,
        rows: 40,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.startTerminalSession).toHaveBeenCalledWith({
      cols: 140,
      rows: 40,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      sessionId: 'terminal-session-1',
      websocketPath: '/api/admin/terminal/stream?sessionId=terminal-session-1',
    });
  });

  test('stops an admin terminal session for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'DELETE',
      url: '/api/admin/terminal?sessionId=terminal-session-1',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.stopTerminalSession).toHaveBeenCalledWith(
      'terminal-session-1',
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      stopped: true,
    });
  });

  test('returns 404 for unsupported admin terminal methods at the route layer', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'GET',
      url: '/api/admin/terminal',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.startTerminalSession).not.toHaveBeenCalled();
    expect(state.stopTerminalSession).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not Found' });
  });

  test('returns 429 when the admin terminal session cap is reached', async () => {
    const state = await importFreshHealth();
    state.startTerminalSession.mockImplementationOnce(() => {
      throw new state.GatewayRequestError(
        429,
        'Too many active admin terminal sessions.',
      );
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/terminal',
      body: {
        cols: 140,
        rows: 40,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Too many active admin terminal sessions.',
    });
  });

  test('rejects terminal websocket upgrades without session auth or direct request auth', async () => {
    const state = await importFreshHealth();
    const socket = {
      write: vi.fn(),
      destroy: vi.fn(),
    };

    state.upgradeHandler?.(
      makeRequest({
        method: 'GET',
        url: '/api/admin/terminal/stream?sessionId=terminal-session-1',
        remoteAddress: '10.0.0.5',
      }) as never,
      socket as never,
      Buffer.alloc(0) as never,
    );

    expect(state.handleTerminalUpgrade).not.toHaveBeenCalled();
    expect(String(socket.write.mock.calls[0]?.[0] || '')).toContain(
      '401 Unauthorized',
    );
  });

  test('allows loopback terminal websocket upgrades to attach immediately', async () => {
    const state = await importFreshHealth();
    const socket = {
      write: vi.fn(),
      destroy: vi.fn(),
    };

    state.upgradeHandler?.(
      makeRequest({
        method: 'GET',
        url: '/api/admin/terminal/stream?sessionId=terminal-session-1',
      }) as never,
      socket as never,
      Buffer.alloc(0) as never,
    );

    expect(state.handleTerminalUpgrade).toHaveBeenCalledWith(
      expect.anything(),
      socket,
      expect.any(Buffer),
      expect.any(URL),
      expect.objectContaining({
        hasSessionAuth: false,
        hasRequestAuth: true,
        validateToken: expect.any(Function),
      }),
    );
    expect(socket.write).not.toHaveBeenCalled();
  });

  test('allows terminal websocket upgrades to authenticate with a first-frame token', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });
    const socket = {
      write: vi.fn(),
      destroy: vi.fn(),
    };

    state.upgradeHandler?.(
      makeRequest({
        method: 'GET',
        url: '/api/admin/terminal/stream?sessionId=terminal-session-1',
      }) as never,
      socket as never,
      Buffer.alloc(0) as never,
    );

    expect(state.handleTerminalUpgrade).toHaveBeenCalledWith(
      expect.anything(),
      socket,
      expect.any(Buffer),
      expect.any(URL),
      expect.objectContaining({
        hasSessionAuth: false,
        validateToken: expect.any(Function),
      }),
    );
    expect(socket.write).not.toHaveBeenCalled();
  });

  test('rejects invalid scheduler move boardStatus values', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/scheduler',
      body: {
        action: 'move',
        jobId: 'job-1',
        boardStatus: 'bogus',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.moveGatewayAdminSchedulerJob).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error:
        'Scheduler board status must be `backlog`, `in_progress`, `review`, `done`, or `cancelled`.',
    });
  });

  test('passes scheduler move boardStatus only when explicitly provided', async () => {
    const state = await importFreshHealth();

    const withoutBoardStatusReq = makeRequest({
      method: 'POST',
      url: '/api/admin/scheduler',
      body: {
        action: 'move',
        jobId: 'job-1',
      },
    });
    const withoutBoardStatusRes = makeResponse();

    state.handler(
      withoutBoardStatusReq as never,
      withoutBoardStatusRes as never,
    );
    await settle();

    expect(state.moveGatewayAdminSchedulerJob.mock.calls[0]?.[0]).toEqual({
      jobId: 'job-1',
      beforeJobId: null,
    });

    const clearBoardStatusReq = makeRequest({
      method: 'POST',
      url: '/api/admin/scheduler',
      body: {
        action: 'move',
        jobId: 'job-1',
        boardStatus: null,
      },
    });
    const clearBoardStatusRes = makeResponse();

    state.handler(clearBoardStatusReq as never, clearBoardStatusRes as never);
    await settle();

    expect(state.moveGatewayAdminSchedulerJob.mock.calls[1]?.[0]).toEqual({
      jobId: 'job-1',
      beforeJobId: null,
      boardStatus: null,
    });
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

  test('creates admin skills for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/skills',
      body: {
        name: 'my-skill',
        description: 'Create a test skill',
        category: 'memory',
        shortDescription: 'Quick summary',
        userInvocable: false,
        disableModelInvocation: true,
        tags: ['admin', 'tools'],
        body: '# My Skill',
        files: [{ path: 'scripts/run.mjs', content: 'console.log("ok");' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.createGatewayAdminSkill).toHaveBeenCalledWith({
      body: '# My Skill',
      category: 'memory',
      description: 'Create a test skill',
      disableModelInvocation: true,
      files: [{ path: 'scripts/run.mjs', content: 'console.log("ok");' }],
      name: 'my-skill',
      shortDescription: 'Quick summary',
      tags: ['admin', 'tools'],
      userInvocable: false,
    });
    expect(res.statusCode).toBe(201);
  });

  test('returns 400 for invalid admin skill file paths', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/skills',
      body: {
        name: 'my-skill',
        description: 'Create a test skill',
        body: '# My Skill',
        files: [{ path: 'scripts/', content: '' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.createGatewayAdminSkill).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Skill file paths must be non-empty and include a filename.',
    });
  });

  test('returns 400 for malformed admin skill file entries', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/skills',
      body: {
        name: 'my-skill',
        description: 'Create a test skill',
        body: '# My Skill',
        files: [{ content: 'console.log("ok");' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.createGatewayAdminSkill).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error:
        'Expected each skill file to be an object with string `path` and optional string `content`.',
    });
  });

  test('returns 400 when admin skill files is not an array', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/skills',
      body: {
        name: 'my-skill',
        description: 'Create a test skill',
        body: '# My Skill',
        files: 'scripts/run.mjs',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.createGatewayAdminSkill).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error:
        'Expected `files` to be an array of objects with string `path` and optional string `content`.',
    });
  });

  test('returns 405 for unsupported admin skill methods', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'DELETE',
      url: '/api/admin/skills',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.createGatewayAdminSkill).not.toHaveBeenCalled();
    expect(state.setGatewayAdminSkillEnabled).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Method DELETE is not allowed.',
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

  test('uploads admin skill zip archives for authorized API requests', async () => {
    const state = await importFreshHealth();
    const zipBuffer = Buffer.from('zip-bytes');
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/skills/upload',
      body: zipBuffer,
      headers: {
        'content-type': 'application/zip',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.uploadGatewayAdminSkillZip).toHaveBeenCalledWith(zipBuffer);
    expect(res.statusCode).toBe(201);
  });

  test('returns 400 for empty admin skill zip uploads', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/skills/upload',
      body: Buffer.alloc(0),
      headers: {
        'content-type': 'application/zip',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.uploadGatewayAdminSkillZip).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Expected a non-empty skill zip upload body.',
    });
  });

  test('returns 413 for oversized admin skill zip uploads', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/skills/upload',
      body: Buffer.alloc(10 * 1024 * 1024 + 1, 1),
      headers: {
        'content-type': 'application/zip',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.uploadGatewayAdminSkillZip).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Skill zip upload exceeds the maximum size of 10485760 bytes.',
    });
  });

  test('returns 400 for invalid admin skill zip archives', async () => {
    const state = await importFreshHealth();
    state.uploadGatewayAdminSkillZip.mockImplementation(async () => {
      throw new state.GatewayRequestError(
        400,
        'Uploaded file is not a valid skill ZIP archive.',
      );
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/skills/upload',
      body: Buffer.from('not-a-zip'),
      headers: {
        'content-type': 'application/zip',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Uploaded file is not a valid skill ZIP archive.',
    });
  });

  test('returns 409 when uploaded admin skill zip already exists', async () => {
    const state = await importFreshHealth();
    state.uploadGatewayAdminSkillZip.mockImplementation(async () => {
      throw new state.GatewayRequestError(
        409,
        'Skill `my-skill` already exists at /tmp/skills/my-skill.',
      );
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/skills/upload',
      body: Buffer.from('zip-bytes'),
      headers: {
        'content-type': 'application/zip',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Skill `my-skill` already exists at /tmp/skills/my-skill.',
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

  test('lists slash command suggestions for the web chat UI', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'GET',
      url: '/api/chat/commands',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(state.listLoadedPluginCommands).toHaveBeenCalledTimes(1);
    const body = JSON.parse(res.body);
    expect(body.commands.length).toBeGreaterThan(0);
    expect(body.commands.map((cmd: { label: string }) => cmd.label)).toEqual(
      [...body.commands.map((cmd: { label: string }) => cmd.label)].sort(
        (left: string, right: string) =>
          left.localeCompare(right, undefined, {
            numeric: true,
            sensitivity: 'base',
          }),
      ),
    );
    expect(body.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'demo_status',
          label: '/demo_status',
          insertText: '/demo_status',
          description: 'Run the demo plugin status command',
          depth: 1,
        }),
      ]),
    );
    for (const cmd of body.commands) {
      expect(cmd).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          label: expect.any(String),
          insertText: expect.any(String),
          description: expect.any(String),
          depth: expect.any(Number),
        }),
      );
    }
  });

  test('filters slash command suggestions by query parameter', async () => {
    const state = await importFreshHealth();

    // Searching for a nested subcommand surfaces it at the top.
    const approveReq = makeRequest({
      method: 'GET',
      url: '/api/chat/commands?q=approve%20view',
    });
    const approveRes = makeResponse();
    state.handler(approveReq as never, approveRes as never);
    await waitForResponse(approveRes, (next) => next.writableEnded);

    expect(approveRes.statusCode).toBe(200);
    expect(JSON.parse(approveRes.body).commands[0]).toEqual(
      expect.objectContaining({
        id: 'approve.view',
        label: '/approve view [approval_id]',
        insertText: '/approve view ',
        depth: 2,
      }),
    );

    // Searching for a plugin command surfaces it.
    const pluginReq = makeRequest({
      method: 'GET',
      url: '/api/chat/commands?q=demo_status',
    });
    const pluginRes = makeResponse();
    state.handler(pluginReq as never, pluginRes as never);
    await waitForResponse(pluginRes, (next) => next.writableEnded);

    expect(pluginRes.statusCode).toBe(200);
    expect(JSON.parse(pluginRes.body).commands[0]).toEqual(
      expect.objectContaining({
        id: 'demo_status',
        label: '/demo_status',
        insertText: '/demo_status',
        description: 'Run the demo plugin status command',
        depth: 1,
      }),
    );
  });

  test('returns empty commands array for a query that matches nothing', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'GET',
      url: '/api/chat/commands?q=zzzznonexistent',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ commands: [] });
  });

  test('invalidates cached slash commands when plugin list changes', async () => {
    const state = await importFreshHealth();

    // First request populates cache with demo_status plugin.
    const req1 = makeRequest({
      method: 'GET',
      url: '/api/chat/commands?q=demo_status',
    });
    const res1 = makeResponse();
    state.handler(req1 as never, res1 as never);
    await waitForResponse(res1, (next) => next.writableEnded);
    expect(JSON.parse(res1.body).commands[0]).toEqual(
      expect.objectContaining({ id: 'demo_status' }),
    );

    // Change the plugin list — remove the demo_status plugin.
    state.listLoadedPluginCommands.mockReturnValue([]);

    const req2 = makeRequest({
      method: 'GET',
      url: '/api/chat/commands?q=demo_status',
    });
    const res2 = makeResponse();
    state.handler(req2 as never, res2 as never);
    await waitForResponse(res2, (next) => next.writableEnded);

    // demo_status should no longer appear.
    const commands = JSON.parse(res2.body).commands;
    expect(
      commands.find((c: { id: string }) => c.id === 'demo_status'),
    ).toBeUndefined();
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

  test('handles /approve always from the web chat path', async () => {
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
    state.handleGatewayMessage.mockResolvedValue({
      status: 'success',
      result: 'Approved.',
      sessionId: 'session-web-approve',
      toolsUsed: [],
      artifacts: [],
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: {
        sessionId: 'session-web-approve',
        channelId: 'web',
        userId: 'user-web',
        username: 'web',
        content: '/approve always',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.handleGatewayCommand).not.toHaveBeenCalled();
    expect(state.handleGatewayMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-web-approve',
        content: 'yes approve-123 for session',
      }),
    );
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'success',
      result: 'Approved.',
      sessionId: 'session-web-approve',
    });

    await pendingApprovals.clearPendingApproval('session-web-approve');
  });

  test('preserves pending approval metadata for /approve yes on the web chat stream path', async () => {
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
    state.handleGatewayMessage.mockResolvedValue({
      status: 'success',
      result:
        'Approval needed for: access clawhub.ai\nWhy: this would contact a new external host\nApproval ID: be945bbf',
      sessionId: 'session-web-approve',
      toolsUsed: ['web_fetch'],
      pendingApproval: {
        approvalId: 'be945bbf',
        prompt:
          'I need your approval before I access clawhub.ai.\nWhy: this would contact a new external host\nApproval ID: be945bbf',
        intent: 'access clawhub.ai',
        reason: 'this would contact a new external host',
        allowSession: true,
        allowAgent: true,
        allowAll: true,
        expiresAt: 1_710_000_000_000,
      },
      artifacts: [],
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: {
        sessionId: 'session-web-approve',
        channelId: 'web',
        userId: 'user-web',
        username: 'web',
        content: '/approve yes',
        stream: true,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.handleGatewayCommand).not.toHaveBeenCalled();
    expect(state.handleGatewayMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-web-approve',
        content: 'yes approve-123',
      }),
    );
    const events = res.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      {
        type: 'result',
        result: expect.objectContaining({
          status: 'success',
          sessionId: 'session-web-approve',
          pendingApproval: {
            approvalId: 'be945bbf',
            prompt:
              'I need your approval before I access clawhub.ai.\nWhy: this would contact a new external host\nApproval ID: be945bbf',
            intent: 'access clawhub.ai',
            reason: 'this would contact a new external host',
            allowSession: true,
            allowAgent: true,
            allowAll: true,
            expiresAt: 1_710_000_000_000,
          },
        }),
      },
    ]);

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
        summary:
          'Approval needed for: control a local app with `open -a Music`\nWhy: this command controls host GUI or application state\nApproval ID: approve123',
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
      summary:
        'Approval needed for: control a local app with `open -a Music`\nWhy: this command controls host GUI or application state\nApproval ID: approve123',
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
        inReplyTo: ' <msg-1@example.com> ',
        references: [' <ref-1@example.com> ', '<msg-1@example.com>'],
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
        inReplyTo: '<msg-1@example.com>',
        references: ['<ref-1@example.com>', '<msg-1@example.com>'],
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  test('rejects malformed cc email addresses for message actions', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/message/action',
      body: {
        action: 'reply',
        channelId: 'ops@example.com',
        content: 'hello',
        cc: ['not-an-email'],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.runMessageToolAction).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Invalid `cc` email address: not-an-email',
    });
  });

  test('rejects malformed references for message actions', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/message/action',
      body: {
        action: 'reply',
        channelId: 'ops@example.com',
        content: 'hello',
        references: 7,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.runMessageToolAction).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: '`references` must be a string or array of strings.',
    });
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

  test('dispatches gateway-owned http requests with URL auth rules and secret placeholders', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-http-'));
    tempDirs.push(homeDir);
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir, (config) => {
      const tools = config.tools as Record<string, unknown>;
      tools.httpRequest = {
        authRules: [
          {
            urlPrefix: 'https://hybridai.one/v1/',
            header: 'Authorization',
            prefix: 'Bearer',
            secret: { source: 'store', id: 'HYBRIDAI_API_KEY' },
          },
        ],
      };
    });

    const { saveNamedRuntimeSecrets } = await import(
      '../src/security/runtime-secrets.ts'
    );
    saveNamedRuntimeSecrets({
      HYBRIDAI_API_KEY: 'hai-secret-token',
      TRACE_TOKEN: 'trace-secret',
    });

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '104.21.30.182', family: 4 }]),
    }));
    const state = await importFreshHealth({ gatewayApiToken: 'gateway-token' });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://hybridai.one/v1/completions',
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: async () =>
        Buffer.from(JSON.stringify({ ok: true, id: 'completion-1' })),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://hybridai.one/v1/completions',
        method: 'POST',
        headers: {
          'X-Trace': '<secret:TRACE_TOKEN>',
        },
        json: {
          prompt: 'Hallo Welt!',
          metadata: {
            trace: '<secret:TRACE_TOKEN>',
          },
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer hai-secret-token',
          'Content-Type': 'application/json',
          'X-Trace': 'trace-secret',
        }),
        body: JSON.stringify({
          prompt: 'Hallo Welt!',
          metadata: {
            trace: 'trace-secret',
          },
        }),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://hybridai.one/v1/completions',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ok: true, id: 'completion-1' }),
      json: { ok: true, id: 'completion-1' },
    });
  });

  test('blocks outbound http_request redirects to avoid SSRF bypasses', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '104.21.30.182', family: 4 }]),
    }));
    const state = await importFreshHealth({ gatewayApiToken: 'gateway-token' });
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 302,
      statusText: 'Found',
      headers: new Headers({ location: 'http://169.254.169.254/latest' }),
      body: null,
      url: 'https://hybridai.one/v1/completions',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://hybridai.one/v1/completions',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Outbound HTTP redirects are blocked by the SSRF guard.',
    });
  });

  test('fails closed when dns lookup for http_request host fails', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => {
        throw new Error('dns unavailable');
      }),
    }));
    const state = await importFreshHealth({ gatewayApiToken: 'gateway-token' });
    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://hybridai.one/v1/completions',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error:
        'HTTP request blocked by SSRF guard: private or loopback host (hybridai.one).',
    });
    expect(state.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'hybridai.one',
        error: expect.any(Error),
      }),
      'DNS lookup failed during SSRF host check; treating host as private/blocked',
    );
  });

  test('streams outbound http_request responses and aborts once the size limit is exceeded', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '104.21.30.182', family: 4 }]),
    }));
    const state = await importFreshHealth({ gatewayApiToken: 'gateway-token' });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.alloc(6, 0x61));
              controller.enqueue(Buffer.alloc(6, 0x62));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://hybridai.one/v1/completions',
        maxResponseBytes: 10,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Outbound response exceeded limit (12 bytes > 10).',
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

  test('/ready returns 503 before setReady is called', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/ready' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { ready: boolean; uptimeMs: number };
    expect(body.ready).toBe(false);
    expect(typeof body.uptimeMs).toBe('number');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  test('/ready returns 200 after setReady is called', async () => {
    const state = await importFreshHealth();
    state.httpServer.setReady();

    const req = makeRequest({ url: '/ready' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ready: true });
  });

  test('/readyz behaves identically to /ready', async () => {
    const state = await importFreshHealth();
    state.httpServer.setReady();

    const req = makeRequest({ url: '/readyz' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ready: true });
  });

  test('/ready uptimeMs reflects time since server start, not module load', async () => {
    const before = Date.now();
    const state = await importFreshHealth();
    const after = Date.now();

    const req = makeRequest({ url: '/ready' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    const body = JSON.parse(res.body) as { uptimeMs: number };
    // uptimeMs should be within the import window, not a stale module-load timestamp
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(body.uptimeMs).toBeLessThanOrEqual(after - before + 100);
  });

  test('broadcastShutdown sends shutdown event to SSE clients and notifies terminal manager', async () => {
    const state = await importFreshHealth();

    // Register an active SSE response
    const sseReq = makeRequest({ url: '/api/events' });
    const sseRes = makeResponse();
    state.handler(sseReq as never, sseRes as never);
    await settle();

    // Trigger the shutdown broadcast
    state.httpServer.broadcastShutdown();

    expect(sseRes.body).toContain('event: shutdown');
    expect(sseRes.body).toContain('"type":"shutdown"');
    expect(sseRes.writableEnded).toBe(true);
    expect(state.broadcastShutdownTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'shutdown' }),
    );
  });
});
