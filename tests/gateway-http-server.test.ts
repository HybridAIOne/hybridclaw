import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.ts';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const DEFAULT_WEB_SESSION_ID = 'agent:main:channel:web:chat:dm:peer:default';
const WEB_SESSION_ID_RE = /^agent:[^:]+:channel:web:chat:dm:peer:[a-f0-9]{16}$/;
const OPENAI_SESSION_ID_RE =
  /^agent:[^:]+:channel:openai:chat:dm:peer:[a-f0-9]{16}$/;
const OPENAI_EXECUTION_SESSION_ID_RE =
  /^agent:[^:]+:channel:openai:chat:dm:peer:(?:[a-f0-9]{16}|exec-[a-f0-9]{24})$/;
const OPENAI_COMPLETION_ID_RE = /^chatcmpl_[a-f0-9]{32}$/;
const DEFAULT_TEST_GATEWAY_API_TOKEN = 'gateway-token';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_HYBRIDCLAW_AUTH_SECRET = process.env.HYBRIDCLAW_AUTH_SECRET;
const makeTempDocsRoot = useTempDir('hybridclaw-health-');

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
  const root = makeTempDocsRoot();
  const docsDir = path.join(root, 'docs');
  const contentDocsDir = path.join(docsDir, 'content');
  const gettingStartedDir = path.join(contentDocsDir, 'getting-started');
  const channelsDir = path.join(contentDocsDir, 'channels');
  const extensibilityDir = path.join(contentDocsDir, 'extensibility');
  const guidesDir = path.join(contentDocsDir, 'guides');
  const developerGuideDir = path.join(contentDocsDir, 'developer-guide');
  const internalDir = path.join(contentDocsDir, 'internal');
  const referenceDir = path.join(contentDocsDir, 'reference');
  const consoleDistDir = path.join(root, 'console', 'dist');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(contentDocsDir, { recursive: true });
  fs.mkdirSync(gettingStartedDir, { recursive: true });
  fs.mkdirSync(channelsDir, { recursive: true });
  fs.mkdirSync(extensibilityDir, { recursive: true });
  fs.mkdirSync(guidesDir, { recursive: true });
  fs.mkdirSync(developerGuideDir, { recursive: true });
  fs.mkdirSync(internalDir, { recursive: true });
  fs.mkdirSync(referenceDir, { recursive: true });
  fs.mkdirSync(consoleDistDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'index.html'), '<h1>Docs</h1>', 'utf8');
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
  fs.mkdirSync(path.join(consoleDistDir, 'icons'), { recursive: true });
  fs.writeFileSync(
    path.join(consoleDistDir, 'icons', 'github.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" />',
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
    path.join(internalDir, 'roadmap.md'),
    [
      '---',
      'title: Agent, That Really Works - Roadmap',
      'description: Internal product roadmap. Not linked from public docs navigation.',
      '---',
      '',
      '# Agent, That Really Works - Roadmap',
      '',
      'Private roadmap detail for issue links.',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(internalDir, 'approval-rule-pipeline.md'),
    [
      '# Approval Rule Pipeline',
      '',
      'Internal approval pipeline implementation notes.',
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
  fs.writeFileSync(
    path.join(contentDocsDir, 'navigation.json'),
    `${JSON.stringify(
      {
        sections: [
          {
            title: 'Overview',
            pages: [{ title: 'HybridClaw Docs', path: 'README.md' }],
          },
          {
            title: 'Getting Started',
            pages: [
              { title: 'Getting Started', path: 'getting-started/README.md' },
            ],
          },
          {
            title: 'Channels',
            pages: [{ title: 'Channels', path: 'channels/README.md' }],
          },
          {
            title: 'Guides',
            pages: [
              { title: 'Guides', path: 'guides/README.md' },
              { title: 'Heading Order', path: 'guides/heading-order.md' },
            ],
          },
          {
            title: 'Extensibility',
            pages: [
              { title: 'Extensibility', path: 'extensibility/README.md' },
            ],
          },
          {
            title: 'Developer Guide',
            pages: [
              { title: 'Developer Guide', path: 'developer-guide/README.md' },
            ],
          },
          {
            title: 'Reference',
            pages: [{ title: 'Reference', path: 'reference/README.md' }],
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return root;
}

const makeTempDataDir = useTempDir('hybridclaw-health-data-');

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

function writeAllowAllSecretPolicy(homeDir: string): void {
  const policyPath = path.join(
    homeDir,
    '.hybridclaw',
    'data',
    'agents',
    'main',
    'workspace',
    '.hybridclaw',
    'policy.yaml',
  );
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(
    policyPath,
    ['secret:', '  default: allow', ''].join('\n'),
    'utf8',
  );
}

function makeRequest(params: {
  method?: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  remoteAddress?: string;
  noAuth?: boolean;
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
    headers: {
      ...(params.noAuth
        ? {}
        : { authorization: `Bearer ${DEFAULT_TEST_GATEWAY_API_TOKEN}` }),
      ...(params.headers || {}),
    },
    socket: {
      remoteAddress: params.remoteAddress || '127.0.0.1',
    },
  });
}

function makeSessionCookie(
  secret: string,
  payload: Record<string, unknown>,
): string {
  return `hybridclaw_session=${signAuthPayload(
    {
      typ: 'session',
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...payload,
    },
    secret,
  )}`;
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

function getSetCookieHeader(res: ReturnType<typeof makeResponse>): string {
  const value = res.getHeader('Set-Cookie');
  if (Array.isArray(value)) return value.join('; ');
  return String(value || '');
}

function getCookiePair(setCookie: string, cookieName: string): string {
  return (
    setCookie
      .split(/,\s*|\s*;\s*/)
      .find((segment) => segment.startsWith(`${cookieName}=`)) || ''
  );
}

function issueLocalWebSessionCookie(
  state: Awaited<ReturnType<typeof importFreshHealth>>,
): string {
  const req = makeRequest({
    url: '/chat',
    headers: { host: 'localhost:9090' },
    noAuth: true,
  });
  const res = makeResponse();

  state.handler(req as never, res as never);

  return getCookiePair(getSetCookieHeader(res), 'hybridclaw_local_session');
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
  healthHost?: string;
  authSecret?: string;
  hybridAiBaseUrl?: string;
  runningInsideContainer?: boolean;
  deploymentPublicUrl?: string;
  apiTokens?: Record<
    string,
    { id: string; label: string; claims: Record<string, unknown> }
  >;
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
  const getGatewayHistory = vi.fn((sessionId: string) => ({
    sessionId,
    agentId: 'research',
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
  const resolveAgentForRequest = vi.fn(
    (params?: {
      agentId?: string | null;
      session?: {
        agent_id?: string | null;
        model?: string | null;
        chatbot_id?: string | null;
      } | null;
      model?: string | null;
      chatbotId?: string | null;
    }) => ({
      agentId:
        params?.agentId?.trim() || params?.session?.agent_id?.trim() || 'main',
      model:
        params?.model?.trim() || params?.session?.model?.trim() || 'gpt-5',
      chatbotId:
        params?.chatbotId?.trim() ||
        params?.session?.chatbot_id?.trim() ||
        'bot_1',
    }),
  );
  const getSessionById = vi.fn((sessionId: string) => ({
    id: sessionId,
    session_key: sessionId,
    main_session_key: sessionId,
    agent_id: 'main',
    model: 'gpt-5',
    chatbot_id: 'bot_1',
    enable_rag: 1,
    show_mode: 'all',
  }));
  const getOrCreateSession = vi.fn((sessionId: string) => ({
    id: sessionId,
    session_key: sessionId,
    main_session_key: sessionId,
    agent_id: 'main',
    model: 'gpt-5',
    chatbot_id: 'bot_1',
    enable_rag: 1,
  }));
  const storeMessage = vi.fn(() => 1);
  const setMessageActivityTrace = vi.fn();
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
  const callAuxiliaryModel = vi.fn(async () => ({
    provider: 'vllm' as const,
    model: 'vllm/Qwen/Qwen3.6-27B-FP8',
    content: '{"status":"pass","summary":"ok","findings":[]}',
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
  const runAgent = vi.fn(async () => ({
    result: '',
    toolExecutions: [],
  }));
  const getGatewaySessionContextUsage = vi.fn((sessionId: string) => ({
    sessionId,
    snapshot: null,
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
  type TestStoredApp = {
    id: string;
    title: string;
    description: string | null;
    category:
      | 'apps'
      | 'documents'
      | 'games'
      | 'productivity'
      | 'creative'
      | 'quiz'
      | 'scratch';
    kind: 'web' | 'live';
    html: string;
    prompt: string | null;
    agentId: string | null;
    sessionId: string | null;
    sourceKey: string | null;
    visibility: 'private' | 'public';
    createdAt: string;
    updatedAt: string;
  };
  type TestCreateAppInput = {
    title: string;
    html: string;
    description?: string | null;
    category?: string | null;
    kind?: 'web' | 'live';
    prompt?: string | null;
    agentId?: string | null;
    sessionId?: string | null;
    sourceKey?: string | null;
    visibility?: 'private' | 'public';
  };
  const apps = new Map<string, TestStoredApp>();
  let nextAppId = 1;
  const createApp = vi.fn((input: TestCreateAppInput): TestStoredApp => {
    const now = '2026-07-03T00:00:00.000Z';
    const app: TestStoredApp = {
      id: `app-${nextAppId++}`,
      title: input.title,
      description: input.description ?? null,
      category: (input.category || 'apps') as TestStoredApp['category'],
      kind: input.kind ?? 'web',
      html: input.html,
      prompt: input.prompt ?? null,
      agentId: input.agentId ?? null,
      sessionId: input.sessionId ?? null,
      sourceKey: input.sourceKey ?? null,
      visibility: input.visibility ?? 'private',
      createdAt: now,
      updatedAt: now,
    };
    apps.set(app.id, app);
    return app;
  });
  const getApp = vi.fn((id: string) => apps.get(id) ?? null);
  const listApps = vi.fn(() =>
    Array.from(apps.values()).map(({ html: _html, ...summary }) => summary),
  );
  const deleteApp = vi.fn((id: string) => apps.delete(id));
  const upsertAppArtifact = vi.fn((input: TestCreateAppInput) =>
    createApp(input),
  );
  const getGatewayAdminOverview = vi.fn(async () => ({
    status: { status: 'ok', sessions: 2, version: '0.7.1', uptime: 60 },
    configPath: '/tmp/config.json',
    tunnel: {
      provider: 'ngrok',
      publicUrl: 'https://public.example.test',
      state: 'up' as const,
      health: 'healthy' as const,
      reconnectSupported: true,
      lastError: null,
      lastCheckedAt: '2026-04-29T10:00:00.000Z',
      nextReconnectAt: null,
    },
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
  const getGatewayAdminSecrets = vi.fn(() => ({
    secrets: [
      {
        name: 'SET_SECRET',
        state: 'set' as const,
        created_at: '2026-05-17T10:00:00.000Z',
        last_rotated_at: '2026-05-17T10:00:00.000Z',
        length: 12,
        fingerprint: {
          length: 12,
          sha256_prefix: '0123456789ab',
        },
      },
      {
        name: 'OTHER_SECRET',
        state: 'unset' as const,
        created_at: null,
        last_rotated_at: null,
        length: null,
        fingerprint: null,
      },
    ],
    total: 2,
    actions: ['secret.list_metadata' as const],
  }));
  const overwriteGatewayAdminSecret = vi.fn(
    (params: { name: string; value: unknown }) => ({
      secret: {
        name: params.name,
        state: 'set' as const,
        created_at: '2026-05-17T10:00:00.000Z',
        last_rotated_at: '2026-05-17T10:10:00.000Z',
        length: String(params.value || '').length,
        fingerprint: {
          length: String(params.value || '').length,
          sha256_prefix: 'fedcba987654',
        },
      },
    }),
  );
  const unsetGatewayAdminSecret = vi.fn((params: { name: string }) => ({
    secret: {
      name: params.name,
      state: 'unset' as const,
      created_at: null,
      last_rotated_at: null,
      length: null,
      fingerprint: null,
    },
  }));
  const recordGatewayAdminSecretMutationFailure = vi.fn();
  const reconnectTunnelStatus = {
    provider: 'ngrok',
    publicUrl: 'https://next-public.example.test',
    state: 'up' as const,
    health: 'healthy' as const,
    reconnectSupported: true,
    lastError: null,
    lastCheckedAt: null,
    nextReconnectAt: null,
  };
  const stopTunnelStatus = {
    provider: 'ngrok',
    publicUrl: null,
    state: 'down' as const,
    health: 'down' as const,
    reconnectSupported: true,
    lastError: null,
    lastCheckedAt: null,
    nextReconnectAt: null,
  };
  const tunnelConfigResponse = {
    config: {
      mode: 'local' as const,
      provider: 'manual',
      publicUrl: 'https://public.example.test',
      healthCheckIntervalMs: 30_000,
    },
    tunnel: reconnectTunnelStatus,
  };
  const getGatewayAdminTunnelConfig = vi.fn(() => tunnelConfigResponse);
  const saveGatewayAdminTunnelConfig = vi.fn((value) => ({
    config: {
      ...tunnelConfigResponse.config,
      ...value,
    },
    tunnel: reconnectTunnelStatus,
  }));
  const reconnectGatewayAdminTunnel = vi.fn(async () => reconnectTunnelStatus);
  const stopGatewayAdminTunnel = vi.fn(async () => stopTunnelStatus);
  const getGatewayAdminStatistics = vi.fn(
    (params?: { days?: number | string }) => {
      const raw =
        typeof params?.days === 'number'
          ? params.days
          : typeof params?.days === 'string'
            ? Number.parseInt(params.days, 10)
            : 30;
      const rangeDays = Math.max(
        1,
        Math.min(90, Number.isFinite(raw) ? Math.floor(raw) : 30),
      );
      return {
        rangeDays,
        startDate: '2026-04-01',
        endDate: '2026-04-30',
        totals: {
          newSessions: 1,
          activeSessions: 2,
          totalMessages: 5,
          userMessages: 3,
          assistantMessages: 2,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 0,
          totalCostUsd: 0,
          callCount: 0,
          totalToolCalls: 0,
        },
        trend: [],
        channels: [
          {
            channelId: 'web',
            sessionCount: 2,
            userMessages: 3,
            assistantMessages: 2,
            totalMessages: 5,
          },
        ],
      };
    },
  );
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
  const getGatewayAdminA2AInbox = vi.fn(
    (params?: { threadId?: string | null }) => ({
      threads: [
        {
          id: 'thread-b',
          messageCount: 1,
          participants: ['writer@team@local-dev', 'main@team@local-dev'],
          latestMessage: {
            id: 'msg-b',
            threadId: 'thread-b',
            senderAgentId: 'writer@team@local-dev',
            recipientAgentId: 'main@team@local-dev',
            parentMessageId: null,
            intent: 'handoff' as const,
            content: 'Newest handoff.',
            createdAt: '2026-05-01T10:00:00.000Z',
          },
        },
      ],
      selectedThreadId: params?.threadId || 'thread-b',
      messages: [
        {
          id: 'msg-b',
          threadId: params?.threadId || 'thread-b',
          senderAgentId: 'writer@team@local-dev',
          recipientAgentId: 'main@team@local-dev',
          parentMessageId: null,
          intent: 'handoff' as const,
          content: 'Newest handoff.',
          createdAt: '2026-05-01T10:00:00.000Z',
        },
      ],
    }),
  );
  const getGatewayAdminA2ATrust = vi.fn(() => ({
    identity: {
      instanceId: 'local-dev',
      publicKeyFingerprint: 'local-fingerprint',
      publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'local-key' },
    },
    peers: [],
    pairingRequests: [],
  }));
  const getGatewayA2AAgentCard = vi.fn((origin: string) => ({
    name: 'HybridClaw',
    version: '0.0.0-test',
    url: new URL('/a2a', origin).toString(),
    capabilities: {
      messageSend: true,
      tasksSend: true,
      streaming: false,
    },
    agents: [],
    skills: [],
  }));
  const upsertGatewayAdminA2ATrustPeer = vi.fn(() =>
    getGatewayAdminA2ATrust(),
  );
  const revokeGatewayAdminA2ATrustPeer = vi.fn(() =>
    getGatewayAdminA2ATrust(),
  );
  const deleteGatewayAdminA2ATrustPeer = vi.fn(() =>
    getGatewayAdminA2ATrust(),
  );
  const startGatewayAdminA2APairing = vi.fn(async () => ({
    ...getGatewayAdminA2ATrust(),
    proposal: {
      peerId: 'peer-prod',
      agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
      deliveryUrl: 'https://peer.example.com/a2a',
      publicKeyFingerprint: 'peer-fingerprint',
      name: 'Peer',
    },
    remoteNotification: {
      status: 'sent' as const,
      url: 'https://peer.example.com/a2a/pairing/requests',
      error: null,
    },
  }));
  const previewGatewayAdminA2APairing = vi.fn(async () => ({
    proposal: {
      peerId: 'peer-prod',
      agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
      deliveryUrl: 'https://peer.example.com/a2a',
      publicKeyFingerprint: 'peer-fingerprint',
      publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'peer-key' },
      name: 'Peer',
    },
  }));
  const approveGatewayAdminA2APairingRequest = vi.fn(() =>
    getGatewayAdminA2ATrust(),
  );
  const declineGatewayAdminA2APairingRequest = vi.fn(() =>
    getGatewayAdminA2ATrust(),
  );
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
        error:
          'Missing required runtime secrets: DEMO_PLUGIN_TOKEN. Store them with `hybridclaw secret set <name> <value>` or in TUI with `/secret set <name> <value>`, then reload plugins.',
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
        monthlySpendUsd: 0.01,
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
  const getGatewayAgentList = vi.fn(() => ({
    agents: [{ id: 'main', name: 'Main Agent' }],
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
  const getGatewayAdminHybridAIBots = vi.fn(async () => ({
    bots: [
      {
        id: 'bot-support',
        name: 'Support Bot',
        description: 'Handles support requests',
        model: 'gpt-5',
      },
      {
        id: 'bot-research',
        name: 'Research Bot',
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
  const getGatewayAdminTeamStructure = vi.fn(() => ({
    revisions: [],
  }));
  const getGatewayAdminTeamStructureRevision = vi.fn((revisionId: number) => ({
    revision: {
      id: revisionId,
      author: 'test',
      updatedAt: new Date(0).toISOString(),
      changeCount: 0,
      diff: { added: [], removed: [], changed: [] },
      snapshot: { version: 1, agents: [] },
    },
  }));
  const restoreGatewayAdminTeamStructureRevision = vi.fn(
    (revisionId: number) => ({
      revision: {
        id: revisionId,
        author: 'test',
        updatedAt: new Date(0).toISOString(),
        changeCount: 0,
        diff: { added: [], removed: [], changed: [] },
        snapshot: { version: 1, agents: [] },
      },
      agents: [],
    }),
  );
  const getGatewayAdminSessions = vi.fn(() => []);
  const cleanupGatewayNoUserChatSessions = vi.fn(() => ({
    deletedCount: 2,
    deletedSessionIds: ['old-empty', 'old-opening'],
    keptSessionId: 'new-session',
  }));
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
    slackWebhook: {
      enabled: false,
      targetCount: 0,
      defaultTargetConfigured: false,
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
  const getGatewayAdminConnectors = vi.fn(() => ({
    secretsPath: '/tmp/credentials.json',
    connectors: [],
  }));
  const getGatewayAdminConnectorsWithPlatformState = vi.fn(async () => ({
    secretsPath: '/tmp/credentials.json',
    connectors: [],
  }));
  const saveGatewayAdminHybridAIConnectorApiKey = vi.fn(() => ({
    secretsPath: '/tmp/credentials.json',
    connectors: [],
  }));
  const startGatewayAdminConnectorOAuth = vi.fn(() => ({
    provider: 'microsoft365',
    authorizationUrl: 'https://login.example.test/authorize',
    state: 'connector-state',
    expiresAt: Date.now() + 600_000,
  }));
  const logoutGatewayAdminConnector = vi.fn(() => ({
    secretsPath: '/tmp/credentials.json',
    connectors: [],
  }));
  const testGatewayAdminConnector = vi.fn(async () => ({
    provider: 'github',
    name: 'GitHub',
    ok: true,
    message: 'GitHub is connected.',
  }));
  const completeGatewayAdminConnectorOAuthCallback = vi.fn(async () => ({
    provider: 'microsoft365',
    name: 'Microsoft 365',
  }));
  const getGatewayAdminAudit = vi.fn(() => ({
    query: '',
    sessionId: '',
    eventType: '',
    since: null,
    until: null,
    limit: 60,
    entries: [],
    nextCursor: null,
    total: 0,
  }));
  const getGatewayAdminApprovals = vi.fn(() => ({
    selectedAgentId: 'main',
    agents: [
      {
        id: 'main',
        name: 'Main Agent',
        workspacePath: '/tmp/main/workspace',
      },
    ],
    pending: [
      {
        sessionId: DEFAULT_WEB_SESSION_ID,
        agentId: 'main',
        approvalId: 'approve-1',
        userId: 'user-a',
        prompt: 'Approval required for https://example.com',
        createdAt: '2026-03-11T10:00:00.000Z',
        expiresAt: '2026-03-11T10:02:00.000Z',
        allowSession: true,
        allowAgent: true,
        allowAll: true,
        actionKey: 'network:example.com',
      },
    ],
    suspendedSessions: [],
    policy: {
      exists: true,
      policyPath: '/tmp/main/workspace/.hybridclaw/policy.yaml',
      workspacePath: '/tmp/main/workspace',
      defaultAction: 'deny',
      lanHttpAccess: {
        mode: 'off',
        managedRuleIndexes: [],
      },
      presets: ['github'],
      rules: [
        {
          index: 1,
          action: 'allow',
          host: 'example.com',
          port: '*',
          methods: ['*'],
          paths: ['/**'],
          agent: 'main',
          comment: 'manual allow',
        },
      ],
    },
    availablePresets: [
      {
        name: 'github',
        description: 'GitHub API and raw content',
      },
      {
        name: 'npm',
        description: 'npm registry and tarballs',
      },
    ],
  }));
  const saveGatewayAdminPolicyRule = vi.fn(
    (params: {
      agentId?: string;
      index?: number | null;
      rule: {
        action: 'allow' | 'deny';
        host: string;
        port: number | '*';
        methods: string[];
        paths: string[];
        agent: string;
        comment?: string;
      };
    }) => ({
      exists: true,
      policyPath: `/tmp/${params.agentId || 'main'}/workspace/.hybridclaw/policy.yaml`,
      workspacePath: `/tmp/${params.agentId || 'main'}/workspace`,
      defaultAction: 'deny',
      lanHttpAccess: {
        mode: 'off',
        managedRuleIndexes: [],
      },
      presets: [],
      rules: [
        {
          index: params.index || 1,
          ...params.rule,
        },
      ],
    }),
  );
  const saveGatewayAdminPolicyDefault = vi.fn(
    (params: { agentId?: string; defaultAction: 'allow' | 'deny' }) => ({
      exists: true,
      policyPath: `/tmp/${params.agentId || 'main'}/workspace/.hybridclaw/policy.yaml`,
      workspacePath: `/tmp/${params.agentId || 'main'}/workspace`,
      defaultAction: params.defaultAction,
      lanHttpAccess: {
        mode: 'off',
        managedRuleIndexes: [],
      },
      presets: [],
      rules: [],
    }),
  );
  const saveGatewayAdminPolicyLanHttpAccess = vi.fn(
    (params: {
      agentId?: string;
      mode: 'off' | 'read-only' | 'read-write' | 'custom';
    }) => ({
      exists: true,
      policyPath: `/tmp/${params.agentId || 'main'}/workspace/.hybridclaw/policy.yaml`,
      workspacePath: `/tmp/${params.agentId || 'main'}/workspace`,
      defaultAction: 'deny',
      lanHttpAccess: {
        mode: params.mode,
        managedRuleIndexes: params.mode === 'off' ? [] : [2, 3, 4],
      },
      presets: [],
      rules: [],
    }),
  );
  const applyGatewayAdminPolicyPreset = vi.fn(
    (params: { agentId?: string; presetName: string }) => ({
      exists: true,
      policyPath: `/tmp/${params.agentId || 'main'}/workspace/.hybridclaw/policy.yaml`,
      workspacePath: `/tmp/${params.agentId || 'main'}/workspace`,
      defaultAction: 'deny',
      lanHttpAccess: {
        mode: 'off',
        managedRuleIndexes: [],
      },
      presets: [params.presetName],
      rules: [
        {
          index: 1,
          action: 'allow',
          host: 'registry.npmjs.org',
          port: '*',
          methods: ['*'],
          paths: ['/**'],
          agent: '*',
          managedByPreset: params.presetName,
        },
      ],
    }),
  );
  const deleteGatewayAdminPolicyRule = vi.fn(
    (params: { agentId?: string; index: number }) => ({
      exists: true,
      policyPath: `/tmp/${params.agentId || 'main'}/workspace/.hybridclaw/policy.yaml`,
      workspacePath: `/tmp/${params.agentId || 'main'}/workspace`,
      defaultAction: 'deny',
      lanHttpAccess: {
        mode: 'off',
        managedRuleIndexes: [],
      },
      presets: [],
      rules: [],
      deletedIndex: params.index,
    }),
  );
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
  const getGatewayAdminAgentScoreboard = vi.fn(() => ({
    observed_skill_count: 2,
    agents: [
      {
        agent_id: 'charly',
        display_name: 'Charly',
        total_executions: 3,
        success_rate: 1,
        avg_score: 90,
        avg_quality_score: 95,
        avg_reliability_score: 88,
        avg_timing_score: 70,
        best_skills: [],
        last_observed_at: '2026-04-27T10:00:00.000Z',
      },
    ],
  }));
  const createGatewayAdminSkill = vi.fn(() => ({
    extraDirs: [],
    disabled: [],
    channelDisabled: {},
    skills: [],
  }));
  const getGatewayAdminSkillPackageFiles = vi.fn(() => ({
    skillName: 'pdf',
    rootPath: '/skills/pdf',
    files: [
      {
        path: 'SKILL.md',
        name: 'SKILL.md',
        kind: 'file',
        sizeBytes: 12,
        updatedAt: '2026-06-19T10:00:00.000Z',
        editable: true,
        previewable: true,
      },
    ],
  }));
  const getGatewayAdminSkillPackageFile = vi.fn(() => ({
    skillName: 'pdf',
    rootPath: '/skills/pdf',
    file: {
      path: 'SKILL.md',
      name: 'SKILL.md',
      kind: 'file',
      sizeBytes: 12,
      updatedAt: '2026-06-19T10:00:00.000Z',
      editable: true,
      previewable: true,
      content: '# PDF\n',
    },
  }));
  const saveGatewayAdminSkillPackageFile = vi.fn(() => ({
    skillName: 'pdf',
    rootPath: '/skills/pdf',
    file: {
      path: 'SKILL.md',
      name: 'SKILL.md',
      kind: 'file',
      sizeBytes: 14,
      updatedAt: '2026-06-19T10:01:00.000Z',
      editable: true,
      previewable: true,
      content: '# Updated\n',
    },
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
      proxy?: {
        kind: 'hybridai';
        baseUrl: string;
        chatbotId: string;
        apiKey: { source: 'store'; id: string };
        conversationScope?: 'channel' | 'user';
      } | null;
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
        ...(payload.proxy ? { proxy: payload.proxy } : {}),
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
        proxy?: {
          kind: 'hybridai';
          baseUrl: string;
          chatbotId: string;
          apiKey: { source: 'store'; id: string };
          conversationScope?: 'channel' | 'user';
        } | null;
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
        ...(payload.proxy ? { proxy: payload.proxy } : {}),
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
  const saveGatewayAdminSlackWebhookTarget = vi.fn((value) => value);
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
    cards: [],
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
    suspendedSessions: [],
  }));
  const getBoardBudgetSummaries = vi.fn(() => ({
    budgets: [
      {
        agentId: 'main',
        used: 3.4,
        cap: 60,
        unit: 'USD',
        currency: 'USD',
        percent: 5.666,
      },
    ],
  }));
  const boardEdge = {
    id: 'edge-1',
    fromCardId: 'card-a',
    toCardId: 'card-b',
    kind: 'blocks' as const,
    createdAt: '2026-05-22T10:00:00.000Z',
    createdBy: { userId: 'user_a' },
  };
  const addEdge = vi.fn(() => boardEdge);
  const removeEdge = vi.fn(() => boardEdge);
  const listEdges = vi.fn(() => [boardEdge]);
  const listEdgeRevisions = vi.fn(() => [
    { id: 7, createdAt: '2026-05-22T10:00:00.000Z' },
  ]);
  const restoreEdgeRevision = vi.fn(() => boardEdge);
  const isBlocked = vi.fn(() => true);
  const runMessageToolAction = vi.fn(async () => ({ ok: true }));
  const normalizeDiscordToolAction = vi.fn((value: string) =>
    value === 'reply' ? 'send' : null,
  );
  const handleIMessageWebhook = vi.fn(async () => {});
  const handleMSTeamsWebhook = vi.fn(async () => {});
  const handleVoiceWebhook = vi.fn(async () => false);
  const handleVoiceUpgrade = vi.fn(() => false);
  const claimQueuedProactiveMessages = vi.fn(() => [
    { id: 1, text: 'queued message' },
  ]);
  const getDelegationJob = vi.fn((_publicId: string) => null as unknown);
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
  const verifyApiToken = vi.fn((bearer: string) => {
    return options?.apiTokens?.[bearer] ?? null;
  });
  const getGatewayAdminTokens = vi.fn(() => ({
    tokens: [],
    total: 0,
    actions: [
      'admin.tokens.read',
      'admin.tokens.create',
      'admin.tokens.revoke',
    ],
  }));
  const createGatewayAdminToken = vi.fn(() => ({
    token: 'hck_created_secret',
    apiToken: {
      id: 'created000001',
      label: 'Created token',
      claims: { actions: ['openai.api'] },
      created_at: '2026-05-17T10:00:00.000Z',
      created_by: 'admin-user',
      expires_at: null,
      last_used_at: null,
      revoked_at: null,
    },
  }));
  const revokeGatewayAdminToken = vi.fn((input: { id: string }) => ({
    apiToken: {
      id: input.id,
      label: 'Revoked token',
      claims: { actions: ['openai.api'] },
      created_at: '2026-05-17T10:00:00.000Z',
      created_by: 'admin-user',
      expires_at: null,
      last_used_at: null,
      revoked_at: '2026-05-17T11:00:00.000Z',
    },
  }));
  const refreshRuntimeSecretsFromEnv = vi.fn();
  const reloadRuntimeConfig = vi.fn();
  class ResponseRatingNotFoundError extends Error {
    constructor() {
      super('Response message was not found.');
      this.name = 'ResponseRatingNotFoundError';
    }
  }
  const submitResponseRating = vi.fn(
    (input: {
      sessionId: string;
      messageId: number;
      rating: 'up' | 'down' | null;
    }) => ({
      sessionId: input.sessionId,
      messageId: input.messageId,
      rating: input.rating,
    }),
  );

  vi.doMock('node:http', () => ({
    default: { createServer },
    createServer,
  }));
  vi.doMock('../src/config/config.ts', () => ({
    CONTAINER_SANDBOX_MODE: 'container',
    DATA_DIR: dataDir,
    GATEWAY_API_TOKEN:
      options?.gatewayApiToken ?? DEFAULT_TEST_GATEWAY_API_TOKEN,
    HEALTH_HOST: options?.healthHost || '127.0.0.1',
    HEALTH_PORT: 9090,
    HYBRIDAI_BASE_URL: options?.hybridAiBaseUrl || 'https://hybridai.one',
    HYBRIDAI_MODEL: 'gpt-5',
    MAX_CONCURRENT_CONTAINERS: 5,
    IMESSAGE_WEBHOOK_PATH: '/api/imessage/webhook',
    MSTEAMS_WEBHOOK_PATH: '/api/msteams/messages',
    WEB_API_TOKEN: options?.webApiToken || '',
    refreshRuntimeSecretsFromEnv,
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
  vi.doMock('../src/config/runtime-config.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/config/runtime-config.js')
    >('../src/config/runtime-config.js');
    if (options?.deploymentPublicUrl === undefined) {
      return {
        ...actual,
        reloadRuntimeConfig,
      };
    }
    const runtimeConfig = JSON.parse(
      JSON.stringify(actual.getRuntimeConfig()),
    ) as RuntimeConfig;
    runtimeConfig.deployment.mode = 'cloud';
    runtimeConfig.deployment.public_url = options.deploymentPublicUrl;
    runtimeConfig.deployment.tunnel.provider = 'manual';
    return {
      ...actual,
      getRuntimeConfig: vi.fn(() => runtimeConfig),
      reloadRuntimeConfig,
    };
  });
  vi.doMock('../src/logger.js', () => ({
    getLoggerRuntimeState: () => ({
      configuredLevel: 'info',
      effectiveLevel: 'info',
      forcedLevel: null,
    }),
    syncLoggerLevelFromRuntimeConfig: vi.fn(),
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
  vi.doMock('../src/channels/voice/runtime.js', () => ({
    handleVoiceUpgrade,
    handleVoiceWebhook,
  }));
  vi.doMock('../src/memory/db.js', () => ({
    claimQueuedProactiveMessages,
    getDelegationJob,
    getSessionById,
    resetSessionIfExpired: vi.fn(() => null),
    setMessageActivityTrace,
  }));
  vi.doMock('../src/memory/memory-service.js', () => ({
    memoryService: {
      forkSessionBranch,
      getOrCreateSession,
      getSessionById,
      storeMessage,
    },
  }));
  vi.doMock('../src/memory/apps.js', () => ({
    createApp,
    deleteApp,
    getApp,
    listApps,
    upsertAppArtifact,
  }));
  vi.doMock('../src/agent/agent.js', () => ({
    runAgent,
  }));
  vi.doMock('../src/agents/agent-registry.js', () => ({
    getAgentById,
    resolveAgentConfig,
    resolveAgentForRequest,
    resolveAgentWorkspaceId,
  }));
  vi.doMock('../src/board/budget-chip.js', () => ({
    getBoardBudgetSummaries,
  }));
  vi.doMock('../src/board/card-store.js', () => ({
    addEdge,
    isBlocked,
    listEdgeRevisions,
    listEdges,
    removeEdge,
    restoreEdgeRevision,
  }));
  vi.doMock('../src/agent/executor.js', () => ({
    stopSessionExecution,
  }));
  vi.doMock('../src/errors/gateway-request-error.js', () => ({
    GatewayRequestError,
  }));
  vi.doMock('../src/gateway/gateway-service.js', () => ({
    approveGatewayAdminA2APairingRequest,
    createGatewayAdminAgent,
    createGatewayAdminSkill,
    declineGatewayAdminA2APairingRequest,
    deleteGatewayAdminA2ATrustPeer,
    deleteGatewayAdminAgent,
    deleteGatewayAdminSession,
    ensureGatewayBootstrapAutostart,
    cleanupGatewayNoUserChatSessions,
    GatewayRequestError,
    getGatewayAgentList,
    getGatewayAgents,
    getGatewayA2AAgentCard,
    getGatewayAdminAgents,
    getGatewayAdminHybridAIBots,
    getGatewayAdminAgentMarkdownFile,
    getGatewayAdminAgentMarkdownRevision,
    getGatewayAdminApprovals,
    getGatewayAdminA2AInbox,
    getGatewayAdminA2ATrust,
    getGatewayAdminAudit,
    getGatewayAdminChannels,
    getGatewayAdminConfig,
    getGatewayAdminTeamStructure,
    getGatewayAdminTeamStructureRevision,
    applyGatewayAdminPolicyPreset,
    deleteGatewayAdminPolicyRule,
    deleteGatewayAdminEmailMessage,
    getGatewayAdminEmailFolder,
    getGatewayAdminEmailMailbox,
    getGatewayAdminEmailMessage,
    getGatewayAdminJobsContext,
    getGatewayAdminMcp,
    getGatewayAdminModels,
    getGatewayAdminOverview,
    getGatewayAdminSessions,
    getGatewayAdminAgentScoreboard,
    getGatewayAdminSkillPackageFile,
    getGatewayAdminSkillPackageFiles,
    getGatewayAdminSkills,
    getGatewayAdminStatistics,
    getGatewayAdminTools,
    getGatewayAdminTunnelConfig,
    getGatewayBootstrapAutostartState,
    getGatewayHistory,
    getGatewayRecentChatSessions,
    getGatewayHistorySummary,
    getGatewaySessionContextUsage,
    getGatewayStatus,
    handleGatewayCommand,
    reconnectGatewayAdminTunnel,
    previewGatewayAdminA2APairing,
    readSystemPromptMessage,
    renderGatewayCommand,
    resolveGatewayChatbotId,
    removeGatewayAdminChannel,
    removeGatewayAdminMcpServer,
    restoreGatewayAdminAgentMarkdownRevision,
    restoreGatewayAdminTeamStructureRevision,
    revokeGatewayAdminA2ATrustPeer,
    saveGatewayAdminConfig,
    saveGatewayAdminSlackWebhookTarget,
    saveGatewayAdminTunnelConfig,
    saveGatewayAdminAgentMarkdownFile,
    saveGatewayAdminPolicyDefault,
    saveGatewayAdminPolicyLanHttpAccess,
    saveGatewayAdminPolicyRule,
    saveGatewayAdminSkillPackageFile,
    saveGatewayAdminModels,
    setGatewayAdminSkillEnabled,
    startGatewayAdminA2APairing,
    stopGatewayAdminTunnel,
    updateGatewayAdminAgent,
    uploadGatewayAdminSkillZip,
    upsertGatewayAdminA2ATrustPeer,
    upsertGatewayAdminChannel,
    upsertGatewayAdminMcpServer,
  }));
  vi.doMock('../src/gateway/gateway-admin-secrets.js', () => ({
    getGatewayAdminSecrets,
    overwriteGatewayAdminSecret,
    recordGatewayAdminSecretMutationFailure,
    unsetGatewayAdminSecret,
  }));
  vi.doMock('../src/security/api-tokens.js', () => ({
    isApiTokenString: (value: string) => value.trim().startsWith('hck_'),
    verifyApiToken,
  }));
  vi.doMock('../src/gateway/gateway-admin-tokens.js', () => ({
    createGatewayAdminToken,
    getGatewayAdminTokens,
    revokeGatewayAdminToken,
  }));
  vi.doMock('../src/gateway/gateway-admin-connectors.js', () => ({
    completeGatewayAdminConnectorOAuthCallback,
    getGatewayAdminConnectors,
    getGatewayAdminConnectorsWithPlatformState,
    logoutGatewayAdminConnector,
    saveGatewayAdminHybridAIConnectorApiKey,
    startGatewayAdminConnectorOAuth,
    testGatewayAdminConnector,
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
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel,
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
  vi.doMock('../src/gateway/response-ratings.js', () => ({
    ResponseRatingNotFoundError,
    submitResponseRating,
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
    cleanupGatewayNoUserChatSessions,
    getGatewayAgentList,
    getGatewayBootstrapAutostartState,
    getGatewayHistory,
    getGatewayRecentChatSessions,
    getGatewayHistorySummary,
    forkSessionBranch,
    getGatewayAdminOverview,
    getGatewayAdminSecrets,
    overwriteGatewayAdminSecret,
    recordGatewayAdminSecretMutationFailure,
    unsetGatewayAdminSecret,
    verifyApiToken,
    getGatewayAdminTokens,
    createGatewayAdminToken,
    revokeGatewayAdminToken,
    getGatewayAdminStatistics,
    tunnelConfigResponse,
    getGatewayAdminTunnelConfig,
    saveGatewayAdminTunnelConfig,
    reconnectTunnelStatus,
    reconnectGatewayAdminTunnel,
    stopTunnelStatus,
    stopGatewayAdminTunnel,
    deleteGatewayAdminEmailMessage,
    deleteGatewayAdminSession,
    getGatewayAdminEmailFolder,
    getGatewayAdminEmailMailbox,
    getGatewayAdminEmailMessage,
    getGatewayAgents,
    getGatewayAdminAgents,
    getGatewayAdminHybridAIBots,
    getGatewayAdminAgentMarkdownFile,
    getGatewayAdminAgentMarkdownRevision,
    getGatewayAdminTeamStructure,
    getGatewayAdminTeamStructureRevision,
    getGatewayAdminApprovals,
    getGatewayAdminA2AInbox,
    getGatewayAdminA2ATrust,
    getGatewayA2AAgentCard,
    previewGatewayAdminA2APairing,
    upsertGatewayAdminA2ATrustPeer,
    revokeGatewayAdminA2ATrustPeer,
    deleteGatewayAdminA2ATrustPeer,
    startGatewayAdminA2APairing,
    approveGatewayAdminA2APairingRequest,
    declineGatewayAdminA2APairingRequest,
    saveGatewayAdminPolicyDefault,
    saveGatewayAdminPolicyLanHttpAccess,
    applyGatewayAdminPolicyPreset,
    saveGatewayAdminPolicyRule,
    deleteGatewayAdminPolicyRule,
    runGatewayPluginTool,
    getGatewayAdminModels,
    getGatewayAdminPlugins,
    getGatewayAdminScheduler,
    getGatewayAdminMcp,
    getGatewayAdminConnectorsWithPlatformState,
    testGatewayAdminConnector,
    getGatewayAdminAudit,
    getGatewayAdminSkills,
    getGatewayAdminSkillPackageFile,
    getGatewayAdminSkillPackageFiles,
    getGatewayAdminAgentScoreboard,
    getGatewayAdminJobsContext,
    getBoardBudgetSummaries,
    addEdge,
    removeEdge,
    listEdges,
    listEdgeRevisions,
    restoreEdgeRevision,
    isBlocked,
    getGatewayAdminTools,
    startTerminalSession,
    stopTerminalSession,
    handleTerminalUpgrade,
    broadcastShutdownTerminal,
    upgradeHandler,
    moveGatewayAdminSchedulerJob,
    requestGatewayRestart,
    ResponseRatingNotFoundError,
    submitResponseRating,
    refreshRuntimeSecretsFromEnv,
    reloadRuntimeConfig,
    createGatewayAdminAgent,
    createGatewayAdminSkill,
    restoreGatewayAdminAgentMarkdownRevision,
    restoreGatewayAdminTeamStructureRevision,
    updateGatewayAdminAgent,
    saveGatewayAdminAgentMarkdownFile,
    deleteGatewayAdminAgent,
    GatewayRequestError,
    setGatewayAdminSkillEnabled,
    uploadGatewayAdminSkillZip,
    saveGatewayAdminSkillPackageFile,
    handleGatewayMessage,
    handleGatewayCommand,
    runAgent,
    createApp,
    getApp,
    getGatewaySessionContextUsage,
    handleGatewayPluginWebhook,
    renderGatewayCommand,
    getSessionById,
    getOrCreateSession,
    storeMessage,
    setMessageActivityTrace,
    getAgentById,
    buildConversationContext,
    callOpenAICompatibleModel,
    callOpenAICompatibleModelStream,
    callAuxiliaryModel,
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
    handleVoiceUpgrade,
    handleVoiceWebhook,
    runMessageToolAction,
    normalizeDiscordToolAction,
    claimQueuedProactiveMessages,
    getDelegationJob,
    consumeGatewayMediaUploadQuota,
    listLoadedPluginCommands,
  };
}

useCleanMocks({
  restoreAllMocks: true,
  cleanup: () => {
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
  },
  resetModules: true,
  unmock: [
    'node:http',
    'node:dns/promises',
    '../src/config/config.ts',
    '../src/infra/install-root.js',
    '../src/logger.js',
    '../src/agent/conversation.js',
    '../src/memory/db.js',
    '../src/memory/apps.js',
    '../src/agent/agent.js',
    '../src/gateway/gateway-service.js',
    '../src/gateway/gateway-chat-service.js',
    '../src/gateway/gateway-admin-tokens.js',
    '../src/security/api-tokens.js',
    '../src/gateway/openai-compatible-model.ts',
    '../src/gateway/gateway-scheduled-task-service.js',
    '../src/providers/factory.js',
    '../src/channels/imessage/runtime.js',
    '../src/channels/msteams/runtime.js',
    '../src/channels/voice/runtime.js',
    '../src/channels/message/tool-actions.js',
    '../src/channels/discord/tool-actions.js',
    '../src/gateway/media-upload-quota.ts',
    '../src/plugins/plugin-manager.js',
    '../src/gateway/gateway-restart.js',
    '../src/auth/google-auth.js',
  ],
  suspendedSessions: [],
});

async function createAndRedeemMobileChatQr(params: {
  state: Awaited<ReturnType<typeof importFreshHealth>>;
  sessionId: string;
  userId?: string;
  baseUrl?: string;
  continueNoAuth?: boolean;
}): Promise<{
  createRes: ReturnType<typeof makeResponse>;
  payload: { launchUrl: string; expiresAt?: string; qrSvg?: string };
  continueReq: ReturnType<typeof makeRequest>;
  continueRes: ReturnType<typeof makeResponse>;
  sessionCookie: string;
}> {
  const userId = params.userId || 'web-user-a';
  const createReq = makeRequest({
    method: 'POST',
    url: '/api/chat/mobile-qr',
    headers: {
      authorization: 'Bearer web-token',
    },
    body: {
      userId,
      sessionId: params.sessionId,
      baseUrl: params.baseUrl || 'https://example.test/chat',
    },
  });
  const createRes = makeResponse();

  params.state.handler(createReq as never, createRes as never);
  await waitForResponse(createRes, (next) => next.writableEnded);

  const payload = JSON.parse(createRes.body) as {
    launchUrl: string;
    expiresAt?: string;
    qrSvg?: string;
  };
  const continueUrl = new URL(payload.launchUrl);
  const continueReq = makeRequest({
    url: `${continueUrl.pathname}${continueUrl.search}`,
    ...(params.continueNoAuth ? { noAuth: true } : {}),
  });
  const continueRes = makeResponse();

  params.state.handler(continueReq as never, continueRes as never);
  await waitForResponse(continueRes, (next) => next.writableEnded);

  return {
    createRes,
    payload,
    continueReq,
    continueRes,
    sessionCookie: getCookiePair(
      getSetCookieHeader(continueRes),
      'hybridclaw_session',
    ),
  };
}

describe('gateway HTTP server', () => {
  test('starts the HTTP server and serves the health endpoint without auth', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/health' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await vi.waitFor(() => expect(res.statusCode).toBe(200));

    expect(state.listenArgs).toEqual({ host: '127.0.0.1', port: 9090 });
    expect(state.getGatewayStatus).toHaveBeenCalledWith({
      includeCoworkerLiveness: false,
      refreshProviderHealth: false,
    });
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', sessions: 2 });
  });

  test('routes voice webhooks using the configured webhookPath', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-voice-http-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir, (config) => {
      const voice = config.voice as Record<string, unknown>;
      voice.webhookPath = '/telephony';
    });

    const state = await importFreshHealth();
    state.handleVoiceWebhook.mockImplementationOnce(async (_req, res) => {
      res.statusCode = 202;
      res.end('voice-webhook');
      return true;
    });
    const req = makeRequest({
      method: 'POST',
      url: '/telephony/webhook',
      headers: { host: 'voice.example.com' },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await vi.waitFor(() =>
      expect(state.handleVoiceWebhook).toHaveBeenCalledTimes(1),
    );

    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('voice-webhook');
  });

  test('issues a local web-session cookie for loopback console pages when WEB_API_TOKEN is unset', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/chat',
      headers: { host: 'localhost:9090' },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(getSetCookieHeader(res)).toContain('hybridclaw_local_session=');
    expect(getSetCookieHeader(res)).toContain('HttpOnly');
    expect(getSetCookieHeader(res)).toContain('SameSite=Strict');
  });

  test('issues a local web-session cookie for loopback console pages when WEB_API_TOKEN is configured', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });
    const req = makeRequest({
      url: '/admin',
      headers: { host: 'localhost:9090' },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<h1>Admin</h1>');
    expect(res.body).not.toContain('web-token');
    expect(getSetCookieHeader(res)).toContain('hybridclaw_local_session=');
    expect(getSetCookieHeader(res)).toContain('HttpOnly');
    expect(getSetCookieHeader(res)).toContain('SameSite=Strict');
  });

  test('serves console index with defensive headers', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });

    for (const pathname of ['/admin', '/agents']) {
      const req = makeRequest({
        url: pathname,
        headers: { host: 'localhost:9090' },
        noAuth: true,
      });
      const res = makeResponse();

      state.handler(req as never, res as never);

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('<h1>Admin</h1>');
      expect(res.body).not.toContain('web-token');
      expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(res.headers['Referrer-Policy']).toBe('no-referrer');
      expect(res.headers['Content-Security-Policy']).toContain(
        "default-src 'self'",
      );
      expect(res.headers['Content-Security-Policy']).toContain(
        "frame-src 'self' blob:",
      );
    }
  });

  test('does not expose WEB_API_TOKEN in the loopback agents SPA', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });
    const req = makeRequest({
      url: '/agents',
      headers: { host: 'localhost:9090' },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<h1>Admin</h1>');
    expect(res.body).not.toContain('web-token');
    expect(getSetCookieHeader(res)).toContain('hybridclaw_local_session=');
  });

  test('does not bootstrap WEB_API_TOKEN for non-loopback request hosts', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });
    const req = makeRequest({
      url: '/admin',
      headers: { host: 'example.com' },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<h1>Admin</h1>');
    expect(res.body).not.toContain('web-token');
  });

  test('does not bootstrap WEB_API_TOKEN with forwarding headers', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });
    const req = makeRequest({
      url: '/admin',
      headers: {
        host: 'localhost:9090',
        'x-forwarded-for': '203.0.113.10',
      },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<h1>Admin</h1>');
    expect(res.body).not.toContain('web-token');
  });

  test('does not issue a local web-session cookie for non-loopback request hosts', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/chat',
      headers: { host: 'example.com' },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(getSetCookieHeader(res)).toBe('');
  });

  test('does not issue a local web-session cookie with forwarding headers', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/chat',
      headers: { host: 'localhost:9090', 'x-forwarded-for': '203.0.113.10' },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(getSetCookieHeader(res)).toBe('');
  });

  test('rejects unauthenticated console pages when the gateway bind host is not loopback', async () => {
    const state = await importFreshHealth({ healthHost: '0.0.0.0' });
    const req = makeRequest({
      url: '/chat',
      headers: { host: 'localhost:9090' },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Configure WEB_API_TOKEN');
    expect(getSetCookieHeader(res)).toBe('');
  });

  test('rejects API requests from loopback without bearer auth or local web-session cookie', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/status',
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
    });
  });

  test('allows API requests with a local web-session cookie when WEB_API_TOKEN is unset', async () => {
    const state = await importFreshHealth();
    const cookie = issueLocalWebSessionCookie(state);
    const req = makeRequest({
      url: '/api/status',
      headers: { cookie, host: 'localhost:9090' },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(
      expect.objectContaining({ status: 'ok' }),
    );
  });

  test('rejects local web-session API auth with forwarding headers', async () => {
    const state = await importFreshHealth();
    const cookie = issueLocalWebSessionCookie(state);
    const req = makeRequest({
      url: '/api/status',
      headers: {
        cookie,
        host: 'localhost:9090',
        'x-forwarded-for': '203.0.113.10',
      },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
    });
  });

  test('rejects unsafe local web-session API requests without same-origin headers', async () => {
    const state = await importFreshHealth();
    const cookie = issueLocalWebSessionCookie(state);
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/config/reload',
      headers: { cookie, host: 'localhost:9090' },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
    });
  });

  test('allows unsafe local web-session API requests with a matching origin', async () => {
    const state = await importFreshHealth({ deploymentPublicUrl: '' });
    const cookie = issueLocalWebSessionCookie(state);
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/config/reload',
      headers: {
        cookie,
        host: 'localhost:9090',
        origin: 'http://localhost:9090',
      },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(state.reloadRuntimeConfig).toHaveBeenCalledWith('admin-api');
  });

  test('requires API auth from loopback when WEB_API_TOKEN is configured', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });
    const req = makeRequest({
      url: '/api/status',
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
    });
  });

  test('allows API requests with a signed session cookie when WEB_API_TOKEN is configured', async () => {
    const authSecret = 'api-session-auth-secret';
    const state = await importFreshHealth({
      authSecret,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: '/api/status',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          role: 'admin.viewer',
        }),
        host: 'example.test',
      },
      noAuth: true,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(
      expect.objectContaining({ status: 'ok' }),
    );
  });

  test('requires same-origin headers for signed session cookie API mutations', async () => {
    const authSecret = 'api-session-origin-auth-secret';
    const state = await importFreshHealth({
      authSecret,
      webApiToken: 'web-token',
    });
    const cookie = makeSessionCookie(authSecret, {
      sessionId: 'admin-session-1',
      actor: 'admin-user',
      role: 'admin.config_manager',
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/config/reload',
      headers: {
        cookie,
        host: 'example.test',
      },
      noAuth: true,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(401);
    expect(state.reloadRuntimeConfig).not.toHaveBeenCalled();
  });

  test('allows signed session cookie API mutations with matching origin', async () => {
    const authSecret = 'api-session-mutation-auth-secret';
    const state = await importFreshHealth({
      authSecret,
      deploymentPublicUrl: '',
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/config/reload',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          role: 'admin.config_manager',
        }),
        host: 'example.test',
        origin: 'http://example.test',
      },
      noAuth: true,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(state.reloadRuntimeConfig).toHaveBeenCalledWith('admin-api');
  });

  test('allows signed session cookie API mutations with forwarded public origin', async () => {
    const authSecret = 'api-session-forwarded-origin-auth-secret';
    const state = await importFreshHealth({
      authSecret,
      deploymentPublicUrl: '',
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/config/reload',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          role: 'admin.config_manager',
        }),
        host: '127.0.0.1:9090',
        origin: 'https://u-example.sbx.hybridai.one',
        'x-forwarded-host': 'u-example.sbx.hybridai.one',
        'x-forwarded-proto': 'https',
      },
      noAuth: true,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(state.reloadRuntimeConfig).toHaveBeenCalledWith('admin-api');
  });

  test('allows signed session cookie API mutations with configured public URL and internal host', async () => {
    const authSecret = 'api-session-cloud-public-origin-secret';
    const state = await importFreshHealth({
      authSecret,
      deploymentPublicUrl: 'https://u-public.sbx.hybridai.one',
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/config/reload',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          role: 'admin.config_manager',
        }),
        host: '172.19.0.21:9090',
        origin: 'https://u-public.sbx.hybridai.one',
      },
      noAuth: true,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(state.reloadRuntimeConfig).toHaveBeenCalledWith('admin-api');
  });

  test('rejects signed session cookie mutations with mismatched forwarded origin', async () => {
    const authSecret = 'api-session-forwarded-origin-mismatch-secret';
    const state = await importFreshHealth({
      authSecret,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/config/reload',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          role: 'admin.config_manager',
        }),
        host: '127.0.0.1:9090',
        origin: 'https://evil.example.test',
        'x-forwarded-host': 'u-example.sbx.hybridai.one',
        'x-forwarded-proto': 'https',
      },
      noAuth: true,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(401);
    expect(state.reloadRuntimeConfig).not.toHaveBeenCalled();
  });

  test('rejects forwarded loopback headers from unauthenticated external sockets', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/status',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      noAuth: true,
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

  test('allows an empty bearer token with a local web-session cookie when WEB_API_TOKEN is unset', async () => {
    const state = await importFreshHealth();
    const cookie = issueLocalWebSessionCookie(state);
    const req = makeRequest({
      url: '/api/status',
      headers: { authorization: 'Bearer ', cookie, host: 'localhost:9090' },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(
      expect.objectContaining({
        status: 'ok',
      }),
    );
  });

  test('injects the live app bridge only into live app views', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });
    const liveApp = state.createApp({
      title: 'Mail Wordcloud',
      html: '<!doctype html><html><head><title>Mail</title></head><body>mail</body></html>',
      kind: 'live',
      sessionId: 'sess-live-app',
      agentId: 'main',
    });
    const staticApp = state.createApp({
      title: 'Static App',
      html: '<!doctype html><html><head><title>Static</title></head><body>static</body></html>',
      kind: 'web',
    });

    const liveReq = makeRequest({
      url: `/api/apps/${liveApp.id}/view?token=web-token`,
      noAuth: true,
      remoteAddress: '203.0.113.10',
    });
    const liveRes = makeResponse();
    state.handler(liveReq as never, liveRes as never);
    await waitForResponse(liveRes, (next) => next.writableEnded);

    expect(liveRes.statusCode).toBe(200);
    expect(liveRes.headers['Referrer-Policy']).toBe('no-referrer');
    expect(liveRes.headers['Content-Security-Policy']).toContain(
      'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads',
    );
    expect(liveRes.headers['Content-Security-Policy']).not.toContain(
      'allow-popups-to-escape-sandbox',
    );
    expect(liveRes.body).toContain('data-hybridclaw-live-app-bridge');
    expect(liveRes.body).toContain(`var appId = ${JSON.stringify(liveApp.id)};`);
    expect(liveRes.body).toContain('existing.callMcpTool = callTool');
    expect(liveRes.body).toContain('existing.setRefreshHandler');
    expect(liveRes.body).toContain('hybridclaw:live-app-refresh');
    expect(liveRes.body).toContain('<body>mail</body>');

    const staticReq = makeRequest({
      url: `/api/apps/${staticApp.id}/view?token=web-token`,
      noAuth: true,
      remoteAddress: '203.0.113.10',
    });
    const staticRes = makeResponse();
    state.handler(staticReq as never, staticRes as never);
    await waitForResponse(staticRes, (next) => next.writableEnded);

    expect(staticRes.statusCode).toBe(200);
    expect(staticRes.body).not.toContain('data-hybridclaw-live-app-bridge');
    expect(staticRes.body).toContain('<body>static</body>');
  });

  test('requires matching appIds on scoped app view query tokens', async () => {
    const apiToken = 'hck_app_view';
    const apiTokens = {
      [apiToken]: {
        id: 'abc123abc123',
        label: 'app-view',
        claims: {
          actions: ['apps.view', 'apps.bridge'],
          appIds: [] as string[],
        },
      },
    };
    const state = await importFreshHealth({
      apiTokens,
    });
    const allowedApp = state.createApp({
      title: 'Allowed App',
      html: '<!doctype html><html><head></head><body>allowed</body></html>',
      kind: 'web',
    });
    const deniedApp = state.createApp({
      title: 'Denied App',
      html: '<!doctype html><html><head></head><body>denied</body></html>',
      kind: 'web',
    });
    apiTokens[apiToken].claims.appIds = [allowedApp.id];

    const allowedReq = makeRequest({
      url: `/api/apps/${allowedApp.id}/view?token=${apiToken}`,
      noAuth: true,
      remoteAddress: '203.0.113.10',
    });
    const allowedRes = makeResponse();
    state.handler(allowedReq as never, allowedRes as never);
    await waitForResponse(allowedRes, (next) => next.writableEnded);

    expect(state.verifyApiToken).toHaveBeenCalledWith(apiToken);
    expect(allowedRes.statusCode).toBe(200);
    expect(allowedRes.body).toContain('<body>allowed</body>');

    const deniedReq = makeRequest({
      url: `/api/apps/${deniedApp.id}/view?token=${apiToken}`,
      noAuth: true,
      remoteAddress: '203.0.113.10',
    });
    const deniedRes = makeResponse();
    state.handler(deniedReq as never, deniedRes as never);
    await waitForResponse(deniedRes, (next) => next.writableEnded);

    expect(deniedRes.statusCode).toBe(403);
    expect(JSON.parse(deniedRes.body)).toEqual({ error: 'Forbidden.' });
    expect(deniedRes.body).not.toContain('denied');
  });

  test('accepts scoped hck query tokens on the live app bridge path', async () => {
    const apiToken = 'hck_app_bridge';
    const apiTokens = {
      [apiToken]: {
        id: 'def456def456',
        label: 'app-bridge',
        claims: {
          actions: ['apps.bridge'],
          appIds: [] as string[],
        },
      },
    };
    const state = await importFreshHealth({
      apiTokens,
    });
    const liveApp = state.createApp({
      title: 'Mail Wordcloud',
      html: '<!doctype html><html><head></head><body>mail</body></html>',
      kind: 'live',
      sessionId: 'sess-live-app',
      agentId: 'main',
    });
    apiTokens[apiToken].claims.appIds = [liveApp.id];
    const req = makeRequest({
      method: 'POST',
      url: `/api/apps/${liveApp.id}/bridge/tool?token=${apiToken}`,
      noAuth: true,
      body: {
        toolName: 'hybridai__microsoft_graph__send_message',
        arguments: { id: 'message-1' },
      },
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.verifyApiToken).toHaveBeenCalledWith(apiToken);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      ok: false,
      error: 'Live apps can only call read-only MCP connector tools.',
    });
    expect(state.runAgent).not.toHaveBeenCalled();
  });

  test('uses apps.read for scoped API-token access to the apps API', async () => {
    const readToken = 'hck_apps_read';
    const deniedToken = 'hck_apps_denied';
    const state = await importFreshHealth({
      apiTokens: {
        [readToken]: {
          id: '111111111111',
          label: 'apps-reader',
          claims: { actions: ['apps.read'] },
        },
        [deniedToken]: {
          id: '222222222222',
          label: 'chat-only',
          claims: { actions: ['chat.send'] },
        },
      },
    });
    state.createApp({
      title: 'Listed App',
      html: '<!doctype html><html><body>listed</body></html>',
      kind: 'web',
    });

    const deniedReq = makeRequest({
      url: '/api/apps',
      headers: { authorization: `Bearer ${deniedToken}` },
    });
    const deniedRes = makeResponse();
    state.handler(deniedReq as never, deniedRes as never);
    await waitForResponse(deniedRes, (next) => next.writableEnded);

    expect(deniedRes.statusCode).toBe(403);

    const readReq = makeRequest({
      url: '/api/apps',
      headers: { authorization: `Bearer ${readToken}` },
    });
    const readRes = makeResponse();
    state.handler(readReq as never, readRes as never);
    await waitForResponse(readRes, (next) => next.writableEnded);

    expect(readRes.statusCode).toBe(200);
    expect(JSON.parse(readRes.body)).toMatchObject({
      apps: [expect.objectContaining({ title: 'Listed App' })],
      total: 1,
    });
  });

  test('rejects mutating live app bridge tool requests before running an agent', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });
    const liveApp = state.createApp({
      title: 'Mail Wordcloud',
      html: '<!doctype html><html><head></head><body>mail</body></html>',
      kind: 'live',
      sessionId: 'sess-live-app',
      agentId: 'main',
    });
    const req = makeRequest({
      method: 'POST',
      url: `/api/apps/${liveApp.id}/bridge/tool`,
      headers: { authorization: 'Bearer web-token' },
      body: {
        toolName: 'hybridai__microsoft_graph__send_message',
        arguments: { id: 'message-1' },
      },
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      ok: false,
      error: 'Live apps can only call read-only MCP connector tools.',
    });
    expect(state.runAgent).not.toHaveBeenCalled();
  });

  test('rejects pathological live app bridge tool names before running an agent', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });
    const liveApp = state.createApp({
      title: 'Mail Wordcloud',
      html: '<!doctype html><html><head></head><body>mail</body></html>',
      kind: 'live',
      sessionId: 'sess-live-app',
      agentId: 'main',
    });
    const req = makeRequest({
      method: 'POST',
      url: `/api/apps/${liveApp.id}/bridge/tool`,
      headers: { authorization: 'Bearer web-token' },
      body: {
        toolName: `0__0${'__0'.repeat(100)}!`,
        arguments: {},
      },
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      ok: false,
      error: 'Invalid MCP tool name.',
    });
    expect(state.runAgent).not.toHaveBeenCalled();
  });

  test('rejects unauthorized OpenAI-compatible API requests from non-loopback addresses', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/v1/models',
      remoteAddress: '203.0.113.10',
      noAuth: true,
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

  test('denies scoped API tokens on /v1 without openai.api', async () => {
    const apiToken = 'hck_chat_no_openai';
    const state = await importFreshHealth({
      apiTokens: {
        [apiToken]: {
          id: 'ccc333ccc333',
          label: 'chat-only',
          claims: { actions: ['chat.send'] },
        },
      },
    });
    const req = makeRequest({
      url: '/v1/models',
      headers: {
        authorization: `Bearer ${apiToken}`,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.getGatewayAdminModels).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: {
        message: 'Forbidden.',
        type: 'authentication_error',
        param: null,
        code: null,
      },
    });
  });

  test('allows scoped API tokens on /v1 with openai.api', async () => {
    const apiToken = 'hck_openai_api';
    const state = await importFreshHealth({
      apiTokens: {
        [apiToken]: {
          id: 'ddd444ddd444',
          label: 'openai-sdk',
          claims: { actions: ['openai.api'] },
        },
      },
    });
    state.getGatewayAdminModels.mockResolvedValueOnce({
      defaultModel: 'gpt-5',
      providerStatus: {},
      models: [{ id: 'gpt-5' }],
    });
    const req = makeRequest({
      url: '/v1/models',
      headers: {
        authorization: `Bearer ${apiToken}`,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual([
      {
        id: 'gpt-5',
        object: 'model',
        created: 0,
        owned_by: 'hybridclaw',
      },
    ]);
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
      delegationPublicId: expect.stringMatching(OPENAI_COMPLETION_ID_RE),
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
    expect(payload.hybridclaw).toBeUndefined();
    expect(res.getHeader('x-hybridclaw-delegation-id')).toBeUndefined();
  });

  test('adds delegation metadata to non-streaming OpenAI chat completions when a job is created', async () => {
    const state = await importFreshHealth();
    state.handleGatewayMessage.mockImplementationOnce(
      async (request: { delegationPublicId?: string }) => ({
        status: 'success' as const,
        result:
          "Started 2 delegate jobs. I'll synthesize the final answer when they finish.",
        toolsUsed: [],
        delegation: {
          id: request.delegationPublicId || 'chatcmpl_missing',
          status: 'queued' as const,
        },
      }),
    );
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'Research this deeply.' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    const payload = JSON.parse(res.body);
    expect(payload.id).toMatch(OPENAI_COMPLETION_ID_RE);
    expect(payload.hybridclaw).toEqual({
      delegation: {
        id: payload.id,
        status: 'queued',
      },
    });
    expect(res.getHeader('x-hybridclaw-delegation-id')).toBe(payload.id);
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
      autoApproveTools: true,
      guildId: null,
      channelId: 'openai',
      userId: expect.stringMatching(OPENAI_SESSION_ID_RE),
      username: 'openai',
      content: 'hello',
      agentId: 'charly',
      model: 'gpt-5',
      promptMode: 'none',
      delegationPublicId: expect.stringMatching(OPENAI_COMPLETION_ID_RE),
      source: 'gateway.chat.openai-compatible',
    });

    const payload = JSON.parse(res.body);
    expect(payload.model).toBe('gpt-5__hc_eval=agent=charly,ablate-system');
    expect(res.getHeader('x-hybridclaw-session-id')).toMatch(
      OPENAI_SESSION_ID_RE,
    );
    expect(res.getHeader('x-hybridclaw-execution-session-id')).toMatch(
      OPENAI_EXECUTION_SESSION_ID_RE,
    );
    expect(res.getHeader('x-hybridclaw-artifact-count')).toBe('0');
    expect(res.getHeader('x-hybridclaw-agent-id')).toBe('charly');
    expect(res.getHeader('x-hybridclaw-workspace-mode')).toBe('current-agent');
  });

  test('prefers the gateway result session ids in non-streaming OpenAI trace headers', async () => {
    const state = await importFreshHealth();
    state.handleGatewayMessage.mockResolvedValueOnce({
      status: 'success' as const,
      result: 'ok',
      toolsUsed: [],
      userMessageId: 11,
      assistantMessageId: 12,
      sessionId: 'sess_eval_real_1',
      sessionKey: 'agent:charly:channel:openai:chat:dm:peer:feedfacecafebeef',
      artifacts: [
        {
          path: '/tmp/report.pdf',
          filename: 'report.pdf',
          mimeType: 'application/pdf',
        },
      ],
    });
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5__hc_eval=agent=charly',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.getHeader('x-hybridclaw-session-id')).toBe('sess_eval_real_1');
    expect(res.getHeader('x-hybridclaw-session-key')).toBe(
      'agent:charly:channel:openai:chat:dm:peer:feedfacecafebeef',
    );
    expect(res.getHeader('x-hybridclaw-execution-session-id')).toMatch(
      OPENAI_EXECUTION_SESSION_ID_RE,
    );
    expect(res.getHeader('x-hybridclaw-artifact-count')).toBe('1');
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
      autoApproveTools: true,
      guildId: null,
      channelId: 'openai',
      userId: expect.stringMatching(OPENAI_SESSION_ID_RE),
      username: 'openai',
      content: 'hello',
      agentId: 'charly',
      model: 'gpt-5',
      promptMode: 'none',
      delegationPublicId: expect.stringMatching(OPENAI_COMPLETION_ID_RE),
      source: 'gateway.chat.openai-compatible',
    });

    const payload = JSON.parse(res.body);
    expect(payload.model).toBe('gpt-5');
  });

  test('routes auxiliary eval judge OpenAI requests through the auxiliary model caller', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'auxiliary/eval_judge',
        messages: [
          { role: 'system', content: 'Return JSON only.' },
          { role: 'user', content: '{"question":"largest orders"}' },
        ],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
    expect(state.callAuxiliaryModel).toHaveBeenCalledWith({
      task: 'eval_judge',
      messages: [
        { role: 'system', content: 'Return JSON only.' },
        { role: 'user', content: '{"question":"largest orders"}' },
      ],
      fallbackModel: expect.any(String),
      agentId: 'main',
      temperature: 0,
    });

    const payload = JSON.parse(res.body);
    expect(payload.model).toBe('vllm/Qwen/Qwen3.6-27B-FP8');
    expect(payload.choices[0].message.content).toBe(
      '{"status":"pass","summary":"ok","findings":[]}',
    );
    expect(res.getHeader('x-hybridclaw-auxiliary-task')).toBe('eval_judge');
    expect(res.getHeader('x-hybridclaw-auxiliary-provider')).toBe('vllm');
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
      autoApproveTools: true,
      guildId: null,
      channelId: 'openai',
      userId: expect.stringMatching(OPENAI_SESSION_ID_RE),
      username: 'openai',
      content: 'hello',
      agentId: expect.stringMatching(/^eval-[a-f0-9]{16}$/),
      model: 'gpt-5',
      omitPromptParts: ['bootstrap', 'soul'],
      delegationPublicId: expect.stringMatching(OPENAI_COMPLETION_ID_RE),
      source: 'gateway.chat.openai-compatible',
      executionSessionId: expect.stringMatching(OPENAI_EXECUTION_SESSION_ID_RE),
    });
    expect(state.stopSessionExecution).toHaveBeenCalledWith(
      expect.stringMatching(OPENAI_EXECUTION_SESSION_ID_RE),
    );
    expect(res.getHeader('x-hybridclaw-session-id')).toMatch(
      OPENAI_SESSION_ID_RE,
    );
    expect(res.getHeader('x-hybridclaw-agent-id')).toMatch(
      /^eval-[a-f0-9]{16}$/,
    );
    expect(res.getHeader('x-hybridclaw-workspace-mode')).toBe('fresh-agent');
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

  test('adds delegation metadata to the OpenAI streaming stop chunk when a job is created', async () => {
    const state = await importFreshHealth();
    state.handleGatewayMessage.mockImplementationOnce(
      async (request: { delegationPublicId?: string }) => ({
        status: 'success' as const,
        result:
          "Started 1 delegate job. I'll synthesize the final answer when they finish.",
        toolsUsed: [],
        delegation: {
          id: request.delegationPublicId || 'chatcmpl_missing',
          status: 'queued' as const,
        },
      }),
    );
    const req = makeRequest({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-5',
        stream: true,
        messages: [{ role: 'user', content: 'Research this deeply.' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    const chunks = res.body
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: {'))
      .map((chunk) => JSON.parse(chunk.slice('data: '.length)));
    const stopChunk = chunks.find(
      (chunk) => chunk.choices?.[0]?.finish_reason === 'stop',
    );
    expect(stopChunk?.id).toMatch(OPENAI_COMPLETION_ID_RE);
    expect(stopChunk?.hybridclaw).toEqual({
      delegation: {
        id: stopChunk.id,
        status: 'queued',
      },
    });
  });

  test('retrieves OpenAI-compatible delegation jobs by completion id', async () => {
    const state = await importFreshHealth();
    const cases = [
      {
        status: 'queued',
        content:
          "Started 1 delegate job. I'll synthesize the final answer when they finish.",
        finishReason: null,
      },
      {
        status: 'in_progress',
        content:
          "Started 1 delegate job. I'll synthesize the final answer when they finish.",
        finishReason: null,
      },
      {
        status: 'completed',
        content: 'Synthesized final answer.',
        finishReason: 'stop',
      },
      {
        status: 'failed',
        content: null,
        finishReason: null,
        error: {
          message: 'gateway_restart',
          type: 'server_error',
        },
      },
      {
        status: 'cancelled',
        content: null,
        finishReason: null,
      },
    ] as const;

    for (const item of cases) {
      const id = `chatcmpl_${item.status}`;
      state.getDelegationJob.mockReturnValueOnce({
        public_id: id,
        internal_id: `internal-${item.status}`,
        parent_session_id: 'agent:main:channel:openai:chat:dm:peer:abc123',
        channel_id: 'openai',
        agent_id: 'main',
        model: 'gpt-5',
        status: item.status,
        task_count: 1,
        ack_text:
          "Started 1 delegate job. I'll synthesize the final answer when they finish.",
        result_text:
          item.status === 'completed' ? 'Synthesized final answer.' : null,
        result_digest: item.status === 'completed' ? 'Digest.' : null,
        artifacts_json: null,
        error: item.status === 'failed' ? 'gateway_restart' : null,
        created_at: '2026-07-08 12:34:56',
        started_at:
          item.status === 'queued' ? null : '2026-07-08 12:35:00',
        completed_at:
          item.status === 'queued' || item.status === 'in_progress'
            ? null
            : '2026-07-08 12:36:00',
      });
      const req = makeRequest({
        method: 'GET',
        url: `/v1/chat/completions/${encodeURIComponent(id)}`,
      });
      const res = makeResponse();

      state.handler(req as never, res as never);
      await waitForResponse(res, (next) => next.writableEnded);

      const payload = JSON.parse(res.body);
      expect(res.statusCode).toBe(200);
      expect(payload).toMatchObject({
        id,
        object: 'chat.completion',
        model: 'gpt-5',
        status: item.status,
      });
      expect(payload.choices[0]).toEqual({
        index: 0,
        message: {
          role: 'assistant',
          content: item.content,
        },
        finish_reason: item.finishReason,
      });
      if (item.error) {
        expect(payload.error).toEqual(item.error);
      } else {
        expect(payload.error).toBeUndefined();
      }
      expect(res.getHeader('x-hybridclaw-session-id')).toBe(
        'agent:main:channel:openai:chat:dm:peer:abc123',
      );
      expect(res.getHeader('x-hybridclaw-delegation-status')).toBe(
        item.status,
      );
    }
  });

  test('returns OpenAI error shape for unknown delegation completion ids', async () => {
    const state = await importFreshHealth();
    state.getDelegationJob.mockReturnValueOnce(null);
    const req = makeRequest({
      method: 'GET',
      url: '/v1/chat/completions/chatcmpl_missing',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: {
        message: 'No delegation job found for this completion id.',
        type: 'invalid_request_error',
        param: null,
        code: 'not_found',
      },
    });
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

  test('serves the about page from the install docs directory', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/about' });
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
    expect(res.body).toContain(
      'class="docs-sidebar-link is-active" href="/docs"',
    );
    expect(res.body).toContain('><span>HybridClaw Docs</span></a>');
  });

  test('hides internal docs from navigation and search while preserving direct links', async () => {
    const state = await importFreshHealth();
    const indexReq = makeRequest({ url: '/docs' });
    const indexRes = makeResponse();

    state.handler(indexReq as never, indexRes as never);

    expect(indexRes.statusCode).toBe(200);
    expect(indexRes.body).not.toContain('<summary>Internal</summary>');
    expect(indexRes.body).not.toContain('href="/docs/internal/roadmap"');
    expect(indexRes.body).not.toContain('Agent, That Really Works - Roadmap');

    const searchReq = makeRequest({ url: '/docs?search=approval' });
    const searchRes = makeResponse();
    state.handler(searchReq as never, searchRes as never);

    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.body).not.toContain(
      'href="/docs/internal/approval-rule-pipeline"',
    );

    const directReq = makeRequest({ url: '/docs/internal/roadmap' });
    const directRes = makeResponse();
    state.handler(directReq as never, directRes as never);

    expect(directRes.statusCode).toBe(200);
    expect(directRes.body).toContain('Agent, That Really Works - Roadmap');
    expect(directRes.body).not.toContain('<summary>Internal</summary>');
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

  test('redirects root to chat and keeps the landing page at /about', async () => {
    const state = await importFreshHealth();

    const rootReq = makeRequest({ url: '/' });
    const rootRes = makeResponse();

    state.handler(rootReq as never, rootRes as never);

    expect(rootRes.statusCode).toBe(302);
    expect(rootRes.headers.Location).toBe('/chat');
    expect(rootRes.headers['Cache-Control']).toBe('no-store');

    for (const pathname of ['/about', '/about/']) {
      const aboutReq = makeRequest({ url: pathname });
      const aboutRes = makeResponse();

      state.handler(aboutReq as never, aboutRes as never);

      expect(aboutRes.statusCode).toBe(200);
      expect(aboutRes.headers['Content-Type']).toBe('text/html; charset=utf-8');
      expect(aboutRes.body).toContain('<h1>Docs</h1>');
    }
  });

  test('serves the A2A Agent Card from the configured public deployment URL', async () => {
    const state = await importFreshHealth({
      deploymentPublicUrl: 'https://u-public.sbx.hybridai.one',
    });
    const req = makeRequest({
      url: '/.well-known/agent.json',
      headers: { host: '172.19.0.11:9090' },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      url: 'https://u-public.sbx.hybridai.one/a2a',
    });
    expect(state.getGatewayA2AAgentCard).toHaveBeenCalledWith(
      'https://u-public.sbx.hybridai.one',
      expect.objectContaining({ peerTrustLevel: 'public' }),
    );
  });

  test('serves the A2A Agent Card from request origin when public deployment URL is unset', async () => {
    const state = await importFreshHealth({ deploymentPublicUrl: '' });
    const req = makeRequest({
      url: '/.well-known/agent.json',
      headers: {
        host: 'edge.example.test',
        'x-forwarded-proto': 'https',
      },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      url: 'https://edge.example.test/a2a',
    });
    expect(state.getGatewayA2AAgentCard).toHaveBeenCalledWith(
      'https://edge.example.test',
      expect.objectContaining({ peerTrustLevel: 'public' }),
    );
  });

  test('rejects invalid configured public deployment URLs for the A2A Agent Card', async () => {
    const state = await importFreshHealth({
      deploymentPublicUrl: 'ftp://u-public.sbx.hybridai.one',
    });
    const req = makeRequest({
      url: '/.well-known/agent.json',
      headers: { host: '172.19.0.11:9090' },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      error: 'deployment.public_url must be an HTTP(S) URL.',
    });
    expect(state.getGatewayA2AAgentCard).not.toHaveBeenCalled();
    expect(state.loggerWarn).toHaveBeenCalledWith(
      { publicUrl: 'ftp://u-public.sbx.hybridai.one' },
      'Invalid deployment.public_url for A2A Agent Card',
    );
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
      url: '/agents.html',
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

  test('serves admin console public icon assets', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/icons/github.svg' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/svg+xml');
    expect(res.body).toContain('<svg');
  });

  test('does not serve traversal-looking admin console icon paths', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/icons/%2e%2e/%2e%2e/config.json' });
    const res = makeResponse();

    state.handler(req as never, res as never);

    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('Not Found');
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

  test('/auth/callback redirects with a session cookie when WEB_API_TOKEN is set', async () => {
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

    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('/admin');
    expect(res.body).not.toContain('my-web-token');
    expect(res.body).not.toContain('hybridclaw_token');
    expect(res.headers['Set-Cookie']).toEqual(
      expect.stringContaining('hybridclaw_session='),
    );
    expect(res.headers['Set-Cookie']).toEqual(
      expect.stringContaining('HttpOnly'),
    );
  });

  test('/auth/callback does not render token-bearing HTML when WEB_API_TOKEN is set', async () => {
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

    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('/admin');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['Content-Security-Policy']).toBeUndefined();
    expect(res.body).toBe('');
  });

  test('/auth/callback never reflects WEB_API_TOKEN characters into the response body', async () => {
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

    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('/admin');
    expect(res.body).not.toContain('token-with-');
    expect(res.body).not.toContain('<script>');
    expect(res.body).toBe('');
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

  test('/auth/callback respects a valid next query parameter when WEB_API_TOKEN is set', async () => {
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

    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('/dashboard');
    expect(res.body).toBe('');
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
      channelId: 'web',
      userId: 'web',
      username: 'web',
      agentId: undefined,
    });
    expect(state.getGatewayHistory).toHaveBeenCalledWith('s1', 2, {
      operatorUserId: 'web',
    });
    expect(state.getGatewayHistorySummary).toHaveBeenCalledWith('s1', {
      sinceMs: null,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      sessionId: 's1',
      agentId: 'research',
      sessionKey: undefined,
      mainSessionKey: undefined,
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
      noAuth: true,
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

  test('accepts valid web chat response ratings', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat/rating',
      body: {
        sessionId: 'agent:main:channel:web:chat:dm:peer:abc123abc123abcd',
        messageId: 12,
        userId: 'web-user-abcd',
        rating: 'up',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.submitResponseRating).toHaveBeenCalledWith({
      sessionId: 'agent:main:channel:web:chat:dm:peer:abc123abc123abcd',
      messageId: 12,
      operatorUserId: 'web-user-abcd',
      rating: 'up',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      sessionId: 'agent:main:channel:web:chat:dm:peer:abc123abc123abcd',
      messageId: 12,
      rating: 'up',
    });
  });

  test('returns 404 for missing web chat response rating targets', async () => {
    const state = await importFreshHealth();
    state.submitResponseRating.mockImplementationOnce(() => {
      throw new state.ResponseRatingNotFoundError();
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat/rating',
      body: {
        sessionId: 'agent:main:channel:web:chat:dm:peer:abc123abc123abcd',
        messageId: 999,
        rating: 'up',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Response message was not found.',
    });
  });

  test('rejects invalid web chat response rating payloads', async () => {
    const state = await importFreshHealth();
    const missingSessionReq = makeRequest({
      method: 'POST',
      url: '/api/chat/rating',
      body: { messageId: 12, rating: 'up' },
    });
    const missingSessionRes = makeResponse();

    state.handler(missingSessionReq as never, missingSessionRes as never);
    await waitForResponse(missingSessionRes, (next) => next.writableEnded);

    expect(missingSessionRes.statusCode).toBe(400);
    expect(JSON.parse(missingSessionRes.body)).toEqual({
      error: 'Missing `sessionId` in request body.',
    });

    const malformedSessionReq = makeRequest({
      method: 'POST',
      url: '/api/chat/rating',
      body: {
        sessionId: 'agent:main:channel:web:bad',
        messageId: 12,
        rating: 'up',
      },
    });
    const malformedSessionRes = makeResponse();

    state.handler(malformedSessionReq as never, malformedSessionRes as never);
    await waitForResponse(malformedSessionRes, (next) => next.writableEnded);

    expect(malformedSessionRes.statusCode).toBe(400);
    expect(JSON.parse(malformedSessionRes.body)).toEqual({
      error: 'Malformed canonical `sessionId`.',
    });

    const invalidMessageReq = makeRequest({
      method: 'POST',
      url: '/api/chat/rating',
      body: { sessionId: 's1', messageId: '12abc', rating: 'up' },
    });
    const invalidMessageRes = makeResponse();

    state.handler(invalidMessageReq as never, invalidMessageRes as never);
    await waitForResponse(invalidMessageRes, (next) => next.writableEnded);

    expect(invalidMessageRes.statusCode).toBe(400);
    expect(JSON.parse(invalidMessageRes.body)).toEqual({
      error: 'Missing valid positive integer `messageId` in request body.',
    });

    const invalidRatingReq = makeRequest({
      method: 'POST',
      url: '/api/chat/rating',
      body: { sessionId: 's1', messageId: 12, rating: 'maybe' },
    });
    const invalidRatingRes = makeResponse();

    state.handler(invalidRatingReq as never, invalidRatingRes as never);
    await waitForResponse(invalidRatingRes, (next) => next.writableEnded);

    expect(invalidRatingRes.statusCode).toBe(400);
    expect(JSON.parse(invalidRatingRes.body)).toEqual({
      error: '`rating` must be "up", "down", or null.',
    });
    expect(state.submitResponseRating).not.toHaveBeenCalled();
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
      fallbackToChannelRecent: true,
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

  test('passes chat title search queries through to recent session lookup', async () => {
    const authSecret = 'health-secret';
    const sessionToken = signAuthPayload(
      {
        exp: Math.floor(Date.now() / 1000) + 60,
        iat: Math.floor(Date.now() / 1000),
        sub: 'user-1',
        typ: 'session',
      },
      authSecret,
    );
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      url: '/api/chat/recent?userId=web-user-a&channelId=web&limit=25&q=deploy',
      headers: {
        cookie: `hybridclaw_session=${sessionToken}`,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.getGatewayRecentChatSessions).toHaveBeenCalledWith({
      userId: 'user-1',
      channelId: 'web',
      limit: 25,
      query: 'deploy',
    });
  });

  test('passes explicit user chat scope without channel fallback', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });
    const req = makeRequest({
      url: '/api/chat/recent?userId=web-user-a&channelId=web&limit=10&scope=user',
      headers: {
        authorization: 'Bearer web-token',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.getGatewayRecentChatSessions).toHaveBeenCalledWith({
      userId: 'web-user-a',
      channelId: 'web',
      limit: 10,
      includeScheduled: false,
    });
  });

  test('passes explicit all chat scope with channel fallback', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });
    const req = makeRequest({
      url: '/api/chat/recent?userId=web-user-a&channelId=web&limit=10&scope=all',
      headers: {
        authorization: 'Bearer web-token',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.getGatewayRecentChatSessions).toHaveBeenCalledWith({
      userId: 'web-user-a',
      channelId: 'web',
      limit: 10,
      includeScheduled: true,
      fallbackToChannelRecent: true,
    });
  });

  test('uses the signed session subject for web chat history search', async () => {
    const authSecret = 'health-secret';
    const sessionToken = signAuthPayload(
      {
        exp: Math.floor(Date.now() / 1000) + 60,
        iat: Math.floor(Date.now() / 1000),
        sub: 'user-1',
        typ: 'session',
      },
      authSecret,
    );
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      url: '/api/chat/recent?channelId=web&limit=25&q=deploy',
      headers: {
        cookie: `hybridclaw_session=${sessionToken}`,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.getGatewayRecentChatSessions).toHaveBeenCalledWith({
      userId: 'user-1',
      channelId: 'web',
      limit: 25,
      query: 'deploy',
    });
  });

  test('caps recent chat search limit and query length before lookup', async () => {
    const authSecret = 'health-secret';
    const sessionToken = signAuthPayload(
      {
        exp: Math.floor(Date.now() / 1000) + 60,
        iat: Math.floor(Date.now() / 1000),
        sub: 'user-1',
        typ: 'session',
      },
      authSecret,
    );
    const state = await importFreshHealth({ authSecret });
    const longQuery = 'd'.repeat(250);
    const req = makeRequest({
      url: `/api/chat/recent?userId=web-user-a&channelId=web&limit=9999&q=${longQuery}`,
      headers: {
        cookie: `hybridclaw_session=${sessionToken}`,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.getGatewayRecentChatSessions).toHaveBeenCalledWith({
      userId: 'user-1',
      channelId: 'web',
      limit: 200,
      query: 'd'.repeat(200),
    });
  });

  test('accepts web chat search with request auth and explicit user id', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });
    const req = makeRequest({
      url: '/api/chat/recent?userId=web-user-a&channelId=web&limit=25&q=deploy',
      headers: {
        authorization: 'Bearer web-token',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.getGatewayRecentChatSessions).toHaveBeenCalledWith({
      userId: 'web-user-a',
      channelId: 'web',
      limit: 25,
      query: 'deploy',
      fallbackToChannelRecent: true,
    });
    expect(res.statusCode).toBe(200);
  });

  test('requires API auth for mobile chat QR handoff creation', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat/mobile-qr',
      remoteAddress: '203.0.113.10',
      noAuth: true,
      body: {
        userId: 'web-user-a',
        sessionId: 'agent:main:channel:web:chat:dm:peer:1234567890abcdef',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
    });
  });

  test('creates and redeems mobile chat QR handoffs once', async () => {
    const state = await importFreshHealth({
      authSecret: 'mobile-qr-auth-secret',
      webApiToken: 'web-token',
    });
    const sessionId = 'agent:main:channel:web:chat:dm:peer:1234567890abcdef';
    const { createRes, payload, continueReq, continueRes } =
      await createAndRedeemMobileChatQr({ state, sessionId });

    expect(createRes.statusCode).toBe(200);
    expect(payload.launchUrl).toMatch(
      /^https:\/\/example\.test\/chat\/continue\?token=/,
    );
    expect(payload.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload.qrSvg).toContain('<svg');

    expect(continueRes.statusCode).toBe(200);
    expect(continueRes.body).toContain(
      `localStorage.setItem('hybridclaw_user_id',"web-user-a");`,
    );
    expect(continueRes.body).toContain(
      `localStorage.setItem('hybridclaw_session',"${sessionId}");`,
    );
    expect(continueRes.body).toContain(
      `window.location.replace("/chat/${encodeURIComponent(sessionId)}");`,
    );
    expect(continueRes.headers['Set-Cookie']).toEqual(
      expect.stringContaining('hybridclaw_session='),
    );
    expect(continueRes.headers['Set-Cookie']).toEqual(
      expect.stringContaining('HttpOnly'),
    );

    const replayRes = makeResponse();
    state.handler(continueReq as never, replayRes as never);
    await waitForResponse(replayRes, (next) => next.writableEnded);

    expect(replayRes.statusCode).toBe(401);
    expect(replayRes.body).toBe('Mobile launch QR code is invalid or expired.');
  });

  test('mobile chat QR uses configured public URL when request host is internal', async () => {
    const state = await importFreshHealth({
      authSecret: 'mobile-qr-public-url-secret',
      deploymentPublicUrl: 'https://u-public.sbx.hybridai.one',
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat/mobile-qr',
      headers: {
        authorization: 'Bearer web-token',
        host: '172.19.0.21:9090',
      },
      body: {
        userId: 'web-user-a',
        sessionId: 'agent:main:channel:web:chat:dm:peer:1234567890abcdef',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body) as { launchUrl: string };
    expect(payload.launchUrl).toMatch(
      /^https:\/\/u-public\.sbx\.hybridai\.one\/chat\/continue\?token=/,
    );
  });

  test('rejects protected mobile chat QR creation when auth secret is missing', async () => {
    const state = await importFreshHealth({
      runningInsideContainer: true,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat/mobile-qr',
      headers: {
        authorization: 'Bearer web-token',
      },
      body: {
        userId: 'web-user-a',
        sessionId: 'agent:main:channel:web:chat:dm:peer:1234567890abcdef',
        baseUrl: 'https://example.test/chat',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      error:
        'Mobile launch QR code cannot establish a web session because HybridClaw auth secret is not configured.',
    });
  });

  test('mobile chat QR handoff establishes session auth before redirecting to chat in Docker', async () => {
    const state = await importFreshHealth({
      authSecret: 'mobile-qr-docker-auth-secret',
      runningInsideContainer: true,
      webApiToken: 'web-token',
    });
    const sessionId = 'agent:main:channel:web:chat:dm:peer:1234567890abcdef';
    const { continueRes, sessionCookie } = await createAndRedeemMobileChatQr({
      state,
      sessionId,
      continueNoAuth: true,
    });

    expect(continueRes.statusCode).toBe(200);
    expect(sessionCookie).toMatch(/^hybridclaw_session=.+/);
    expect(continueRes.body).toContain(
      `window.location.replace("/chat/${encodeURIComponent(sessionId)}");`,
    );

    const chatReq = makeRequest({
      url: `/chat/${encodeURIComponent(sessionId)}`,
      headers: { cookie: sessionCookie },
      noAuth: true,
    });
    const chatRes = makeResponse();

    state.handler(chatReq as never, chatRes as never);

    expect(chatRes.statusCode).toBe(200);
    expect(chatRes.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(chatRes.body).toContain('<h1>Admin</h1>');
  });

  test('rejects expired mobile chat QR handoff tokens', async () => {
    const dateNow = vi.spyOn(Date, 'now');
    dateNow.mockReturnValue(new Date('2026-04-26T12:00:00.000Z').getTime());
    try {
      const state = await importFreshHealth();
      const createReq = makeRequest({
        method: 'POST',
        url: '/api/chat/mobile-qr',
        body: {
          userId: 'web-user-a',
          sessionId: 'agent:main:channel:web:chat:dm:peer:1234567890abcdef',
          baseUrl: 'https://example.test',
        },
      });
      const createRes = makeResponse();

      state.handler(createReq as never, createRes as never);
      await waitForResponse(createRes, (next) => next.writableEnded);

      const payload = JSON.parse(createRes.body) as { launchUrl: string };
      dateNow.mockReturnValue(new Date('2026-04-26T12:10:00.001Z').getTime());

      const continueUrl = new URL(payload.launchUrl);
      const continueReq = makeRequest({
        url: `${continueUrl.pathname}${continueUrl.search}`,
      });
      const continueRes = makeResponse();
      state.handler(continueReq as never, continueRes as never);
      await waitForResponse(continueRes, (next) => next.writableEnded);

      expect(continueRes.statusCode).toBe(401);
      expect(continueRes.body).toBe(
        'Mobile launch QR code is invalid or expired.',
      );
    } finally {
      dateNow.mockRestore();
    }
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

  test('denies scoped admin sessions without the required route action', async () => {
    const authSecret = 'admin-rbac-deny-auth-secret';
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/config/reload',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          actions: ['admin.overview.read'],
        }),
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.refreshRuntimeSecretsFromEnv).not.toHaveBeenCalled();
    expect(state.reloadRuntimeConfig).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden.' });
  });

  test('allows unscoped HybridAI sessions as full admin sessions', async () => {
    const authSecret = 'admin-rbac-unscoped-auth-secret';
    const state = await importFreshHealth({ authSecret, webApiToken: 'web' });
    const req = makeRequest({
      url: '/api/admin/skills',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          sub: 'user-1',
        }),
      },
      noAuth: true,
      remoteAddress: '203.0.113.10',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(state.getGatewayAdminSkills).toHaveBeenCalledTimes(1);
  });

  test('passes no-user guard to admin session deletion', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'DELETE',
      url: '/api/admin/sessions?sessionId=session-a&ifNoUserMessages=1',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.deleteGatewayAdminSession).toHaveBeenCalledWith('session-a', {
      onlyWithoutUserMessages: true,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      deleted: true,
      sessionId: 's1',
    });
  });

  test('cleans no-user web chat sessions through the chat cleanup endpoint', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat/cleanup?channelId=web&keepSessionId=new-session',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.cleanupGatewayNoUserChatSessions).toHaveBeenCalledWith({
      channelId: 'web',
      keepSessionId: 'new-session',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      deletedCount: 2,
      deletedSessionIds: ['old-empty', 'old-opening'],
      keptSessionId: 'new-session',
    });
  });

  test('allows scoped admin sessions with a matching wildcard route action', async () => {
    const authSecret = 'admin-rbac-allow-auth-secret';
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/config/reload',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          scope: 'admin.config:*',
        }),
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.refreshRuntimeSecretsFromEnv).toHaveBeenCalledTimes(1);
    expect(state.reloadRuntimeConfig).toHaveBeenCalledWith('admin-api');
    expect(res.statusCode).toBe(200);
  });

  test('allows scoped admin sessions with a matching role bundle action', async () => {
    const authSecret = 'admin-rbac-role-auth-secret';
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/config/reload',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          role: 'admin.config_manager',
        }),
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.refreshRuntimeSecretsFromEnv).toHaveBeenCalledTimes(1);
    expect(state.reloadRuntimeConfig).toHaveBeenCalledWith('admin-api');
    expect(res.statusCode).toBe(200);
  });

  test('allows scoped admin sessions through ISO role bundle aliases', async () => {
    const authSecret = 'admin-rbac-iso-role-auth-secret';
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      url: '/api/admin/audit',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          roles: ['admin:auditor'],
        }),
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(state.getGatewayAdminAudit).toHaveBeenCalledTimes(1);
  });

  test('denies scoped admin sessions when a role bundle lacks the route action', async () => {
    const authSecret = 'admin-rbac-role-deny-auth-secret';
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/config',
      body: {},
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          roles: ['admin:auditor'],
        }),
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(403);
  });

  test('returns admin secret metadata without cleartext values', async () => {
    const authSecret = 'secret-list-auth-secret';
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      url: '/api/admin/secrets',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          actions: ['secret.list_metadata'],
        }),
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminSecrets).toHaveBeenCalledWith({
      audit: {
        sessionId: 'admin-session-1',
        actor: 'admin-user',
        sourceIp: '127.0.0.1',
      },
      sessionPayload: expect.objectContaining({
        actor: 'admin-user',
        actions: ['secret.list_metadata'],
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      secrets: [
        {
          name: 'SET_SECRET',
          state: 'set',
          created_at: '2026-05-17T10:00:00.000Z',
          last_rotated_at: '2026-05-17T10:00:00.000Z',
          length: 12,
          fingerprint: {
            length: 12,
            sha256_prefix: '0123456789ab',
          },
        },
        {
          name: 'OTHER_SECRET',
          state: 'unset',
          created_at: null,
          last_rotated_at: null,
          length: null,
          fingerprint: null,
        },
      ],
      total: 2,
      actions: ['secret.list_metadata'],
    });
    expect(res.body).not.toContain('super-secret');
  });

  test('denies scoped admin secret metadata sessions without secret action claims', async () => {
    const authSecret = 'secret-list-deny-auth-secret';
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      url: '/api/admin/secrets',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          actions: ['admin.overview.read'],
        }),
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminSecrets).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  test('denies scoped API tokens without secret overwrite claims before reading the body', async () => {
    const apiToken = 'hck_secret_read_only';
    const state = await importFreshHealth({
      apiTokens: {
        [apiToken]: {
          id: 'abc123abc123',
          label: 'secret-reader',
          claims: { actions: ['secret.list_metadata'] },
        },
      },
    });
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/secrets/SET_SECRET',
      body: { value: 'denied-api-token-secret' },
      headers: {
        authorization: `Bearer ${apiToken}`,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.verifyApiToken).toHaveBeenCalledWith(apiToken);
    expect(state.overwriteGatewayAdminSecret).not.toHaveBeenCalled();
    expect(state.recordGatewayAdminSecretMutationFailure).toHaveBeenCalledWith({
      type: 'secret.overwritten',
      name: 'SET_SECRET',
      audit: {
        sessionId: 'apiToken:abc123abc123:secret-reader',
        actor: 'apiToken:abc123abc123:secret-reader',
        sourceIp: '127.0.0.1',
      },
      errorCode: 'forbidden',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('denied-api-token-secret');
  });

  test('allows scoped API tokens with matching secret overwrite claims', async () => {
    const apiToken = 'hck_secret_writer';
    const state = await importFreshHealth({
      apiTokens: {
        [apiToken]: {
          id: 'def456def456',
          label: 'secret-writer',
          claims: { actions: ['secret.overwrite'] },
        },
      },
    });
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/secrets/SET_SECRET',
      body: { value: 'rotated-by-token' },
      headers: {
        authorization: `Bearer ${apiToken}`,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.overwriteGatewayAdminSecret).toHaveBeenCalledWith({
      name: 'SET_SECRET',
      value: 'rotated-by-token',
      audit: {
        sessionId: 'apiToken:def456def456:secret-writer',
        actor: 'apiToken:def456def456:secret-writer',
        sourceIp: '127.0.0.1',
      },
    });
    expect(res.statusCode).toBe(200);
  });

  test('rejects unsupported admin secret metadata methods before listing names', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/secrets',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminSecrets).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(405);
    expect(res.body).not.toContain('SET_SECRET');
    expect(res.body).not.toContain('OTHER_SECRET');
  });

  test('rejects unauthenticated admin secret metadata requests before listing names', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/secrets',
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminSecrets).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('SET_SECRET');
    expect(res.body).not.toContain('OTHER_SECRET');
  });

  test('overwrites an admin secret without echoing the submitted value', async () => {
    const authSecret = 'secret-overwrite-auth-secret';
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/secrets/SET_SECRET',
      body: { value: 'rotated-super-secret' },
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          actions: ['secret.overwrite'],
        }),
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.overwriteGatewayAdminSecret).toHaveBeenCalledWith({
      name: 'SET_SECRET',
      value: 'rotated-super-secret',
      audit: {
        sessionId: 'admin-session-1',
        actor: 'admin-user',
        sourceIp: '127.0.0.1',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      secret: {
        name: 'SET_SECRET',
        state: 'set',
        length: 'rotated-super-secret'.length,
        fingerprint: {
          sha256_prefix: 'fedcba987654',
        },
      },
    });
    expect(res.body).not.toContain('rotated-super-secret');
  });

  test('unsets an admin secret by name', async () => {
    const authSecret = 'secret-unset-auth-secret';
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      method: 'DELETE',
      url: '/api/admin/secrets/SET_SECRET',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          scope: 'secret.unset',
        }),
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.unsetGatewayAdminSecret).toHaveBeenCalledWith({
      name: 'SET_SECRET',
      audit: {
        sessionId: 'admin-session-1',
        actor: 'admin-user',
        sourceIp: '127.0.0.1',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      secret: {
        name: 'SET_SECRET',
        state: 'unset',
        created_at: null,
        last_rotated_at: null,
        length: null,
        fingerprint: null,
      },
    });
  });

  test('returns 405 for admin secret read-back routes without leaking existence', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/secrets/SET_SECRET',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminSecrets).not.toHaveBeenCalled();
    expect(state.overwriteGatewayAdminSecret).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(405);
    expect(res.body).not.toContain('SET_SECRET');
    expect(res.body).not.toContain('OTHER_SECRET');
  });

  test('denies admin secret overwrite before reading or persisting the body', async () => {
    const authSecret = 'secret-deny-auth-secret';
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/secrets/SET_SECRET',
      body: { value: 'denied-super-secret' },
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          actions: ['secret.list_metadata'],
        }),
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.overwriteGatewayAdminSecret).not.toHaveBeenCalled();
    expect(state.recordGatewayAdminSecretMutationFailure).toHaveBeenCalledWith({
      type: 'secret.overwritten',
      name: 'SET_SECRET',
      audit: {
        sessionId: 'admin-session-1',
        actor: 'admin-user',
        sourceIp: '127.0.0.1',
      },
      errorCode: 'forbidden',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('denied-super-secret');
  });

  test('audits unauthenticated admin secret overwrite attempts without reading the body', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/secrets/SET_SECRET',
      body: { value: 'unauthenticated-super-secret' },
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.overwriteGatewayAdminSecret).not.toHaveBeenCalled();
    expect(state.recordGatewayAdminSecretMutationFailure).toHaveBeenCalledWith({
      type: 'secret.overwritten',
      name: 'SET_SECRET',
      audit: {
        sourceIp: '127.0.0.1',
      },
      errorCode: 'unauthorized',
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('unauthenticated-super-secret');
  });

  test('audits unauthenticated admin secret unset attempts', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'DELETE',
      url: '/api/admin/secrets/SET_SECRET',
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.unsetGatewayAdminSecret).not.toHaveBeenCalled();
    expect(state.recordGatewayAdminSecretMutationFailure).toHaveBeenCalledWith({
      type: 'secret.unset',
      name: 'SET_SECRET',
      audit: {
        sourceIp: '127.0.0.1',
      },
      errorCode: 'unauthorized',
    });
    expect(res.statusCode).toBe(401);
  });

  test('audits malformed admin secret overwrite bodies without cleartext', async () => {
    const authSecret = 'secret-bad-body-auth-secret';
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/secrets/SET_SECRET',
      body: '{"value":"bad-json-secret"',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          actions: ['secret.overwrite'],
        }),
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.overwriteGatewayAdminSecret).not.toHaveBeenCalled();
    expect(state.recordGatewayAdminSecretMutationFailure).toHaveBeenCalledWith({
      type: 'secret.overwritten',
      name: 'SET_SECRET',
      audit: {
        sessionId: 'admin-session-1',
        actor: 'admin-user',
        sourceIp: '127.0.0.1',
      },
      errorCode: 'bad_request',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('bad-json-secret');
  });

  test('lists API token metadata for authorized admin sessions', async () => {
    const authSecret = 'token-list-auth-secret';
    const state = await importFreshHealth({ authSecret });
    const req = makeRequest({
      url: '/api/admin/tokens',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          actions: ['admin.tokens.read'],
        }),
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminTokens).toHaveBeenCalledWith({
      authPayload: expect.objectContaining({
        actions: ['admin.tokens.read'],
      }),
    });
    expect(res.statusCode).toBe(200);
  });

  test('prevents API-token-authenticated requests from creating or revoking tokens', async () => {
    const apiToken = 'hck_token_admin';
    const state = await importFreshHealth({
      apiTokens: {
        [apiToken]: {
          id: 'aaa111aaa111',
          label: 'token-admin',
          claims: {
            actions: ['admin.tokens.create', 'admin.tokens.revoke'],
          },
        },
      },
    });
    const createReq = makeRequest({
      method: 'POST',
      url: '/api/admin/tokens',
      body: { label: 'new', actions: ['openai.api'] },
      headers: {
        authorization: `Bearer ${apiToken}`,
      },
    });
    const createRes = makeResponse();

    state.handler(createReq as never, createRes as never);
    await settle();

    const revokeReq = makeRequest({
      method: 'DELETE',
      url: '/api/admin/tokens/deadbeef0000',
      headers: {
        authorization: `Bearer ${apiToken}`,
      },
    });
    const revokeRes = makeResponse();

    state.handler(revokeReq as never, revokeRes as never);
    await settle();

    expect(state.createGatewayAdminToken).not.toHaveBeenCalled();
    expect(state.revokeGatewayAdminToken).not.toHaveBeenCalled();
    expect(createRes.statusCode).toBe(403);
    expect(revokeRes.statusCode).toBe(403);
  });

  test('denies scoped API tokens on unmapped API routes unless wildcarded', async () => {
    const apiToken = 'hck_chat_only';
    const state = await importFreshHealth({
      apiTokens: {
        [apiToken]: {
          id: 'bbb222bbb222',
          label: 'chat-only',
          claims: { actions: ['chat.send'] },
        },
      },
    });
    const req = makeRequest({
      url: '/api/history?sessionId=web-session-1',
      headers: {
        authorization: `Bearer ${apiToken}`,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayHistory).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  test('returns admin tunnel config for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/tunnel' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminTunnelConfig).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(state.tunnelConfigResponse);
  });

  test('saves admin tunnel config for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/tunnel',
      method: 'PUT',
      body: JSON.stringify({
        provider: 'ngrok',
        publicUrl: '',
      }),
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.saveGatewayAdminTunnelConfig).toHaveBeenCalledWith({
      provider: 'ngrok',
      publicUrl: '',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      config: {
        ...state.tunnelConfigResponse.config,
        provider: 'ngrok',
        publicUrl: '',
      },
      tunnel: state.reconnectTunnelStatus,
    });
  });

  test('reconnects the admin tunnel for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/tunnel/reconnect',
      method: 'POST',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.reconnectGatewayAdminTunnel).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      tunnel: state.reconnectTunnelStatus,
    });
  });

  test('stops the admin tunnel for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/tunnel/stop',
      method: 'POST',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.stopGatewayAdminTunnel).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      tunnel: state.stopTunnelStatus,
    });
  });

  test('returns admin statistics with default range when days is omitted', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/statistics' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminStatistics).toHaveBeenCalledTimes(1);
    expect(state.getGatewayAdminStatistics).toHaveBeenCalledWith({
      days: undefined,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      rangeDays: 30,
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      totals: { totalMessages: 5 },
      channels: [{ channelId: 'web', sessionCount: 2 }],
    });
  });

  test('forwards days query param to admin statistics service', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/statistics?days=7' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminStatistics).toHaveBeenCalledWith({
      days: '7',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).rangeDays).toBe(7);
  });

  test('clamps oversized days query param via the statistics service', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/statistics?days=9999' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminStatistics).toHaveBeenCalledWith({
      days: '9999',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).rangeDays).toBe(90);
  });

  test('returns read-only admin A2A inbox threads and selected messages', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/a2a/inbox?threadId=thread-b',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminA2AInbox).toHaveBeenCalledWith({
      threadId: 'thread-b',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      selectedThreadId: 'thread-b',
      threads: [{ id: 'thread-b', messageCount: 1 }],
      messages: [{ id: 'msg-b', threadId: 'thread-b' }],
    });
  });

  test('allows admin A2A trust upserts', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/a2a/trust',
      body: JSON.stringify({
        peerId: 'peer-prod',
        publicKeyFingerprint:
          'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.upsertGatewayAdminA2ATrustPeer).toHaveBeenCalledWith(
      {
        peerId: 'peer-prod',
        publicKeyFingerprint:
          'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_',
      },
      'admin-console',
    );
    expect(res.statusCode).toBe(200);
  });

  test('starts admin A2A pairing from the console endpoint', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/a2a/pairing',
      body: JSON.stringify({
        peerUrl: 'https://peer.example.com',
        notifyPeer: true,
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.startGatewayAdminA2APairing).toHaveBeenCalledWith(
      {
        peerUrl: 'https://peer.example.com',
        notifyPeer: true,
      },
      'admin-console',
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      proposal: { peerId: 'peer-prod' },
      remoteNotification: { status: 'sent' },
    });
  });

  test('previews admin A2A pairing before trust approval', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/a2a/pairing/preview',
      body: JSON.stringify({
        canonicalInstanceId: 'peer-prod',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.previewGatewayAdminA2APairing).toHaveBeenCalledWith({
      canonicalInstanceId: 'peer-prod',
    });
    expect(state.startGatewayAdminA2APairing).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      proposal: {
        peerId: 'peer-prod',
        publicKeyFingerprint: 'peer-fingerprint',
      },
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

  test('fetches HybridAI mailbox credentials for a requested handle', async () => {
    const previousApiKey = process.env.HYBRIDAI_API_KEY;
    process.env.HYBRIDAI_API_KEY = 'hai-test-token';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://hybridai.one/api/v1/agent-handles/') {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            handles: [
              { id: 'main-bot', handle: 'main', status: 'active' },
              { id: 'support-bot', handle: 'support', status: 'active' },
            ],
          }),
        };
      }
      if (
        url ===
        'https://hybridai.one/api/v1/agent-handles/support-bot/mailbox/credentials'
      ) {
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          'Bearer hai-test-token',
        );
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            email: 'support@example.com',
            password: 'support-password',
            imap_host: 'imap.example.com',
            imap_port: 993,
            smtp_host: 'smtp.example.com',
            smtp_port: 587,
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const state = await importFreshHealth();
      const req = makeRequest({
        url: '/api/admin/email-config/fetch?handleId=support-bot',
      });
      const res = makeResponse();

      state.handler(req as never, res as never);
      await settle();

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        handleId: 'support-bot',
        credentials: {
          email: 'support@example.com',
          imap_host: 'imap.example.com',
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.HYBRIDAI_API_KEY;
      } else {
        process.env.HYBRIDAI_API_KEY = previousApiKey;
      }
    }
  });

  test('does not fetch HybridAI mailbox credentials for an unknown handle', async () => {
    const previousApiKey = process.env.HYBRIDAI_API_KEY;
    process.env.HYBRIDAI_API_KEY = 'hai-test-token';
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://hybridai.one/api/v1/agent-handles/') {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            handles: [{ id: 'main-bot', handle: 'main', status: 'active' }],
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const state = await importFreshHealth();
      const req = makeRequest({
        url: '/api/admin/email-config/fetch?handleId=support-bot',
      });
      const res = makeResponse();

      state.handler(req as never, res as never);
      await settle();

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({
        credentials: null,
        error: 'No HybridAI agent handle found for support-bot.',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.HYBRIDAI_API_KEY;
      } else {
        process.env.HYBRIDAI_API_KEY = previousApiKey;
      }
    }
  });

  test('rejects unauthorized requests for live admin email mailbox metadata', async () => {
    const state = await importFreshHealth({ webApiToken: 'web-token' });
    const req = makeRequest({
      url: '/api/admin/email',
      remoteAddress: '203.0.113.10',
      noAuth: true,
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

  test('reloads gateway config for authorized admin API calls', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/config/reload',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.refreshRuntimeSecretsFromEnv).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      status: 'ok',
      message: 'Gateway reloaded.',
    });
  });

  test('returns admin log file metadata and selected tail', async () => {
    const dataDir = makeTempDataDir();
    const logPath = path.join(dataDir, 'gateway', 'gateway.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(
      logPath,
      'first line\nsecond line\nthird \x1b[32mline\x1b[39m\n',
      'utf8',
    );
    const state = await importFreshHealth({ dataDir });
    const req = makeRequest({
      url: '/api/admin/logs?file=gateway&tailBytes=28',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode, res.body).toBe(200);
    const payload = JSON.parse(res.body) as {
      files: Array<{ id: string; exists: boolean; path: string }>;
      selected: { fileId: string; content: string; truncated: boolean };
    };
    expect(payload.files).toContainEqual(
      expect.objectContaining({
        id: 'gateway',
        exists: true,
        path: logPath,
      }),
    );
    expect(payload.selected).toEqual(
      expect.objectContaining({
        fileId: 'gateway',
        content: 'third line\n',
        truncated: true,
      }),
    );
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

  test('returns HybridAI bots for authorized admin API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/hybridai/bots?baseUrl=https%3A%2F%2Fuser%3Apass%40hybridai.one%2F%3Fdebug%3D1%23token',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminHybridAIBots).toHaveBeenCalledWith({
      baseUrl: 'https://hybridai.one',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      bots: [
        {
          id: 'bot-support',
          name: 'Support Bot',
          description: 'Handles support requests',
          model: 'gpt-5',
        },
        {
          id: 'bot-research',
          name: 'Research Bot',
        },
      ],
    });
  });

  test('routes admin connector test requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/connectors/test',
      headers: {
        'content-type': 'application/json',
      },
      body: { provider: 'github' },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.testGatewayAdminConnector).toHaveBeenCalledWith({
      provider: 'github',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      provider: 'github',
      name: 'GitHub',
      ok: true,
      message: 'GitHub is connected.',
    });
  });

  test('rejects non-HTTPS HybridAI bot base URLs', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/hybridai/bots?baseUrl=http%3A%2F%2Fhybridai.one',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminHybridAIBots).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'baseUrl must use HTTPS.',
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
      proxy: undefined,
      role: undefined,
      reportsTo: undefined,
      delegatesTo: undefined,
      peers: undefined,
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
      proxy: undefined,
      role: undefined,
      reportsTo: undefined,
      delegatesTo: undefined,
      peers: undefined,
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

  test('passes HybridAI proxy config through admin agent update requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/agents/writer',
      headers: {
        'content-type': 'application/json',
      },
      body: {
        proxy: {
          kind: 'hybridai',
          baseUrl: 'https://user:pass@hybridai.example.com///?debug=true#token',
          chatbotId: 'support-bot',
          apiKey: '<secret:HYBRIDAI_PROXY_KEY>',
          conversationScope: 'user',
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.updateGatewayAdminAgent).toHaveBeenCalledWith('writer', {
      name: undefined,
      model: undefined,
      skills: undefined,
      chatbotId: undefined,
      enableRag: undefined,
      proxy: {
        kind: 'hybridai',
        baseUrl: 'https://hybridai.example.com',
        chatbotId: 'support-bot',
        apiKey: { source: 'store', id: 'HYBRIDAI_PROXY_KEY' },
        conversationScope: 'user',
      },
      role: undefined,
      reportsTo: undefined,
      delegatesTo: undefined,
      peers: undefined,
      workspace: undefined,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).agent.proxy).toEqual({
      kind: 'hybridai',
      baseUrl: 'https://hybridai.example.com',
      chatbotId: 'support-bot',
      apiKey: { source: 'store', id: 'HYBRIDAI_PROXY_KEY' },
      conversationScope: 'user',
    });
  });

  test('rejects non-HTTPS HybridAI proxy URLs in admin agent updates', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/agents/writer',
      headers: {
        'content-type': 'application/json',
      },
      body: {
        proxy: {
          kind: 'hybridai',
          baseUrl: 'http://hybridai.example.com',
          chatbotId: 'support-bot',
          apiKey: '<secret:HYBRIDAI_PROXY_KEY>',
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.updateGatewayAdminAgent).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'proxy.baseUrl must use HTTPS.',
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

  test('returns 404 for known admin team structure revision not-found errors', async () => {
    const state = await importFreshHealth();
    state.getGatewayAdminTeamStructureRevision.mockImplementationOnce(() => {
      throw new Error('Team structure revision 999 was not found.');
    });
    const req = makeRequest({
      url: '/api/admin/team-structure/revisions/999',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Team structure revision 999 was not found.',
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
          monthlySpendUsd: 0.01,
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

  test('returns lightweight agent list for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/agents/list' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAgentList).toHaveBeenCalledTimes(1);
    expect(state.getGatewayAgents).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      agents: [{ id: 'main', name: 'Main Agent' }],
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

  test('returns admin agent scoreboard for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/agent-scoreboard' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminAgentScoreboard).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      observed_skill_count: 2,
      agents: [
        {
          agent_id: 'charly',
          display_name: 'Charly',
          total_executions: 3,
          success_rate: 1,
          avg_score: 90,
          avg_quality_score: 95,
          avg_reliability_score: 88,
          avg_timing_score: 70,
          best_skills: [],
          last_observed_at: '2026-04-27T10:00:00.000Z',
        },
      ],
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
      cards: [],
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
      suspendedSessions: [],
    });
  });

  test('returns job budget summaries for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/jobs/budgets?agentId=main&agentId=agent-a&agentId=agent-b',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getBoardBudgetSummaries).toHaveBeenCalledWith({
      agentIds: ['main', 'agent-a', 'agent-b'],
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      budgets: [
        {
          agentId: 'main',
          used: 3.4,
          cap: 60,
          unit: 'USD',
          currency: 'USD',
          percent: 5.666,
        },
      ],
    });
  });

  test('exposes job edge mutation and query APIs', async () => {
    const state = await importFreshHealth();
    const createReq = makeRequest({
      method: 'POST',
      url: '/api/admin/jobs/edges',
      body: {
        fromCardId: 'card-a',
        toCardId: 'card-b',
        kind: 'blocks',
        actor: { userId: 'user_a' },
        sessionId: 'board-session',
        runId: 'board-run',
      },
    });
    const createRes = makeResponse();

    state.handler(createReq as never, createRes as never);
    await settle();

    expect(state.addEdge).toHaveBeenCalledWith('card-a', 'card-b', 'blocks', {
      actor: { userId: 'user_a' },
      sessionId: 'board-session',
      runId: 'board-run',
    });
    expect(createRes.statusCode).toBe(200);
    expect(JSON.parse(createRes.body)).toMatchObject({
      edge: {
        id: 'edge-1',
        fromCardId: 'card-a',
        toCardId: 'card-b',
        kind: 'blocks',
      },
    });

    const listReq = makeRequest({
      url: '/api/admin/jobs/edges?cardId=card-b&kind=blocked_by',
    });
    const listRes = makeResponse();
    state.handler(listReq as never, listRes as never);
    await settle();
    expect(state.listEdges).toHaveBeenCalledWith('card-b', 'blocked_by');
    expect(JSON.parse(listRes.body)).toMatchObject({
      edges: [{ id: 'edge-1' }],
    });

    const blockedReq = makeRequest({
      url: '/api/admin/jobs/blocked?cardId=card-b',
    });
    const blockedRes = makeResponse();
    state.handler(blockedReq as never, blockedRes as never);
    await settle();
    expect(state.isBlocked).toHaveBeenCalledWith('card-b');
    expect(JSON.parse(blockedRes.body)).toEqual({
      cardId: 'card-b',
      blocked: true,
    });

    const deleteReq = makeRequest({
      method: 'DELETE',
      url: '/api/admin/jobs/edges?id=edge-1',
      body: {
        actor: { userId: 'user_a' },
        sessionId: 'board-session',
        runId: 'board-run',
      },
    });
    const deleteRes = makeResponse();
    state.handler(deleteReq as never, deleteRes as never);
    await settle();
    expect(state.removeEdge).toHaveBeenCalledWith('edge-1', {
      actor: { userId: 'user_a' },
      sessionId: 'board-session',
      runId: 'board-run',
    });
    expect(JSON.parse(deleteRes.body)).toMatchObject({
      edge: { id: 'edge-1' },
    });

    const revisionsReq = makeRequest({
      url: '/api/admin/jobs/edge-revisions?id=edge-1',
    });
    const revisionsRes = makeResponse();
    state.handler(revisionsReq as never, revisionsRes as never);
    await settle();
    expect(state.listEdgeRevisions).toHaveBeenCalledWith('edge-1');
    expect(JSON.parse(revisionsRes.body)).toMatchObject({
      revisions: [{ id: 7 }],
    });

    const restoreReq = makeRequest({
      method: 'POST',
      url: '/api/admin/jobs/edge-revisions',
      body: {
        id: 'edge-1',
        revisionId: 7,
        actor: { userId: 'user_a' },
        sessionId: 'board-session',
        runId: 'board-run',
      },
    });
    const restoreRes = makeResponse();
    state.handler(restoreReq as never, restoreRes as never);
    await settle();
    expect(state.restoreEdgeRevision).toHaveBeenCalledWith('edge-1', 7, {
      actor: { userId: 'user_a' },
      sessionId: 'board-session',
      runId: 'board-run',
    });
    expect(JSON.parse(restoreRes.body)).toMatchObject({
      edge: { id: 'edge-1' },
    });
  });

  test('rejects unsafe job edge system actors', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'POST',
      url: '/api/admin/jobs/edges',
      body: {
        fromCardId: 'card-a',
        toCardId: 'card-b',
        kind: 'blocks',
        actor: { system: 'cli' },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.addEdge).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: '`actor.system` must be gateway.',
    });
  });

  test('requires job edge deletes to identify the edge in the query string', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'DELETE',
      url: '/api/admin/jobs/edges',
      body: {
        id: 'edge-1',
        actor: { userId: 'user_a' },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.removeEdge).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Missing `id`.' });
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
    const state = await importFreshHealth({ gatewayApiToken: '' });
    const socket = {
      write: vi.fn(),
      destroy: vi.fn(),
    };

    state.upgradeHandler?.(
      makeRequest({
        method: 'GET',
        url: '/api/admin/terminal/stream?sessionId=terminal-session-1',
        remoteAddress: '10.0.0.5',
        noAuth: true,
      }) as never,
      socket as never,
      Buffer.alloc(0) as never,
    );

    expect(state.handleTerminalUpgrade).not.toHaveBeenCalled();
    expect(String(socket.write.mock.calls[0]?.[0] || '')).toContain(
      '401 Unauthorized',
    );
  });

  test('allows terminal websocket upgrades with local web-session cookie and matching origin', async () => {
    const state = await importFreshHealth({ deploymentPublicUrl: '' });
    const cookie = issueLocalWebSessionCookie(state);
    const socket = {
      write: vi.fn(),
      destroy: vi.fn(),
    };

    state.upgradeHandler?.(
      makeRequest({
        method: 'GET',
        url: '/api/admin/terminal/stream?sessionId=terminal-session-1',
        headers: {
          cookie,
          host: 'localhost:9090',
          origin: 'http://localhost:9090',
        },
        noAuth: true,
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

  test('rejects terminal websocket upgrades with local web-session cookie but no origin', async () => {
    const state = await importFreshHealth();
    const cookie = issueLocalWebSessionCookie(state);
    const socket = {
      write: vi.fn(),
      destroy: vi.fn(),
    };

    state.upgradeHandler?.(
      makeRequest({
        method: 'GET',
        url: '/api/admin/terminal/stream?sessionId=terminal-session-1',
        headers: {
          cookie,
          host: 'localhost:9090',
        },
        noAuth: true,
      }) as never,
      socket as never,
      Buffer.alloc(0) as never,
    );

    expect(state.handleTerminalUpgrade).not.toHaveBeenCalled();
    expect(String(socket.write.mock.calls[0]?.[0] || '')).toContain(
      '401 Unauthorized',
    );
  });

  test('allows terminal websocket upgrades with direct request auth', async () => {
    const state = await importFreshHealth();
    const socket = {
      write: vi.fn(),
      destroy: vi.fn(),
    };

    state.upgradeHandler?.(
      makeRequest({
        method: 'GET',
        url: '/api/admin/terminal/stream?sessionId=terminal-session-1',
        remoteAddress: '203.0.113.10',
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

  test('rejects terminal websocket upgrades for scoped sessions without stream access', async () => {
    const authSecret = 'terminal-rbac-deny-auth-secret';
    const state = await importFreshHealth({ authSecret });
    const socket = {
      write: vi.fn(),
      destroy: vi.fn(),
    };

    state.upgradeHandler?.(
      makeRequest({
        method: 'GET',
        url: '/api/admin/terminal/stream?sessionId=terminal-session-1',
        headers: {
          cookie: makeSessionCookie(authSecret, {
            sessionId: 'admin-session-1',
            actor: 'admin-user',
            actions: ['admin.audit.read'],
          }),
        },
        noAuth: true,
      }) as never,
      socket as never,
      Buffer.alloc(0) as never,
    );

    expect(state.handleTerminalUpgrade).not.toHaveBeenCalled();
    expect(String(socket.write.mock.calls[0]?.[0] || '')).toContain(
      '403 Forbidden',
    );
  });

  test('allows terminal websocket upgrades for scoped sessions with terminal wildcard access', async () => {
    const authSecret = 'terminal-rbac-allow-auth-secret';
    const state = await importFreshHealth({ authSecret });
    const socket = {
      write: vi.fn(),
      destroy: vi.fn(),
    };

    state.upgradeHandler?.(
      makeRequest({
        method: 'GET',
        url: '/api/admin/terminal/stream?sessionId=terminal-session-1',
        headers: {
          cookie: makeSessionCookie(authSecret, {
            sessionId: 'admin-session-1',
            actor: 'admin-user',
            scope: 'admin.terminal:*',
          }),
        },
        noAuth: true,
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
        hasSessionAuth: true,
        hasRequestAuth: false,
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
    const options = state.handleTerminalUpgrade.mock.calls[0]?.[4] as
      | { validateToken?: (token: string) => boolean }
      | undefined;
    expect(options?.validateToken?.('web-token')).toBe(true);
    expect(options?.validateToken?.('hck_terminal_token')).toBe(false);
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
      since: '',
      until: '',
      cursor: 0,
    });
    expect(res.statusCode).toBe(200);
  });

  test('forwards since/until/cursor pagination params on admin audit requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      url: '/api/admin/audit?since=2026-05-01T00:00:00.000Z&until=2026-05-23T00:00:00.000Z&cursor=512&limit=50',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminAudit).toHaveBeenCalledWith({
      eventType: '',
      limit: 50,
      query: '',
      sessionId: '',
      since: '2026-05-01T00:00:00.000Z',
      until: '2026-05-23T00:00:00.000Z',
      cursor: 512,
    });
    expect(res.statusCode).toBe(200);
  });

  test('admin audit `cursor` defaults to 0 when missing or non-positive', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/audit?cursor=-1' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 0 }),
    );
  });

  test('returns pending approvals and policy state for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({ url: '/api/admin/approvals?agentId=writer' });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.getGatewayAdminApprovals).toHaveBeenCalledWith({
      agentId: 'writer',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      selectedAgentId: 'main',
      pending: [
        {
          approvalId: 'approve-1',
          actionKey: 'network:example.com',
        },
      ],
      policy: {
        defaultAction: 'deny',
        rules: [
          {
            host: 'example.com',
            port: '*',
          },
        ],
      },
    });
  });

  test('resumes and consumes typed interactive escalation admin replies', async () => {
    const state = await importFreshHealth();
    const createReq = makeRequest({
      method: 'POST',
      url: '/api/interactive-escalations',
      body: {
        prompt: 'Enter the SMS verification code.',
        userId: 'operator-1',
        modality: 'sms',
        frameSnapshot: {
          url: 'https://sap.example/login',
          title: 'Verify sign in',
        },
        context: {
          host: 'sap.example',
        },
      },
    });
    const createRes = makeResponse();

    state.handler(createReq as never, createRes as never);
    await settle();

    expect(createRes.statusCode).toBe(200);
    const created = JSON.parse(createRes.body);
    const sessionId = String(created.session?.sessionId || '');
    expect(sessionId).toBeTruthy();

    const resumeReq = makeRequest({
      method: 'POST',
      url: '/api/interactive-escalations/resume',
      body: {
        sessionId,
        response: {
          kind: 'code',
          value: '123 456',
        },
      },
    });
    const resumeRes = makeResponse();

    state.handler(resumeReq as never, resumeRes as never);
    await settle();

    expect(resumeRes.statusCode).toBe(200);
    expect(JSON.parse(resumeRes.body)).toMatchObject({
      response: {
        kind: 'code',
        value: '123456',
      },
      session: {
        sessionId,
        status: 'resumed',
        response: {
          kind: 'code',
          valueRedacted: true,
        },
      },
    });

    const consumeReq = makeRequest({
      method: 'POST',
      url: '/api/interactive-escalations/consume',
      body: { sessionId },
    });
    const consumeRes = makeResponse();

    state.handler(consumeReq as never, consumeRes as never);
    await settle();

    expect(consumeRes.statusCode).toBe(200);
    expect(JSON.parse(consumeRes.body)).toEqual({
      response: {
        kind: 'code',
        value: '123456',
      },
    });
  });

  test('parses SMS interactive escalation replies by operator identity', async () => {
    const state = await importFreshHealth();
    const createReq = makeRequest({
      method: 'POST',
      url: '/api/interactive-escalations',
      body: {
        prompt: 'Enter the SMS verification code.',
        userId: 'operator-1',
        modality: 'sms',
        frameSnapshot: {
          url: 'https://sap.example/login',
        },
      },
    });
    const createRes = makeResponse();

    state.handler(createReq as never, createRes as never);
    await settle();

    expect(createRes.statusCode).toBe(200);
    const sessionId = String(
      JSON.parse(createRes.body).session?.sessionId || '',
    );
    expect(sessionId).toBeTruthy();

    const smsReq = makeRequest({
      method: 'POST',
      url: '/api/interactive-escalations/sms-reply',
      body: {
        from: 'operator-1',
        body: '123 456',
      },
    });
    const smsRes = makeResponse();

    state.handler(smsReq as never, smsRes as never);
    await settle();

    expect(smsRes.statusCode).toBe(200);
    expect(JSON.parse(smsRes.body)).toMatchObject({
      response: {
        kind: 'code',
        value: '123456',
      },
      session: {
        sessionId,
        status: 'resumed',
        response: {
          kind: 'code',
          valueRedacted: true,
        },
      },
    });
  });

  test('saves admin policy rules for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/policy',
      body: {
        agentId: 'writer',
        rule: {
          action: 'deny',
          host: 'bad.example',
          port: '*',
          methods: ['GET', 'POST'],
          paths: ['/admin/**'],
          agent: 'writer',
          comment: 'Blocked',
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.saveGatewayAdminPolicyRule).toHaveBeenCalledWith({
      agentId: 'writer',
      rule: {
        action: 'deny',
        host: 'bad.example',
        port: '*',
        methods: ['GET', 'POST'],
        paths: ['/admin/**'],
        agent: 'writer',
        comment: 'Blocked',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      workspacePath: '/tmp/writer/workspace',
      rules: [
        {
          action: 'deny',
          host: 'bad.example',
          port: '*',
        },
      ],
    });
  });

  test('saves the admin policy default for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/policy',
      body: {
        agentId: 'writer',
        defaultAction: 'allow',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.saveGatewayAdminPolicyDefault).toHaveBeenCalledWith({
      agentId: 'writer',
      defaultAction: 'allow',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      workspacePath: '/tmp/writer/workspace',
      defaultAction: 'allow',
    });
  });

  test('saves the admin LAN HTTP policy mode for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/policy',
      body: {
        agentId: 'writer',
        lanHttpAccessMode: 'read-write',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.saveGatewayAdminPolicyLanHttpAccess).toHaveBeenCalledWith({
      agentId: 'writer',
      mode: 'read-write',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      workspacePath: '/tmp/writer/workspace',
      lanHttpAccess: {
        mode: 'read-write',
      },
    });
  });

  test('applies admin policy templates for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'PUT',
      url: '/api/admin/policy',
      body: {
        agentId: 'writer',
        presetName: 'npm',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.applyGatewayAdminPolicyPreset).toHaveBeenCalledWith({
      agentId: 'writer',
      presetName: 'npm',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      workspacePath: '/tmp/writer/workspace',
      presets: ['npm'],
      rules: [
        {
          host: 'registry.npmjs.org',
          managedByPreset: 'npm',
        },
      ],
    });
  });

  test('deletes admin policy rules by index for authorized API requests', async () => {
    const state = await importFreshHealth();
    const req = makeRequest({
      method: 'DELETE',
      url: '/api/admin/policy?agentId=writer&index=2',
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.deleteGatewayAdminPolicyRule).toHaveBeenCalledWith({
      agentId: 'writer',
      index: 2,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      workspacePath: '/tmp/writer/workspace',
      rules: [],
    });
  });

  test('downloads and deletes admin distill corpus documents', async () => {
    const dataDir = makeTempDataDir();
    const subjectDir = path.join(
      dataDir,
      'agents',
      'maya',
      'workspace',
      'distill',
      'maya',
    );
    const corpusPath = path.join(subjectDir, 'corpus', 'documents.jsonl');
    fs.mkdirSync(path.dirname(corpusPath), { recursive: true });
    fs.writeFileSync(
      path.join(subjectDir, 'subject.json'),
      `${JSON.stringify({
        version: 1,
        alias: 'maya',
        displayName: 'Maya Lindqvist',
        realPerson: false,
        personalityTags: [],
        matchAliases: ['maya@example.com'],
        createdAt: '2026-06-10T10:00:00.000Z',
      })}\n`,
      'utf-8',
    );
    fs.writeFileSync(
      corpusPath,
      `${JSON.stringify({
        id: 'doc_abc123abc123',
        subject: 'maya',
        source: 'markdown',
        origin: '/uploads/memo.md',
        author: 'Maya Lindqvist',
        authoredBySubject: true,
        content: '# Memo\n\nBoring options win.',
        wordCount: 4,
        weight: 0.9,
        holdout: false,
        maskedThirdParties: 0,
        ingestedAt: '2026-06-10T10:02:00.000Z',
        runId: 'dst_1',
      })}\n`,
      'utf-8',
    );

    const state = await importFreshHealth({ dataDir });
    const downloadReq = makeRequest({
      url: '/api/admin/distill/corpus/doc_abc123abc123?alias=maya',
    });
    const downloadRes = makeResponse();

    state.handler(downloadReq as never, downloadRes as never);
    await waitForResponse(downloadRes, (next) => next.writableEnded);

    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.headers['Content-Type']).toBe(
      'text/plain; charset=utf-8',
    );
    expect(downloadRes.headers['Content-Disposition']).toContain(
      'attachment; filename="doc_abc123abc123-markdown.txt"',
    );
    expect(downloadRes.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(downloadRes.body).toContain('Boring options win');

    const deleteReq = makeRequest({
      method: 'DELETE',
      url: '/api/admin/distill/corpus/doc_abc123abc123?alias=maya',
    });
    const deleteRes = makeResponse();

    state.handler(deleteReq as never, deleteRes as never);
    await waitForResponse(deleteRes, (next) => next.writableEnded);

    expect(deleteRes.statusCode).toBe(200);
    expect(JSON.parse(deleteRes.body).subject).toMatchObject({
      alias: 'maya',
      corpusDocuments: 0,
      corpus: [],
    });
    expect(fs.readFileSync(corpusPath, 'utf-8')).toBe('');
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

  test('routes admin skill package file list, read, and save requests', async () => {
    const state = await importFreshHealth();

    const listReq = makeRequest({ url: '/api/admin/skills/pdf/files' });
    const listRes = makeResponse();
    state.handler(listReq as never, listRes as never);
    await settle();

    expect(state.getGatewayAdminSkillPackageFiles).toHaveBeenCalledWith('pdf');
    expect(listRes.statusCode).toBe(200);
    expect(JSON.parse(listRes.body)).toEqual(
      expect.objectContaining({
        skillName: 'pdf',
        rootPath: '/skills/pdf',
      }),
    );

    const readReq = makeRequest({
      url: '/api/admin/skills/pdf/files/content?path=SKILL.md',
    });
    const readRes = makeResponse();
    state.handler(readReq as never, readRes as never);
    await settle();

    expect(state.getGatewayAdminSkillPackageFile).toHaveBeenCalledWith({
      skillName: 'pdf',
      path: 'SKILL.md',
    });
    expect(readRes.statusCode).toBe(200);
    expect(JSON.parse(readRes.body).file.content).toBe('# PDF\n');

    const saveReq = makeRequest({
      method: 'PUT',
      url: '/api/admin/skills/pdf/files/content?path=SKILL.md',
      body: { content: '# Updated\n' },
    });
    const saveRes = makeResponse();
    state.handler(saveReq as never, saveRes as never);
    await settle();

    expect(state.saveGatewayAdminSkillPackageFile).toHaveBeenCalledWith({
      skillName: 'pdf',
      path: 'SKILL.md',
      content: '# Updated\n',
    });
    expect(saveRes.statusCode).toBe(200);
    expect(JSON.parse(saveRes.body).file.content).toBe('# Updated\n');
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

    expect(state.uploadGatewayAdminSkillZip).toHaveBeenCalledWith(zipBuffer, {
      force: false,
    });
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

  test('rejects query-token auth for SSE admin events', async () => {
    const state = await importFreshHealth({
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: '/api/events?token=web-token',
      noAuth: true,
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

  test('allows signed session cookie auth for SSE admin events', async () => {
    const authSecret = 'sse-session-auth-secret';
    const state = await importFreshHealth({
      authSecret,
      webApiToken: 'web-token',
    });
    const req = makeRequest({
      url: '/api/events',
      noAuth: true,
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sessionId: 'admin-session-1',
          actor: 'admin-user',
          role: 'admin.viewer',
        }),
      },
      remoteAddress: '203.0.113.10',
      noAuth: true,
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: overview');
  });

  test('allows cookie-authenticated SSE admin events', async () => {
    const state = await importFreshHealth();
    const cookie = issueLocalWebSessionCookie(state);
    const req = makeRequest({
      url: '/api/events',
      headers: { cookie, host: 'localhost:9090' },
      noAuth: true,
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

  test('blocks shell secret set commands from /api/chat before the model sees them', async () => {
    const state = await importFreshHealth();
    const leakedValue = 'very-secret-password';
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: {
        sessionId: 'session-secret-cli-guard',
        channelId: 'web',
        userId: 'user-web',
        username: 'web',
        content: `hybridclaw secret set BLINK_PASSWORD "${leakedValue}"`,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(state.handleGatewayCommand).not.toHaveBeenCalled();
    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      status: 'success',
      messageRole: 'command',
      sessionId: 'session-secret-cli-guard',
    });
    expect(body.result).toContain('did not run or send');
    expect(body.result).toContain('/secret set BLINK_PASSWORD <value>');
    expect(body.result).toContain(
      'hybridclaw secret set BLINK_PASSWORD <value>',
    );
    expect(body.result).not.toContain(leakedValue);
  });

  test('uses the signed session subject for web chat requests', async () => {
    const authSecret = 'health-secret';
    const state = await importFreshHealth({ authSecret });
    state.handleGatewayCommand.mockResolvedValueOnce({
      kind: 'info',
      title: 'Runtime Status',
      text: 'All systems nominal.',
      sessionId: 'session-web-slash',
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sub: 'user-1',
        }),
        host: '127.0.0.1:9090',
        origin: 'https://u-example.sbx.hybridai.one',
        'sec-fetch-site': 'same-origin',
      },
      noAuth: true,
      remoteAddress: '203.0.113.10',
      body: {
        sessionId: 'session-web-slash',
        channelId: 'web',
        userId: 'other-user',
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
        userId: 'user-1',
      }),
    );
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
    // Plugin command inclusion is verified by the query-based test below;
    // with an empty query the ranked result is capped at MAX_RESULTS, so a
    // specific plugin entry may be truncated as the built-in catalog grows.
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

  test('persists streamed assistant drafts before tool calls in activity traces', async () => {
    const state = await importFreshHealth();
    state.handleGatewayMessage.mockImplementationOnce(
      async (request: {
        sessionId: string;
        onTextDelta?: (delta: string) => void;
        onToolProgress?: (event: {
          toolName: string;
          phase: 'start' | 'finish';
          preview?: string;
          durationMs?: number;
        }) => void;
      }) => {
        request.onTextDelta?.('I need a location first.');
        request.onToolProgress?.({
          toolName: 'message',
          phase: 'start',
          preview: 'run message send',
        });
        request.onToolProgress?.({
          toolName: 'message',
          phase: 'finish',
          preview: 'ok',
          durationMs: 200,
        });
        request.onTextDelta?.('Final answer.');
        return {
          status: 'success' as const,
          result: 'Final answer.',
          sessionId: request.sessionId,
          toolsUsed: ['message'],
          toolExecutions: [],
          assistantMessageId: 42,
          artifacts: [],
        };
      },
    );
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: {
        sessionId: 'session-draft-trace',
        channelId: 'web',
        userId: 'user-web',
        username: 'web',
        content: 'send a forecast',
        stream: true,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    const events = res.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual([
      'text',
      'tool',
      'tool',
      'text',
      'result',
    ]);
    expect(state.setMessageActivityTrace).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        steps: [
          { kind: 'draft', text: 'I need a location first.' },
          {
            kind: 'tool',
            toolName: 'message',
            status: 'done',
            argsPreview: 'run message send',
            resultPreview: 'ok',
            durationMs: 200,
          },
        ],
      }),
    );
  });

  test('blocks shell secret set commands from streaming /api/chat before the model sees them', async () => {
    const state = await importFreshHealth();
    const leakedValue = 'stream-secret-token';
    const req = makeRequest({
      method: 'POST',
      url: '/api/chat',
      body: {
        sessionId: 'session-secret-cli-guard-stream',
        channelId: 'web',
        userId: 'user-web',
        username: 'web',
        content: `/usr/local/bin/hybridclaw secret set API_TOKEN ${leakedValue}`,
        stream: true,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.handleGatewayCommand).not.toHaveBeenCalled();
    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
    const events = res.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      {
        type: 'result',
        result: expect.objectContaining({
          status: 'success',
          messageRole: 'command',
          sessionId: 'session-secret-cli-guard-stream',
          result: expect.stringContaining('/secret set API_TOKEN <value>'),
        }),
      },
    ]);
    expect(events[0].result.result).not.toContain(leakedValue);
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

    // No visible output -> empty result (the web console renders no bubble for
    // it) rather than a "Done." placeholder. Success is still signalled by
    // status, and messageRole still marks it as command output.
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'success',
      result: '',
      messageRole: 'command',
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
      messageRole: 'command',
      result: '**Pending Approval**\nI need approval before continuing.',
      sessionId: 'session-web-approve',
    });

    await pendingApprovals.clearPendingApproval('session-web-approve');
  });

  test('rejects /approve always from the web chat path', async () => {
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
    expect(state.handleGatewayMessage).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'success',
      messageRole: 'command',
      result: expect.stringContaining('/approve'),
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
          messageRole: 'approval',
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

  test('does not mark /approve yes assistant output as command output on the web chat stream path', async () => {
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
      result: 'Onboarding complete — BOOTSTRAP.md deleted.',
      sessionId: 'session-web-approve',
      toolsUsed: ['delete', 'read'],
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
          messageRole: 'assistant',
          result:
            'Onboarding complete — BOOTSTRAP.md deleted.\n*Tools: delete, read*',
          sessionId: 'session-web-approve',
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
    await waitForResponse(res, (response) => response.statusCode !== 0);

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
    await waitForResponse(res, (response) => response.statusCode !== 0);

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
    await waitForResponse(res, (response) => response.statusCode !== 0);

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

  test('uses the signed session subject for /api/command web requests', async () => {
    const authSecret = 'health-secret';
    const state = await importFreshHealth({ authSecret });
    state.handleGatewayCommand.mockResolvedValueOnce({
      kind: 'plain',
      text: 'ok',
      sessionId: 'session-web-command',
    });
    const req = makeRequest({
      method: 'POST',
      url: '/api/command',
      headers: {
        cookie: makeSessionCookie(authSecret, {
          sub: 'user-1',
        }),
        host: '127.0.0.1:9090',
        origin: 'https://u-example.sbx.hybridai.one',
        'sec-fetch-site': 'same-origin',
      },
      noAuth: true,
      remoteAddress: '203.0.113.10',
      body: {
        sessionId: 'session-web-command',
        channelId: 'web',
        userId: 'other-user',
        username: 'web',
        args: ['help'],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(state.handleGatewayCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-web-command',
        channelId: 'web',
        args: ['help'],
        userId: 'user-1',
      }),
    );
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
      key: 'gateway-token',
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

  test('restricts cleartext secret injection endpoint to gateway token auth', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-secret-inject-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    const { saveNamedRuntimeSecrets } = await import(
      '../src/security/runtime-secrets.ts'
    );
    saveNamedRuntimeSecrets({
      DATEV_PASSWORD: 'datev-cleartext-secret',
    });

    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      webApiToken: 'web-token',
      gatewayApiToken: 'gateway-token',
    });
    const webReq = makeRequest({
      method: 'POST',
      url: '/api/secret/inject',
      headers: { authorization: 'Bearer web-token' },
      body: {
        secretName: 'DATEV_PASSWORD',
        sinkKind: 'dom',
        host: 'login.datev.de',
        selector: '#password',
      },
    });
    const webRes = makeResponse();

    state.handler(webReq as never, webRes as never);
    await settle();

    expect(webRes.statusCode).toBe(401);
    expect(JSON.parse(webRes.body)).toEqual({
      error: 'Unauthorized. Set `Authorization: Bearer <GATEWAY_API_TOKEN>`.',
    });

    const gatewayReq = makeRequest({
      method: 'POST',
      url: '/api/secret/inject',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        secretName: 'DATEV_PASSWORD',
        sinkKind: 'dom',
        host: 'login.datev.de',
        selector: '#password',
      },
    });
    const gatewayRes = makeResponse();

    state.handler(gatewayReq as never, gatewayRes as never);
    await settle();

    expect(gatewayRes.statusCode).toBe(200);
    expect(gatewayRes.headers['Cache-Control']).toBe('no-store');
    expect(gatewayRes.headers.Pragma).toBe('no-cache');
    expect(JSON.parse(gatewayRes.body)).toEqual({
      ok: true,
      secretName: 'DATEV_PASSWORD',
      value: 'datev-cleartext-secret',
    });
  });

  test('dispatches gateway-owned http requests with URL auth rules and secret placeholders', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir, (config) => {
      const tools = config.tools as Record<string, unknown>;
      tools.httpRequest = {
        authRules: [
          {
            urlPrefix: 'https://hybridai.one/v1/completions/',
            header: 'Authorization',
            prefix: 'Bearer',
            secret: { source: 'store', id: 'HYBRIDAI_API_KEY' },
          },
        ],
      };
    });
    writeAllowAllSecretPolicy(homeDir);

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
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
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

  test('dispatches gateway-owned http requests with env store placeholders', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-env-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);

    const { saveNamedRuntimeEnv } = await import(
      '../src/config/runtime-env.ts'
    );
    saveNamedRuntimeEnv({
      HUE_BRIDGE_HOST: 'https://bridge.example.com',
    });

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://bridge.example.com/clip/v2/resource/light',
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: async () =>
        Buffer.from(JSON.stringify({ data: [{ id: 'light-1' }] })),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: '<env:HUE_BRIDGE_HOST>/clip/v2/resource/light',
        method: 'GET',
        headers: {
          'X-Bridge-Origin': '<env:HUE_BRIDGE_HOST>',
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'X-Bridge-Origin': 'https://bridge.example.com',
        }),
      }),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://bridge.example.com/clip/v2/resource/light',
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).json).toEqual({
      data: [{ id: 'light-1' }],
    });

    const missingReq = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: '<env:MISSING_BRIDGE_HOST>/clip/v2/resource/light',
        method: 'GET',
      },
    });
    const missingRes = makeResponse();

    state.handler(missingReq as never, missingRes as never);
    await settle();

    expect(missingRes.statusCode).toBe(400);
    expect(JSON.parse(missingRes.body)).toEqual({
      error: 'Env store value MISSING_BRIDGE_HOST is not configured.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('allows Google OAuth runtime token placeholders for googleapis http requests', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-google-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);

    vi.doMock('../src/auth/google-auth.js', () => ({
      resolveGoogleWorkspaceRuntimeEnv: vi.fn(async () => ({
        GOOGLE_WORKSPACE_CLI_TOKEN: 'minted-google-access-token',
        GOG_ACCESS_TOKEN: 'minted-google-access-token',
        GOG_ACCOUNT: 'user@example.com',
      })),
    }));
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '142.250.185.234', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://analyticsdata.googleapis.com/v1beta/properties/123:runReport',
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: async () =>
        Buffer.from(JSON.stringify({ rows: [], rowCount: 0 })),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://analyticsdata.googleapis.com/v1beta/properties/123:runReport',
        method: 'POST',
        headers: {
          Authorization: 'Bearer <secret:GOOGLE_WORKSPACE_CLI_TOKEN>',
        },
        json: {
          dateRanges: [{ startDate: '30daysAgo', endDate: 'yesterday' }],
          metrics: [{ name: 'activeUsers' }],
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer minted-google-access-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).json).toEqual({ rows: [], rowCount: 0 });
  });

  test('allows Google OAuth runtime tokens through URL auth routes', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-google-route-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir, (config) => {
      const tools = config.tools as Record<string, unknown>;
      tools.httpRequest = {
        authRules: [
          {
            urlPrefix: 'https://analyticsdata.googleapis.com/',
            header: 'Authorization',
            prefix: 'Bearer',
            secret: { source: 'google-oauth' },
          },
        ],
      };
    });

    vi.doMock('../src/auth/google-auth.js', () => ({
      resolveGoogleWorkspaceRuntimeEnv: vi.fn(async () => ({
        GOOGLE_WORKSPACE_CLI_TOKEN: 'minted-google-access-token',
        GOG_ACCESS_TOKEN: 'minted-google-access-token',
        GOG_ACCOUNT: 'user@example.com',
      })),
    }));
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '142.250.185.234', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://analyticsdata.googleapis.com/v1beta/properties/123:runReport',
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: async () =>
        Buffer.from(JSON.stringify({ rows: [], rowCount: 0 })),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://analyticsdata.googleapis.com/v1beta/properties/123:runReport',
        method: 'POST',
        json: {
          dateRanges: [{ startDate: '30daysAgo', endDate: 'yesterday' }],
          metrics: [{ name: 'activeUsers' }],
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer minted-google-access-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).json).toEqual({ rows: [], rowCount: 0 });
  });

  test('does not substitute a different Google OAuth runtime token name', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-google-exact-token-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);

    const resolveGoogleWorkspaceRuntimeEnv = vi.fn(async () => ({
      GOOGLE_WORKSPACE_CLI_TOKEN: 'minted-google-access-token',
    }));
    vi.doMock('../src/auth/google-auth.js', () => ({
      resolveGoogleWorkspaceRuntimeEnv,
    }));
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '142.250.185.234', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://analyticsdata.googleapis.com/v1beta/properties/123:runReport',
        headers: {
          Authorization: 'Bearer <secret:GOG_ACCESS_TOKEN>',
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain(
      'GOG_ACCESS_TOKEN is not available',
    );
    expect(resolveGoogleWorkspaceRuntimeEnv).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('blocks Google OAuth runtime token placeholders for non-Google hosts', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-google-block-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);

    vi.doMock('../src/auth/google-auth.js', () => ({
      resolveGoogleWorkspaceRuntimeEnv: vi.fn(async () => ({
        GOOGLE_WORKSPACE_CLI_TOKEN: 'minted-google-access-token',
      })),
    }));
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://example.com/steal',
        headers: {
          Authorization: 'Bearer <secret:GOG_ACCESS_TOKEN>',
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain(
      'GOG_ACCESS_TOKEN can only be injected into googleapis.com requests',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('injects HubSpot OAuth runtime bearer tokens for HubSpot API hosts', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-hubspot-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);

    vi.doMock('../src/auth/hubspot-auth.js', () => ({
      HUBSPOT_ACCESS_TOKEN_SECRET: 'HUBSPOT_ACCESS_TOKEN',
      resolveHubSpotAccessToken: vi.fn(async () => ({
        accessToken: 'minted-hubspot-access-token',
        source: 'hubspot-oauth',
      })),
    }));
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '199.60.103.31', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://api.hubapi.com/crm/v3/objects/deals',
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: async () =>
        Buffer.from(JSON.stringify({ results: [], paging: undefined })),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://api.hubapi.com/crm/v3/objects/deals',
        bearerSecretName: 'HUBSPOT_ACCESS_TOKEN',
        sessionId: 'hubspot-audit',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer minted-hubspot-access-token',
        }),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).json).toEqual({ results: [] });
    const { getAuditWirePath } = await import('../src/audit/audit-trail.ts');
    const auditRecords = fs
      .readFileSync(getAuditWirePath('hubspot-audit'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(auditRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'secret.resolved',
            secretRef: {
              source: 'hubspot-oauth',
              id: 'HUBSPOT_ACCESS_TOKEN',
            },
          }),
        }),
      ]),
    );
  });

  test('injects stored HubSpot private app tokens for HubSpot API hosts', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-hubspot-private-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);

    vi.doMock('../src/auth/hubspot-auth.js', () => ({
      HUBSPOT_ACCESS_TOKEN_SECRET: 'HUBSPOT_ACCESS_TOKEN',
      resolveHubSpotAccessToken: vi.fn(async () => ({
        accessToken: 'private-app-access-token',
        source: 'store',
      })),
    }));
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '199.60.103.31', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://api.hubapi.com/crm/v3/objects/contacts',
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: async () =>
        Buffer.from(JSON.stringify({ results: [], paging: undefined })),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://api.hubapi.com/crm/v3/objects/contacts',
        bearerSecretName: 'HUBSPOT_ACCESS_TOKEN',
        sessionId: 'hubspot-private-audit',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer private-app-access-token',
        }),
      }),
    );
    expect(res.statusCode).toBe(200);
    const { getAuditWirePath } = await import('../src/audit/audit-trail.ts');
    const auditRecords = fs
      .readFileSync(getAuditWirePath('hubspot-private-audit'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(auditRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'secret.resolved',
            secretRef: {
              source: 'store',
              id: 'HUBSPOT_ACCESS_TOKEN',
            },
          }),
        }),
      ]),
    );
  });

  test('blocks HubSpot OAuth runtime bearer tokens for non-HubSpot hosts', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-hubspot-block-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);

    vi.doMock('../src/auth/hubspot-auth.js', () => ({
      HUBSPOT_ACCESS_TOKEN_SECRET: 'HUBSPOT_ACCESS_TOKEN',
      resolveHubSpotAccessToken: vi.fn(async () => ({
        accessToken: 'minted-hubspot-access-token',
        source: 'hubspot-oauth',
      })),
    }));
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://example.com/steal',
        bearerSecretName: 'HUBSPOT_ACCESS_TOKEN',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain(
      'HUBSPOT_ACCESS_TOKEN can only be injected into HubSpot API requests',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('injects Microsoft 365 OAuth runtime bearer tokens for Graph hosts', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-microsoft-365-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);

    vi.doMock('../src/auth/microsoft-auth.js', () => ({
      MICROSOFT_365_ACCESS_TOKEN_SECRET: 'MICROSOFT_365_ACCESS_TOKEN',
      resolveMicrosoft365AccessToken: vi.fn(async () => ({
        accessToken: 'minted-microsoft-access-token',
        source: 'microsoft-oauth',
      })),
    }));
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '20.190.151.1', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://graph.microsoft.com/v1.0/me',
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: async () =>
        Buffer.from(JSON.stringify({ id: 'user-id', displayName: 'User' })),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://graph.microsoft.com/v1.0/me',
        bearerSecretName: 'MICROSOFT_365_ACCESS_TOKEN',
        sessionId: 'microsoft-365-audit',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer minted-microsoft-access-token',
        }),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).json).toEqual({
      id: 'user-id',
      displayName: 'User',
    });
    const { getAuditWirePath } = await import('../src/audit/audit-trail.ts');
    const auditRecords = fs
      .readFileSync(getAuditWirePath('microsoft-365-audit'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(auditRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'secret.resolved',
            secretRef: {
              source: 'microsoft-oauth',
              id: 'MICROSOFT_365_ACCESS_TOKEN',
            },
          }),
        }),
      ]),
    );
  });

  test('blocks Microsoft 365 OAuth runtime bearer tokens for non-Graph hosts', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-microsoft-365-block-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);

    vi.doMock('../src/auth/microsoft-auth.js', () => ({
      MICROSOFT_365_ACCESS_TOKEN_SECRET: 'MICROSOFT_365_ACCESS_TOKEN',
      resolveMicrosoft365AccessToken: vi.fn(async () => ({
        accessToken: 'minted-microsoft-access-token',
        source: 'microsoft-oauth',
      })),
    }));
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://example.com/steal',
        bearerSecretName: 'MICROSOFT_365_ACCESS_TOKEN',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain(
      'MICROSOFT_365_ACCESS_TOKEN can only be injected into Microsoft Graph requests',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('exchanges Google service-account JWTs and injects short-lived bearer tokens', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-google-sa-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const { saveNamedRuntimeSecrets } = await import(
      '../src/security/runtime-secrets.ts'
    );
    saveNamedRuntimeSecrets({
      GA4_SERVICE_ACCOUNT_EMAIL: 'ga4-sa@example.iam.gserviceaccount.com',
      GA4_SERVICE_ACCOUNT_PRIVATE_KEY: privateKeyPem,
    });

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '142.250.185.234', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'service-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ rows: [], rowCount: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://analyticsdata.googleapis.com/v1beta/properties/123:runReport',
        method: 'POST',
        googleServiceAccount: {
          clientEmailSecretName: 'GA4_SERVICE_ACCOUNT_EMAIL',
          privateKeySecretName: 'GA4_SERVICE_ACCOUNT_PRIVATE_KEY',
          scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
        },
        json: {
          dateRanges: [{ startDate: '30daysAgo', endDate: 'yesterday' }],
          metrics: [{ name: 'activeUsers' }],
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://oauth2.googleapis.com/token',
    );
    const tokenBody = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(tokenBody.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
    const assertion = tokenBody.get('assertion') || '';
    const assertionPayload = JSON.parse(
      Buffer.from(assertion.split('.')[1] || '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(assertionPayload).toMatchObject({
      iss: 'ga4-sa@example.iam.gserviceaccount.com',
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer service-token',
        }),
      }),
    );
    expect(JSON.parse(res.body).json).toEqual({ rows: [], rowCount: 0 });
  });

  test('URL-encodes resolved secret values in outbound http_request form bodies', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-form-secrets-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    const { saveNamedRuntimeSecrets } = await import(
      '../src/security/runtime-secrets.ts'
    );
    saveNamedRuntimeSecrets({
      FORM_CLIENT_ID: 'client+id',
      FORM_REFRESH_TOKEN: 'refresh+token&with=syntax',
    });

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://api.example.com/token',
        method: 'POST',
        form: {
          grant_type: 'refresh_token',
          client_id: '<secret:FORM_CLIENT_ID>',
          refresh_token: '<secret:FORM_REFRESH_TOKEN>',
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: 'client+id',
          refresh_token: 'refresh+token&with=syntax',
        }).toString(),
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      }),
    );
  });

  test('blocks Google service-account auth for non-Google API hosts', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-google-sa-block-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://example.com/steal',
        googleServiceAccount: {
          clientEmailSecretName: 'GA4_SERVICE_ACCOUNT_EMAIL',
          privateKeySecretName: 'GA4_SERVICE_ACCOUNT_PRIVATE_KEY',
          scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain(
      'Google service-account auth can only be used for googleapis.com requests',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('binds captured OAuth bearer tokens to response instance_url host', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-oauth-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    const { readStoredRuntimeSecret, saveNamedRuntimeSecrets } = await import(
      '../src/security/runtime-secrets.ts'
    );
    saveNamedRuntimeSecrets({
      SF_DOMAIN: 'login',
      SF_FULL_CLIENTID: 'client-id',
      SF_FULL_SECRET: 'client-secret',
      SF_FULL_USERNAME: 'user@example.com',
      SF_FULL_PASSWORD: 'password-plus-token',
    });

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'salesforce-access-token',
            bearer: 'salesforce-bearer-token',
            instance_url: 'https://acme.my.salesforce.com',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ totalSize: 0, done: true, records: [] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const authReq = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://<secret:SF_DOMAIN>.salesforce.com/services/oauth2/token',
        method: 'POST',
        body: 'grant_type=password&client_id=<secret:SF_FULL_CLIENTID>&client_secret=<secret:SF_FULL_SECRET>&username=<secret:SF_FULL_USERNAME>&password=<secret:SF_FULL_PASSWORD>',
        captureResponseFields: [
          { jsonPath: 'access_token', secretName: 'SF_ACCESS_TOKEN' },
          { jsonPath: 'bearer', secretName: 'SF_BEARER' },
          { jsonPath: 'instance_url', secretName: 'SF_INSTANCE_URL' },
        ],
      },
    });
    const authRes = makeResponse();

    state.handler(authReq as never, authRes as never);
    await settle();

    expect(authRes.statusCode).toBe(200);
    expect(JSON.parse(authRes.body)).toEqual({
      ok: true,
      status: 200,
      captured: {
        access_token: 'SF_ACCESS_TOKEN',
        bearer: 'SF_BEARER',
        instance_url: 'SF_INSTANCE_URL',
      },
    });
    expect(readStoredRuntimeSecret('SF_ACCESS_TOKEN_BOUND_DOMAIN')).toBe(
      'acme.my.salesforce.com',
    );
    expect(readStoredRuntimeSecret('SF_BEARER_BOUND_DOMAIN')).toBe(
      'acme.my.salesforce.com',
    );
    expect(readStoredRuntimeSecret('SF_INSTANCE_URL_BOUND_DOMAIN')).toBeNull();

    const apiReq = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://acme.my.salesforce.com/services/data/v61.0/query?q=SELECT+Id+FROM+Opportunity+LIMIT+1',
        bearerSecretName: 'SF_ACCESS_TOKEN',
      },
    });
    const apiRes = makeResponse();

    state.handler(apiReq as never, apiRes as never);
    await settle();

    expect(apiRes.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer salesforce-access-token',
        }),
      }),
    );

    const blockedReq = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://evil.example.com/steal',
        bearerSecretName: 'SF_ACCESS_TOKEN',
      },
    });
    const blockedRes = makeResponse();

    state.handler(blockedReq as never, blockedRes as never);
    await settle();

    expect(blockedRes.statusCode).toBe(403);
    expect(JSON.parse(blockedRes.body).error).toContain(
      'request to evil.example.com is blocked',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('allows unbound bearerSecretName during deprecation window with a warning', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-unbound-bearer-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    const { saveNamedRuntimeSecrets } = await import(
      '../src/security/runtime-secrets.ts'
    );
    saveNamedRuntimeSecrets({
      EXTERNAL_ACCESS_TOKEN: 'external-access-token',
    });

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://api.example.com/v1/items',
        bearerSecretName: 'EXTERNAL_ACCESS_TOKEN',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer external-access-token',
        }),
      }),
    );
    expect(state.loggerWarn).toHaveBeenCalledWith(
      {
        secretName: 'EXTERNAL_ACCESS_TOKEN',
        targetHost: 'api.example.com',
        bindingKey: 'EXTERNAL_ACCESS_TOKEN_BOUND_DOMAIN',
      },
      expect.stringContaining('without a domain binding'),
    );
  });

  test('captures explicit bearer token fields without exposing the response body', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-token-capture-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    const { readStoredRuntimeSecret, saveNamedRuntimeSecrets } = await import(
      '../src/security/runtime-secrets.ts'
    );
    saveNamedRuntimeSecrets({
      HERMES3000_EMAIL: 'writer@example.com',
      HERMES3000_PASSWORD: 'password',
    });

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: 'hermes-jwt-token',
          user: { email: 'writer@example.com' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const authReq = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://hermes3000.ai/api/auth/login',
        method: 'POST',
        json: {
          email: '<secret:HERMES3000_EMAIL>',
          password: '<secret:HERMES3000_PASSWORD>',
        },
        captureResponseFields: [
          { jsonPath: 'token', secretName: 'HERMES3000_JWT' },
        ],
      },
    });
    const authRes = makeResponse();

    state.handler(authReq as never, authRes as never);
    await settle();

    expect(authRes.statusCode).toBe(200);
    expect(JSON.parse(authRes.body)).toEqual({
      ok: true,
      status: 200,
      captured: {
        token: 'HERMES3000_JWT',
      },
    });
    expect(authRes.body).not.toContain('hermes-jwt-token');
    expect(readStoredRuntimeSecret('HERMES3000_JWT')).toBe('hermes-jwt-token');
    expect(readStoredRuntimeSecret('HERMES3000_JWT_BOUND_DOMAIN')).toBe(
      'hermes3000.ai',
    );
  });

  test('url-encodes form fields after resolving secret placeholders', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-form-secret-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    const { saveNamedRuntimeSecrets } = await import(
      '../src/security/runtime-secrets.ts'
    );
    saveNamedRuntimeSecrets({
      FORM_PASSWORD: 'a&b+c=d%',
    });

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://example.com/login',
        method: 'POST',
        form: {
          username: 'user@example.com',
          password: '<secret:FORM_PASSWORD>',
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        body: 'username=user%40example.com&password=a%26b%2Bc%3Dd%25',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      }),
    );
  });

  test('validates pinned TLS certificate SHA-256 on the outbound http_request connection', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-tls-pin-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    const certRaw = Buffer.from('test bridge certificate');
    const fingerprint = createHash('sha256').update(certRaw).digest('hex');
    const order: string[] = [];
    const socket = {
      destroy: vi.fn(),
      getPeerCertificate: vi.fn(() => {
        order.push('pin');
        return { raw: certRaw };
      }),
    };
    const connectorMock = vi.fn((_options, callback) => {
      callback(null, socket);
    });
    const closeMock = vi.fn(async () => {
      order.push('close');
    });
    vi.doMock('undici', () => ({
      Agent: vi.fn().mockImplementation(function (options) {
        return {
          close: closeMock,
          connect: options.connect,
        };
      }),
      buildConnector: vi.fn(() => connectorMock),
    }));
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn(async (_url, options) => {
      await new Promise<void>((resolve, reject) => {
        options.dispatcher.connect(
          {
            hostname: 'bridge.example.com',
            port: '443',
            protocol: 'https:',
          },
          (error: Error | null) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          },
        );
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            order.push('body');
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify({ ok: true })),
            );
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://bridge.example.com/clip/v2/resource/light',
        tlsCertificateSha256: fingerprint,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(connectorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'bridge.example.com',
        port: '443',
        protocol: 'https:',
      }),
      expect.any(Function),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        dispatcher: expect.anything(),
      }),
    );
    expect(closeMock).toHaveBeenCalledOnce();
    expect(order).toEqual(['pin', 'body', 'close']);
  });

  test('allows explicitly self-signed TLS on the outbound http_request connection', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-self-signed-tls-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    const connectorMock = vi.fn((_options, callback) => {
      callback(null, {});
    });
    const closeMock = vi.fn(async () => undefined);
    const buildConnectorMock = vi.fn(() => connectorMock);
    vi.doMock('undici', () => ({
      Agent: vi.fn().mockImplementation(function (options) {
        return {
          close: closeMock,
          connect: options.connect,
        };
      }),
      buildConnector: buildConnectorMock,
    }));
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn(async (_url, options) => {
      await new Promise<void>((resolve, reject) => {
        options.dispatcher.connect(
          {
            hostname: 'bridge.example.com',
            port: '443',
            protocol: 'https:',
          },
          (error: Error | null) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          },
        );
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://bridge.example.com/clip/v2/resource/light',
        allowSelfSignedTls: true,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(buildConnectorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rejectUnauthorized: false,
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        dispatcher: expect.anything(),
      }),
    );
    expect(closeMock).toHaveBeenCalledOnce();
  });

  test('blocks pinned TLS fingerprint mismatches on the outbound http_request connection', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-tls-pin-mismatch-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    const socket = {
      destroy: vi.fn(),
      getPeerCertificate: vi.fn(() => ({ raw: Buffer.from('other cert') })),
    };
    const connectorMock = vi.fn((_options, callback) => {
      callback(null, socket);
    });
    const closeMock = vi.fn(async () => undefined);
    vi.doMock('undici', () => ({
      Agent: vi.fn().mockImplementation(function (options) {
        return {
          close: closeMock,
          connect: options.connect,
        };
      }),
      buildConnector: vi.fn(() => connectorMock),
    }));
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn(async (_url, options) => {
      await new Promise<void>((resolve, reject) => {
        options.dispatcher.connect(
          {
            hostname: 'bridge.example.com',
            port: '443',
            protocol: 'https:',
          },
          (error: Error | null) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          },
        );
      });
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://bridge.example.com/clip/v2/resource/light',
        tlsCertificateSha256:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toContain(
      'Pinned TLS certificate check failed',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(closeMock).toHaveBeenCalledOnce();
  });

  test('captures explicit token bindDomain for cross-host OAuth tokens', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-bind-domain-capture-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    const { readStoredRuntimeSecret } = await import(
      '../src/security/runtime-secrets.ts'
    );

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'blink-oauth-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://api.oauth.blink.com/oauth/token',
        method: 'POST',
        captureResponseFields: [
          {
            jsonPath: 'access_token',
            secretName: 'BLINK_AUTH_TOKEN',
            bindDomain: 'immedia-semi.com',
          },
        ],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      status: 200,
      captured: {
        access_token: 'BLINK_AUTH_TOKEN',
      },
    });
    expect(readStoredRuntimeSecret('BLINK_AUTH_TOKEN_BOUND_DOMAIN')).toBe(
      'immedia-semi.com',
    );
  });

  test('captures nested response fields without exposing the response body', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-nested-capture-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    const { readStoredRuntimeSecret } = await import(
      '../src/security/runtime-secrets.ts'
    );

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          auth: { token: 'blink-auth-token' },
          account: {
            tier: 'e003',
            account_id: 1234,
            client_id: 5678,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://rest-prod.immedia-semi.com/api/v5/account/login',
        method: 'POST',
        captureResponseFields: [
          { jsonPath: 'auth.token', secretName: 'BLINK_AUTH_TOKEN' },
          { jsonPath: 'account.tier', secretName: 'BLINK_TIER' },
          { jsonPath: 'account.account_id', secretName: 'BLINK_ACCOUNT_ID' },
          { jsonPath: 'account.client_id', secretName: 'BLINK_CLIENT_ID' },
        ],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      status: 200,
      captured: {
        'auth.token': 'BLINK_AUTH_TOKEN',
        'account.tier': 'BLINK_TIER',
        'account.account_id': 'BLINK_ACCOUNT_ID',
        'account.client_id': 'BLINK_CLIENT_ID',
      },
    });
    expect(res.body).not.toContain('blink-auth-token');
    expect(readStoredRuntimeSecret('BLINK_AUTH_TOKEN')).toBe(
      'blink-auth-token',
    );
    expect(readStoredRuntimeSecret('BLINK_TIER')).toBe('e003');
    expect(readStoredRuntimeSecret('BLINK_ACCOUNT_ID')).toBe('1234');
    expect(readStoredRuntimeSecret('BLINK_CLIENT_ID')).toBe('5678');
  });

  test('captures response headers without exposing response values', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-header-capture-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    const { readStoredRuntimeSecret, saveNamedRuntimeSecrets } = await import(
      '../src/security/runtime-secrets.ts'
    );
    saveNamedRuntimeSecrets({
      BLINK_AUTH_TOKEN: 'blink-auth-token',
      BLINK_AUTH_TOKEN_BOUND_DOMAIN: 'immedia-semi.com',
    });

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ tier: 'e003', account_id: 1234 }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'client-id': '5678',
          },
        }),
      ),
    );

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://rest-prod.immedia-semi.com/api/v1/users/tier_info',
        secretHeaders: [
          {
            name: 'Authorization',
            secretName: 'BLINK_AUTH_TOKEN',
            prefix: 'Bearer',
          },
        ],
        captureResponseFields: [
          { jsonPath: 'tier', secretName: 'BLINK_TIER' },
          { jsonPath: 'account_id', secretName: 'BLINK_ACCOUNT_ID' },
        ],
        captureResponseHeaders: [
          { header: 'client-id', secretName: 'BLINK_CLIENT_ID' },
        ],
        suppressResponseBody: true,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      status: 200,
      captured: {
        tier: 'BLINK_TIER',
        account_id: 'BLINK_ACCOUNT_ID',
        'headers.client-id': 'BLINK_CLIENT_ID',
      },
    });
    expect(res.body).not.toContain('5678');
    expect(readStoredRuntimeSecret('BLINK_TIER')).toBe('e003');
    expect(readStoredRuntimeSecret('BLINK_ACCOUNT_ID')).toBe('1234');
    expect(readStoredRuntimeSecret('BLINK_CLIENT_ID')).toBe('5678');
  });

  test('blocks secret header injection when the stored token binding does not match the target host', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-secret-header-binding-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    const { saveNamedRuntimeSecrets } = await import(
      '../src/security/runtime-secrets.ts'
    );
    saveNamedRuntimeSecrets({
      BLINK_AUTH_TOKEN: 'blink-auth-token',
      BLINK_AUTH_TOKEN_BOUND_DOMAIN: 'api.oauth.blink.com',
    });

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://rest-prod.immedia-semi.com/api/v1/users/tier_info',
        secretHeaders: [
          {
            name: 'Authorization',
            secretName: 'BLINK_AUTH_TOKEN',
            prefix: 'Bearer',
          },
        ],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({
      error: expect.stringContaining('BLINK_AUTH_TOKEN is bound to'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('suppresses outbound http_request response bodies for opaque results', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-suppress-body-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const cancelBody = vi.fn(async () => undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://rest-e003.immedia-semi.com/api/v5/accounts/1234/networks/111/cameras/222/liveview',
      headers: new Headers({
        'content-length': '2048',
        'content-type': 'application/json',
      }),
      body: {
        cancel: cancelBody,
      },
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://rest-e003.immedia-semi.com/api/v5/accounts/1234/networks/111/cameras/222/liveview',
        method: 'POST',
        suppressResponseBody: true,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      status: 200,
      bodySuppressed: true,
      bodyBytes: 2048,
    });
    expect(JSON.parse(res.body)).not.toHaveProperty('body');
    expect(res.body).not.toContain('media.example');
    expect(cancelBody).toHaveBeenCalledTimes(1);
  });

  test('rejects malformed captureResponseFields before making outbound request', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-token-capture-invalid-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://hermes3000.ai/api/auth/login',
        method: 'POST',
        captureResponseFields: 'token',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain(
      '`captureResponseFields` must be an array',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects reserved runtime config names in captureResponseFields', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-token-capture-reserved-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);
    writeAllowAllSecretPolicy(homeDir);

    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://hermes3000.ai/api/auth/login',
        method: 'POST',
        captureResponseFields: [{ jsonPath: 'token', secretName: 'DB_PATH' }],
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain(
      'Reserved runtime config name cannot be used in captureResponseFields',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('injects bearer SecretRefs for outbound http_request calls', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '104.21.30.182', family: 4 }]),
    }));
    const homeDir = makeTempDocsRoot('hybridclaw-http-secret-ref-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir, (config) => {
      const ops = config.ops as Record<string, unknown>;
      ops.gatewayApiToken = 'gateway-token';
    });
    writeAllowAllSecretPolicy(homeDir);
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const { saveNamedRuntimeSecrets } = await import(
      '../src/security/runtime-secrets.js'
    );
    saveNamedRuntimeSecrets({
      SEARXNG_BEARER_TOKEN: 'searxng-secret-token',
    });

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: 'Injected',
                url: 'https://example.com/injected',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://search.tenant.example/search?q=tenant&format=json',
        bearerSecretRef: {
          source: 'store',
          id: 'SEARXNG_BEARER_TOKEN',
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer searxng-secret-token',
        }),
      }),
    );
  });

  async function setupOtcGatewayRequestTest({
    dnsAddress,
    fetchMock,
  }: {
    dnsAddress: string;
    fetchMock: ReturnType<typeof vi.fn>;
  }) {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: dnsAddress, family: 4 }]),
    }));
    const homeDir = makeTempDocsRoot('hybridclaw-http-otc-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir, (config) => {
      const ops = config.ops as Record<string, unknown>;
      ops.gatewayApiToken = 'gateway-token';
    });
    writeAllowAllSecretPolicy(homeDir);
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const { saveNamedRuntimeSecrets } = await import(
      '../src/security/runtime-secrets.js'
    );
    saveNamedRuntimeSecrets({
      OTC_ACCESS_KEY_ID: 'ak-live-example-123',
      OTC_SECRET_ACCESS_KEY: 'sk-live-example-456',
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, state };
  }

  test('signs T Cloud Public http_request calls with gateway-held AK/SK secrets', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ servers: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { state } = await setupOtcGatewayRequestTest({
      dnsAddress: '80.158.59.140',
      fetchMock,
    });

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://ecs.eu-de.otc.t-systems.com/v2.1/project123/servers/detail?limit=50',
        method: 'GET',
        skillName: 't-cloud-public',
        otcAkSk: {
          accessKeyIdSecretName: 'OTC_ACCESS_KEY_ID',
          secretAccessKeySecretName: 'OTC_SECRET_ACCESS_KEY',
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(
            /^SDK-HMAC-SHA256 Access=ak-live-example-123, SignedHeaders=host;x-sdk-date, Signature=[a-f0-9]{64}$/,
          ),
          'X-Sdk-Date': expect.stringMatching(/^\d{8}T\d{6}Z$/),
        }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Record<string, string>;
    const sdkDate = headers['X-Sdk-Date'];
    const canonicalRequest = [
      'GET',
      '/v2.1/project123/servers/detail/',
      'limit=50',
      `host:ecs.eu-de.otc.t-systems.com\nx-sdk-date:${sdkDate}\n`,
      'host;x-sdk-date',
      createHash('sha256').update('').digest('hex'),
    ].join('\n');
    const stringToSign = [
      'SDK-HMAC-SHA256',
      sdkDate,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const expectedSignature = createHmac('sha256', 'sk-live-example-456')
      .update(stringToSign)
      .digest('hex');
    expect(headers.Authorization).toBe(
      `SDK-HMAC-SHA256 Access=ak-live-example-123, SignedHeaders=host;x-sdk-date, Signature=${expectedSignature}`,
    );
    expect(headers.Authorization).not.toContain('sk-live-example-456');
  });

  test('rejects placeholder T Cloud Public AK/SK secrets before signing', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '80.158.59.140', family: 4 }]),
    }));
    const homeDir = makeTempDocsRoot('hybridclaw-http-otc-placeholder-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir, (config) => {
      const ops = config.ops as Record<string, unknown>;
      ops.gatewayApiToken = 'gateway-token';
    });
    writeAllowAllSecretPolicy(homeDir);
    const state = await importFreshHealth({
      dataDir: path.join(homeDir, '.hybridclaw', 'data'),
      gatewayApiToken: 'gateway-token',
    });
    const { saveNamedRuntimeSecrets } = await import(
      '../src/security/runtime-secrets.js'
    );
    saveNamedRuntimeSecrets({
      OTC_ACCESS_KEY_ID: 'test-access-key',
      OTC_SECRET_ACCESS_KEY: 'test-secret-key',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://ecs.eu-de.otc.t-systems.com/v2.1/project123/servers/detail?limit=50',
        method: 'GET',
        skillName: 't-cloud-public',
        otcAkSk: {
          accessKeyIdSecretName: 'OTC_ACCESS_KEY_ID',
          secretAccessKeySecretName: 'OTC_SECRET_ACCESS_KEY',
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain(
      'OTC_ACCESS_KEY_ID contains a placeholder value',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects managed connector tokens as T Cloud Public signing material', async () => {
    const fetchMock = vi.fn();
    const { state } = await setupOtcGatewayRequestTest({
      dnsAddress: '80.158.59.140',
      fetchMock,
    });

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://ecs.eu-de.otc.t-systems.com/v2.1/project123/servers/detail?limit=50',
        method: 'GET',
        skillName: 't-cloud-public',
        otcAkSk: {
          accessKeyIdSecretName: 'OTC_ACCESS_KEY_ID',
          secretAccessKeySecretName: 'MICROSOFT_365_ACCESS_TOKEN',
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain(
      'MICROSOFT_365_ACCESS_TOKEN is a managed connector token',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('blocks T Cloud Public signing for non-OTC hosts', async () => {
    const fetchMock = vi.fn();
    const { state } = await setupOtcGatewayRequestTest({
      dnsAddress: '93.184.216.34',
      fetchMock,
    });

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://example.com/v2.1/project123/servers/detail',
        method: 'GET',
        otcAkSk: {
          accessKeyIdSecretName: 'OTC_ACCESS_KEY_ID',
          secretAccessKeySecretName: 'OTC_SECRET_ACCESS_KEY',
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain(
      'otcAkSk can only be used for T Cloud Public / Open Telekom Cloud API hosts',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('blocks T Cloud Public signing over cleartext HTTP', async () => {
    const fetchMock = vi.fn();
    const { state } = await setupOtcGatewayRequestTest({
      dnsAddress: '80.158.59.140',
      fetchMock,
    });

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'http://ecs.eu-de.otc.t-systems.com/v2.1/project123/servers/detail',
        method: 'GET',
        otcAkSk: {
          accessKeyIdSecretName: 'OTC_ACCESS_KEY_ID',
          secretAccessKeySecretName: 'OTC_SECRET_ACCESS_KEY',
        },
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain(
      'otcAkSk signing requires an HTTPS T Cloud Public / Open Telekom Cloud URL',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('forwards base64-encoded binary bodies for outbound http_request calls', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '104.21.30.182', family: 4 }]),
    }));
    const state = await importFreshHealth({ gatewayApiToken: 'gateway-token' });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'fax-123' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const multipartBody = Buffer.from(
      [
        '------boundary',
        'Content-Disposition: form-data; name="file"; filename="hello.txt"',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Hallo Welt',
        '------boundary--',
        '',
      ].join('\r\n'),
      'utf8',
    );
    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://hybridai.one/v1/faxes',
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=----boundary',
        },
        bodyBase64: multipartBody.toString('base64'),
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        body: new Uint8Array(multipartBody),
        method: 'POST',
      }),
    );
  });

  test('saves outbound http_request response bodies as workspace artifacts', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '54.230.228.80', family: 4 }]),
    }));
    const dataDir = makeTempDataDir();
    const state = await importFreshHealth({
      dataDir,
      gatewayApiToken: 'gateway-token',
    });
    const imageBody = Buffer.from('jpeg-bytes', 'utf8');
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array(imageBody), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://rest-e003.immedia-semi.com/api/v3/media/accounts/123/networks/456/xt2/789/thumbnail/thumbnail.jpg',
        method: 'GET',
        responseArtifact: {
          filename: 'backyard.jpg',
        },
        suppressResponseBody: true,
        agentId: 'main',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await waitForResponse(res, (next) => next.writableEnded);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      success: true,
      ok: true,
      bodySuppressed: true,
      bodyBytes: imageBody.length,
      artifact: {
        filename: 'backyard.jpg',
        mimeType: 'image/jpeg',
        sha256: createHash('sha256').update(imageBody).digest('hex'),
      },
    });
    expect(body.artifact.path).toMatch(
      /^\/workspace\/\.http-artifacts\/\d+-[a-f0-9]{8}-backyard\.jpg$/u,
    );
    const hostPath = path.join(
      dataDir,
      'agents',
      'main',
      'workspace',
      body.artifact.path.replace(/^\/workspace\//u, ''),
    );
    expect(fs.readFileSync(hostPath)).toEqual(imageBody);
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

  test('returns manual redirects when explicitly requested without following them', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '104.21.30.182', family: 4 }]),
    }));
    const state = await importFreshHealth({ gatewayApiToken: 'gateway-token' });
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          statusText: 'Found',
          headers: {
            location:
              'immedia-blink://applinks.blink.com/signin/callback?code=abc123',
          },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://api.oauth.blink.com/oauth/v2/authorize',
        allowManualRedirect: true,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      status: 302,
      headers: {
        location:
          'immedia-blink://applinks.blink.com/signin/callback?code=abc123',
      },
    });
  });

  test('only returns upstream Set-Cookie headers when explicitly requested', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '104.21.30.182', family: 4 }]),
    }));
    const state = await importFreshHealth({ gatewayApiToken: 'gateway-token' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('ok', {
          status: 200,
          headers: {
            'set-cookie': 'blink-oauth=abc; Path=/; HttpOnly',
            'content-type': 'text/plain',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response('ok', {
          status: 200,
          headers: {
            'set-cookie': 'blink-oauth=abc; Path=/; HttpOnly',
            'content-type': 'text/plain',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const hiddenReq = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://api.oauth.blink.com/oauth/v2/signin',
      },
    });
    const hiddenRes = makeResponse();
    state.handler(hiddenReq as never, hiddenRes as never);
    await settle();

    const visibleReq = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://api.oauth.blink.com/oauth/v2/signin',
        includeResponseCookies: true,
      },
    });
    const visibleRes = makeResponse();
    state.handler(visibleReq as never, visibleRes as never);
    await settle();

    expect(JSON.parse(hiddenRes.body).headers).not.toHaveProperty(
      'set-cookie',
    );
    expect(
      String(JSON.parse(visibleRes.body).headers['set-cookie']),
    ).toContain('blink-oauth=abc');
  });

  test('preserves outbound http_request fetch failure causes in 502 responses', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '104.21.30.182', family: 4 }]),
    }));
    const state = await importFreshHealth({ gatewayApiToken: 'gateway-token' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', {
          cause: new Error('connect ECONNREFUSED 192.168.178.198:80'),
        });
      }),
    );

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

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({
      error:
        'Outbound HTTP request failed: fetch failed (connect ECONNREFUSED 192.168.178.198:80)',
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

  test('allows private outbound http_request targets only when explicitly allowlisted by policy', async () => {
    const dataDir = makeTempDataDir();
    const workspacePath = path.join(dataDir, 'agents', 'main', 'workspace');
    fs.mkdirSync(path.join(workspacePath, '.hybridclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, '.hybridclaw', 'policy.yaml'),
      [
        'network:',
        '  default: deny',
        '  rules:',
        '    - action: allow',
        '      host: 192.168.0.0/16',
        '      port: 80',
        '      methods:',
        '        - GET',
        '      paths:',
        '        - /rpc/**',
        '      agent: "*"',
        '  presets: []',
      ].join('\n'),
      'utf8',
    );
    const state = await importFreshHealth({
      dataDir,
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 0, name: 'Living room' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'http://192.168.178.198/rpc/Cover.GetConfig?id=0',
        method: 'GET',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('honors managed read-write LAN policy for private http_request targets', async () => {
    const dataDir = makeTempDataDir();
    const workspacePath = path.join(dataDir, 'agents', 'main', 'workspace');
    fs.mkdirSync(path.join(workspacePath, '.hybridclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, '.hybridclaw', 'policy.yaml'),
      [
        'network:',
        '  default: deny',
        '  rules:',
        '    - action: allow',
        '      host: 192.168.0.0/16',
        '      port: "*"',
        '      methods:',
        '        - GET',
        '        - HEAD',
        '        - POST',
        '        - PUT',
        '        - PATCH',
        '        - DELETE',
        '        - OPTIONS',
        '      paths:',
        '        - /**',
        '      agent: "*"',
        '      managed_by_preset: lan-http-access',
        '  presets:',
        '    - lan-http-access',
      ].join('\n'),
      'utf8',
    );
    const state = await importFreshHealth({
      dataDir,
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://192.168.178.73/clip/v2/resource/light',
        method: 'GET',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('honors managed read-only LAN policy for private http_request GET targets', async () => {
    const dataDir = makeTempDataDir();
    const workspacePath = path.join(dataDir, 'agents', 'main', 'workspace');
    fs.mkdirSync(path.join(workspacePath, '.hybridclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, '.hybridclaw', 'policy.yaml'),
      [
        'network:',
        '  default: deny',
        '  rules:',
        '    - action: allow',
        '      host: 192.168.0.0/16',
        '      port: "*"',
        '      methods:',
        '        - GET',
        '      paths:',
        '        - /**',
        '      agent: "*"',
        '      managed_by_preset: lan-http-access',
        '  presets:',
        '    - lan-http-access',
      ].join('\n'),
      'utf8',
    );
    const state = await importFreshHealth({
      dataDir,
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'https://192.168.178.73/clip/v2/resource/light',
        method: 'GET',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('resolves env store placeholders before private LAN policy and secret header injection', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-private-env-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);

    const { saveNamedRuntimeEnv } = await import(
      '../src/config/runtime-env.ts'
    );
    saveNamedRuntimeEnv({
      HUE_BRIDGE_HOST: 'https://192.168.178.73',
    });

    const dataDir = path.join(homeDir, '.hybridclaw', 'data');
    const workspacePath = path.join(dataDir, 'agents', 'main', 'workspace');
    fs.mkdirSync(path.join(workspacePath, '.hybridclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, '.hybridclaw', 'policy.yaml'),
      [
        'network:',
        '  default: deny',
        '  rules:',
        '    - action: allow',
        '      host: 192.168.0.0/16',
        '      port: "*"',
        '      methods:',
        '        - GET',
        '      paths:',
        '        - /**',
        '      agent: "*"',
        '      managed_by_preset: lan-http-access',
        '  presets:',
        '    - lan-http-access',
      ].join('\n'),
      'utf8',
    );

    const state = await importFreshHealth({
      dataDir,
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: '<env:HUE_BRIDGE_HOST>/clip/v2/resource/light',
        method: 'GET',
        secretHeaders: [
          {
            name: 'hue-application-key',
            secretName: 'HUE_APPLICATION_KEY',
            prefix: 'none',
          },
        ],
        replaceSecretPlaceholders: true,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Stored secret HUE_APPLICATION_KEY is not set.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        secretName: 'HUE_APPLICATION_KEY',
        targetHost: '192.168.178.73',
      }),
      'Secret used without a domain binding; set the matching *_BOUND_DOMAIN runtime secret before unbound secret injection is removed',
    );
  });

  test('dispatches resolved env store URLs with self-signed TLS allowance', async () => {
    const homeDir = makeTempDocsRoot('hybridclaw-http-private-env-tls-');
    process.env.HOME = homeDir;
    writeRuntimeConfig(homeDir);

    const { saveNamedRuntimeEnv } = await import(
      '../src/config/runtime-env.ts'
    );
    saveNamedRuntimeEnv({
      HUE_BRIDGE_HOST: 'https://192.168.178.73',
    });
    const { readStoredRuntimeSecret } = await import(
      '../src/security/runtime-secrets.ts'
    );

    const dataDir = path.join(homeDir, '.hybridclaw', 'data');
    const workspacePath = path.join(dataDir, 'agents', 'main', 'workspace');
    fs.mkdirSync(path.join(workspacePath, '.hybridclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, '.hybridclaw', 'policy.yaml'),
      [
        'secret:',
        '  default: allow',
        'network:',
        '  default: deny',
        '  rules:',
        '    - action: allow',
        '      host: 192.168.0.0/16',
        '      port: "*"',
        '      methods:',
        '        - POST',
        '      paths:',
        '        - /**',
        '      agent: "*"',
        '      managed_by_preset: lan-http-access',
        '  presets:',
        '    - lan-http-access',
      ].join('\n'),
      'utf8',
    );

    const connectorMock = vi.fn((_options, callback) => {
      callback(null, {});
    });
    const closeMock = vi.fn(async () => undefined);
    const buildConnectorMock = vi.fn(() => connectorMock);
    vi.doMock('undici', () => ({
      Agent: vi.fn().mockImplementation(function (options) {
        return {
          close: closeMock,
          connect: options.connect,
        };
      }),
      buildConnector: buildConnectorMock,
    }));

    const state = await importFreshHealth({
      dataDir,
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([{ success: { username: 'test-hue-key' } }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: '<env:HUE_BRIDGE_HOST>/api',
        method: 'POST',
        json: {
          devicetype: 'hybridclaw#lab',
        },
        captureResponseFields: [
          {
            jsonPath: '0.success.username',
            secretName: 'HUE_APPLICATION_KEY',
          },
        ],
        replaceSecretPlaceholders: true,
        allowSelfSignedTls: true,
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(200);
    expect(buildConnectorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rejectUnauthorized: false,
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://192.168.178.73/api'),
      expect.objectContaining({
        method: 'POST',
        dispatcher: expect.anything(),
      }),
    );
    const fetchOptions = fetchMock.mock.calls[0]?.[1] as
      | { headers?: Record<string, string> }
      | undefined;
    expect(fetchOptions?.headers).not.toHaveProperty('hue-application-key');
    expect(readStoredRuntimeSecret('HUE_APPLICATION_KEY')).toBe('test-hue-key');
    expect(closeMock).toHaveBeenCalledOnce();
  });

  test('keeps private outbound http_request targets blocked when policy path does not match', async () => {
    const dataDir = makeTempDataDir();
    const workspacePath = path.join(dataDir, 'agents', 'main', 'workspace');
    fs.mkdirSync(path.join(workspacePath, '.hybridclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, '.hybridclaw', 'policy.yaml'),
      [
        'network:',
        '  default: deny',
        '  rules:',
        '    - action: allow',
        '      host: 192.168.178.198',
        '      port: 80',
        '      methods:',
        '        - GET',
        '      paths:',
        '        - /rpc/**',
        '      agent: "*"',
        '  presets: []',
      ].join('\n'),
      'utf8',
    );
    const state = await importFreshHealth({
      dataDir,
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'http://192.168.178.198/debug',
        method: 'GET',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error:
        'HTTP request blocked by SSRF guard: private or loopback host (192.168.178.198) is not allowlisted by workspace network policy for GET /debug on port 80.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('reports private outbound http_request method mismatches against policy', async () => {
    const dataDir = makeTempDataDir();
    const workspacePath = path.join(dataDir, 'agents', 'main', 'workspace');
    fs.mkdirSync(path.join(workspacePath, '.hybridclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, '.hybridclaw', 'policy.yaml'),
      [
        'network:',
        '  default: deny',
        '  rules:',
        '    - action: allow',
        '      host: 192.168.178.198',
        '      port: 80',
        '      methods:',
        '        - GET',
        '      paths:',
        '        - /rpc/**',
        '      agent: "*"',
        '  presets: []',
      ].join('\n'),
      'utf8',
    );
    const state = await importFreshHealth({
      dataDir,
      gatewayApiToken: 'gateway-token',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const req = makeRequest({
      method: 'POST',
      url: '/api/http/request',
      headers: { authorization: 'Bearer gateway-token' },
      body: {
        url: 'http://192.168.178.198/rpc/Cover.GetConfig?id=0',
        method: 'POST',
      },
    });
    const res = makeResponse();

    state.handler(req as never, res as never);
    await settle();

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error:
        'HTTP request blocked by SSRF guard: private or loopback host (192.168.178.198) is not allowlisted by workspace network policy for POST /rpc/Cover.GetConfig on port 80.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('streams outbound http_request responses and truncates once the size limit is exceeded', async () => {
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

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      status: 200,
      statusText: '',
      url: '',
      headers: {
        'content-type': 'application/octet-stream',
      },
      body: 'aaaaaabbbb',
      bodyTruncated: true,
      bodyBytes: 12,
      maxResponseBytes: 10,
    });
  });

  test('short-circuits outbound http_request reads when content-length exceeds the size limit', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [{ address: '104.21.30.182', family: 4 }]),
    }));
    const state = await importFreshHealth({ gatewayApiToken: 'gateway-token' });
    const fetchMock = vi.fn(
      async () =>
        new Response('x'.repeat(50), {
          status: 200,
          headers: {
            'content-length': '50',
            'content-type': 'application/octet-stream',
          },
        }),
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

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      status: 200,
      statusText: '',
      url: '',
      headers: {
        'content-length': '50',
        'content-type': 'application/octet-stream',
      },
      body: '',
      bodyTruncated: true,
      bodyBytes: 50,
      maxResponseBytes: 10,
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

  test('serves video artifacts inline for web chat previews', async () => {
    const dataDir = makeTempDataDir();
    const artifactPath = path.join(
      dataDir,
      'agents',
      'agent-1',
      'workspace',
      '.generated-videos',
      'demo.mp4',
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, 'video payload', 'utf8');

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
    expect(res.headers['Content-Type']).toBe('video/mp4');
    expect(res.headers['Content-Disposition']).toContain(
      'inline; filename="demo.mp4"',
    );
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Content-Security-Policy']).toBeUndefined();
    expect(res.body).toBe('video payload');
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
      noAuth: true,
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
    const outsideDir = makeTempDocsRoot('hybridclaw-health-outside-');
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
    await waitForResponse(res, (response) => response.statusCode !== 0);

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
