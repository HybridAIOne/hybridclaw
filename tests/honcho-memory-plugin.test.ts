import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const tempDirs: string[] = [];
const originalRuntimeHome = process.env.HYBRIDCLAW_DATA_DIR;

interface StubMessage {
  peer_id: string;
  content: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
  session_id?: string;
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function loadRuntimeConfig(): RuntimeConfig {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
}

function installBundledPlugin(cwd: string): void {
  const sourceDir = path.join(process.cwd(), 'plugins', 'honcho-memory');
  const targetDir = path.join(cwd, '.hybridclaw', 'plugins', 'honcho-memory');
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4000,
  intervalMs = 20,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

function createHonchoStubServer() {
  const createdMessages: StubMessage[] = [];
  const contextRequests: Array<{
    sessionId: string;
    peerTarget: string;
    peerPerspective: string;
  }> = [];
  const representationRequests: Array<Record<string, unknown>> = [];
  const chatRequests: Array<Record<string, unknown>> = [];
  const conclusions: Array<Record<string, unknown>> = [];
  let queueStatusRequests = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString('utf-8');
    const body = rawBody
      ? (JSON.parse(rawBody) as Record<string, unknown>)
      : null;

    const sendJson = (statusCode: number, payload: unknown) => {
      res.statusCode = statusCode;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };

    const sessionMessages = (sessionId: string) =>
      createdMessages.filter((message) => message.session_id === sessionId);

    const makeContextMessage = (message: StubMessage, index: number) => ({
      id: `ctx-${index + 1}`,
      content: String(message.content || ''),
      peer_id: String(message.peer_id || ''),
      session_id: String(message.session_id || ''),
      workspace_id: 'hybridclaw-test',
      metadata: message.metadata || {},
      created_at: String(message.created_at || '2026-04-07T10:00:00.000Z'),
      token_count: 12,
    });

    if (req.method === 'POST' && url.pathname === '/v3/workspaces') {
      sendJson(200, {
        id: String(body?.id || 'workspace'),
        metadata: {},
        configuration: {},
        created_at: '2026-04-07T10:00:00.000Z',
      });
      return;
    }

    if (
      req.method === 'POST' &&
      /^\/v3\/workspaces\/[^/]+\/peers$/.test(url.pathname)
    ) {
      sendJson(200, {
        id: String(body?.id || 'peer'),
        workspace_id: 'hybridclaw-test',
        metadata: body?.metadata || {},
        configuration: {},
        created_at: '2026-04-07T10:00:00.000Z',
      });
      return;
    }

    if (
      req.method === 'POST' &&
      /^\/v3\/workspaces\/[^/]+\/sessions$/.test(url.pathname)
    ) {
      sendJson(200, {
        id: String(body?.id || 'session'),
        workspace_id: 'hybridclaw-test',
        is_active: true,
        metadata: body?.metadata || {},
        configuration: {},
        created_at: '2026-04-07T10:00:00.000Z',
      });
      return;
    }

    if (
      req.method === 'POST' &&
      /^\/v3\/workspaces\/[^/]+\/sessions\/[^/]+\/peers$/.test(url.pathname)
    ) {
      sendJson(200, { ok: true });
      return;
    }

    if (
      req.method === 'POST' &&
      /^\/v3\/workspaces\/[^/]+\/sessions\/[^/]+\/messages$/.test(url.pathname)
    ) {
      const sessionId = decodeURIComponent(
        url.pathname.match(
          /^\/v3\/workspaces\/[^/]+\/sessions\/([^/]+)\/messages$/,
        )?.[1] || '',
      );
      const messages = Array.isArray(body?.messages)
        ? (body.messages as Array<Record<string, unknown>>)
        : [];
      for (const message of messages) {
        createdMessages.push({
          peer_id: String(message.peer_id || ''),
          content: String(message.content || ''),
          created_at: String(message.created_at || '2026-04-07T10:00:00.000Z'),
          metadata:
            message.metadata && typeof message.metadata === 'object'
              ? (message.metadata as Record<string, unknown>)
              : {},
          session_id: sessionId,
        });
      }
      sendJson(
        200,
        messages.map((message, index) => ({
          id: `m-${createdMessages.length - messages.length + index + 1}`,
          content: String(message.content || ''),
          peer_id: String(message.peer_id || ''),
          session_id: sessionId,
          workspace_id: 'hybridclaw-test',
          metadata: message.metadata || {},
          created_at: String(message.created_at || '2026-04-07T10:00:00.000Z'),
          token_count: 12,
        })),
      );
      return;
    }

    if (
      req.method === 'GET' &&
      /^\/v3\/workspaces\/[^/]+\/sessions\/[^/]+\/context$/.test(url.pathname)
    ) {
      const sessionId = decodeURIComponent(
        url.pathname.match(
          /^\/v3\/workspaces\/[^/]+\/sessions\/([^/]+)\/context$/,
        )?.[1] || '',
      );
      const peerTarget = String(url.searchParams.get('peer_target') || '');
      const peerPerspective = String(
        url.searchParams.get('peer_perspective') || '',
      );
      contextRequests.push({
        sessionId,
        peerTarget,
        peerPerspective,
      });
      const recent = sessionMessages(sessionId)
        .slice(-4)
        .map(makeContextMessage);
      if (peerTarget.startsWith('agent-')) {
        sendJson(200, {
          id: sessionId,
          messages: recent,
          peer_representation:
            'The assistant is a workspace-aware HybridClaw agent with durable Honcho memory.',
          peer_card: [
            'Tracks user preferences across sessions',
            'Maintains explicit identity seeds from workspace files',
          ],
        });
        return;
      }
      sendJson(200, {
        id: sessionId,
        messages: recent,
        summary: {
          content: 'User prefers concise status updates.',
          message_id: 'ctx-1',
          summary_type: 'short',
          created_at: '2026-04-07T10:05:00.000Z',
          token_count: 24,
        },
        peer_representation:
          'The user works across multiple HybridClaw sessions and wants real Honcho compatibility.',
        peer_card: [
          'prefers concise responses',
          'cares about source-compatible integrations',
        ],
      });
      return;
    }

    if (
      req.method === 'POST' &&
      /^\/v3\/workspaces\/[^/]+\/peers\/[^/]+\/representation$/.test(
        url.pathname,
      )
    ) {
      const peerId = decodeURIComponent(
        url.pathname.match(
          /^\/v3\/workspaces\/[^/]+\/peers\/([^/]+)\/representation$/,
        )?.[1] || '',
      );
      representationRequests.push({
        peerId,
        ...(body || {}),
      });
      const target = String(body?.target || '');
      sendJson(200, {
        representation: target
          ? `Representation for ${target}: user prefers durable synced memory.`
          : `Representation for ${peerId}: assistant identity is workspace seeded.`,
        peer_card: target
          ? ['prefers durable sync', 'uses Honcho for recall']
          : ['assistant identity seeded', 'workspace aware'],
      });
      return;
    }

    if (
      req.method === 'POST' &&
      /^\/v3\/workspaces\/[^/]+\/peers\/[^/]+\/chat$/.test(url.pathname)
    ) {
      const peerId = decodeURIComponent(
        url.pathname.match(
          /^\/v3\/workspaces\/[^/]+\/peers\/([^/]+)\/chat$/,
        )?.[1] || '',
      );
      chatRequests.push({
        peerId,
        ...(body || {}),
      });
      const target = String(body?.target || '');
      const query = String(body?.query || '');
      sendJson(200, {
        content: target
          ? `Honcho says ${peerId} knows ${target}: ${query}`
          : `Honcho says ${peerId}: ${query}`,
      });
      return;
    }

    if (
      req.method === 'POST' &&
      /^\/v3\/workspaces\/[^/]+\/conclusions$/.test(url.pathname)
    ) {
      const items = Array.isArray(body?.conclusions)
        ? (body.conclusions as Array<Record<string, unknown>>)
        : [];
      conclusions.push(...items);
      sendJson(
        200,
        items.map((item, index) => ({
          id: `conclusion-${conclusions.length - items.length + index + 1}`,
          ...item,
        })),
      );
      return;
    }

    if (
      req.method === 'GET' &&
      /^\/v3\/workspaces\/[^/]+\/queue\/status$/.test(url.pathname)
    ) {
      queueStatusRequests += 1;
      sendJson(200, {
        total_work_units: createdMessages.length,
        completed_work_units: createdMessages.length,
        in_progress_work_units: 0,
        pending_work_units: 0,
      });
      return;
    }

    if (
      req.method === 'POST' &&
      /^\/v3\/workspaces\/[^/]+\/sessions\/[^/]+\/search$/.test(url.pathname)
    ) {
      const sessionId = decodeURIComponent(
        url.pathname.match(
          /^\/v3\/workspaces\/[^/]+\/sessions\/([^/]+)\/search$/,
        )?.[1] || '',
      );
      const query = String(body?.query || '').toLowerCase();
      const filtered = sessionMessages(sessionId).filter((message) =>
        String(message.content || '')
          .toLowerCase()
          .includes(query),
      );
      sendJson(
        200,
        filtered.map((message, index) => ({
          id: `search-${index + 1}`,
          content: String(message.content || ''),
          peer_id: String(message.peer_id || ''),
          session_id: String(message.session_id || ''),
          workspace_id: 'hybridclaw-test',
          metadata: message.metadata || {},
          created_at: String(message.created_at || '2026-04-07T10:00:00.000Z'),
          token_count: 12,
        })),
      );
      return;
    }

    sendJson(404, { error: `Unhandled route: ${req.method} ${url.pathname}` });
  });

  return {
    createdMessages,
    contextRequests,
    representationRequests,
    chatRequests,
    conclusions,
    get queueStatusRequests() {
      return queueStatusRequests;
    },
    async listen() {
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected Honcho stub server to bind to a TCP port.');
      }
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

afterEach(() => {
  if (originalRuntimeHome === undefined) {
    delete process.env.HYBRIDCLAW_DATA_DIR;
  } else {
    process.env.HYBRIDCLAW_DATA_DIR = originalRuntimeHome;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
});

test('honcho-memory seeds workspace identity, mirrors turns once, and exposes Honcho commands and tools', async () => {
  const honcho = createHonchoStubServer();
  const baseUrl = await honcho.listen();

  const runtimeHome = makeTempDir('hybridclaw-honcho-home-');
  const cwd = makeTempDir('hybridclaw-honcho-project-');
  process.env.HYBRIDCLAW_DATA_DIR = runtimeHome;
  installBundledPlugin(cwd);

  const [{ PluginManager }, dbModule, ipcModule] = await Promise.all([
    import('../src/plugins/plugin-manager.js'),
    import('../src/memory/db.js'),
    import('../src/infra/ipc.js'),
  ]);

  vi.spyOn(dbModule, 'getSessionById').mockReturnValue({
    agent_id: 'main',
  } as never);
  vi.spyOn(dbModule, 'getRecentMessages').mockReturnValue([
    {
      role: 'user',
      user_id: 'user-1',
    },
  ] as never);

  const workspacePath = ipcModule.agentWorkspaceDir('main');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, 'SOUL.md'), 'You are HybridClaw.');
  fs.writeFileSync(
    path.join(workspacePath, 'IDENTITY.md'),
    'Assist with reliable memory integrations.',
  );
  fs.writeFileSync(
    path.join(workspacePath, 'AGENTS.md'),
    'Use concise, direct engineering updates.',
  );
  fs.writeFileSync(
    path.join(workspacePath, 'USER.md'),
    'User prefers concise answers and real integrations.',
  );
  fs.writeFileSync(
    path.join(workspacePath, 'MEMORY.md'),
    'Prior note: the user compares implementations against examples.',
  );

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'honcho-memory',
      enabled: true,
      config: {
        baseUrl,
        workspaceId: 'hybridclaw-test',
        contextTokens: 2000,
        searchLimit: 5,
        maxInjectedChars: 4000,
        writeFrequency: 'turn',
        sessionStrategy: 'per-session',
      },
    },
  ];

  const manager = new PluginManager({
    homeDir: runtimeHome,
    cwd,
    getRuntimeConfig: () => config,
  });

  try {
    await manager.ensureInitialized();

    expect(manager.getToolDefinitions().map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'honcho_profile',
        'honcho_search',
        'honcho_context',
        'honcho_conclude',
      ]),
    );

    await manager.notifySessionStart({
      sessionId: 'session-1',
      userId: 'user-1',
      agentId: 'main',
      channelId: 'web',
    });
    await waitFor(() => honcho.contextRequests.length >= 2);
    await waitFor(() => honcho.chatRequests.length >= 1);

    const turnMessages = [
      {
        id: 10,
        session_id: 'session-1',
        user_id: 'user-1',
        username: 'alice',
        role: 'user',
        content: 'Please integrate Honcho memory for this session.',
        created_at: '2026-04-07T10:00:00.000Z',
      },
      {
        id: 11,
        session_id: 'session-1',
        user_id: 'user-1',
        username: 'assistant',
        role: 'assistant',
        content: 'I am mirroring the conversation into Honcho now.',
        created_at: '2026-04-07T10:00:02.000Z',
      },
    ];

    await manager.notifyTurnComplete({
      sessionId: 'session-1',
      userId: 'user-1',
      agentId: 'main',
      messages: turnMessages,
    });
    await manager.notifyTurnComplete({
      sessionId: 'session-1',
      userId: 'user-1',
      agentId: 'main',
      messages: turnMessages,
    });

    const mirroredTurns = honcho.createdMessages.filter((message) =>
      [10, 11].includes(Number(message.metadata?.hybridclaw_message_id || 0)),
    );
    expect(mirroredTurns).toHaveLength(2);
    expect(
      honcho.createdMessages.filter((message) =>
        String(message.content || '').includes('<ai_identity_seed>'),
      ),
    ).toHaveLength(3);
    expect(
      honcho.createdMessages.filter((message) =>
        String(message.content || '').includes('<prior_memory_file>'),
      ),
    ).toHaveLength(2);

    await waitFor(() => honcho.contextRequests.length >= 4);

    const promptContext = await manager.collectPromptContext({
      sessionId: 'session-1',
      userId: 'user-1',
      agentId: 'main',
      channelId: 'web',
      recentMessages: [
        ...turnMessages,
        {
          id: 12,
          session_id: 'session-1',
          user_id: 'user-1',
          username: 'alice',
          role: 'user',
          content: 'What does Honcho know about me?',
          created_at: '2026-04-07T10:01:00.000Z',
        },
      ],
    });

    expect(promptContext.join('\n\n')).toContain('# Honcho Memory Context');
    expect(promptContext.join('\n\n')).toContain(
      'User prefers concise status updates.',
    );
    expect(promptContext.join('\n\n')).toContain('prefers concise responses');
    expect(promptContext.join('\n\n')).toContain(
      'HybridClaw agent with durable Honcho memory',
    );
    expect(promptContext.join('\n\n')).toContain('Commands: /honcho status');

    const command = manager.findCommand('honcho');
    expect(command).toBeDefined();

    const statusText = await command?.handler(['status'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    });
    expect(String(statusText)).toContain('Honcho status');
    expect(String(statusText)).toContain('Honcho session: session-1');
    expect(String(statusText)).toContain('Built-in memory: always on');
    expect(honcho.queueStatusRequests).toBeGreaterThan(0);

    const modeHelpText = await command?.handler(['mode'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    });
    expect(String(modeHelpText)).toContain(
      'Built-in HybridClaw memory stays on',
    );

    const modeSetText = await command?.handler(['mode', 'tools'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    });
    expect(String(modeSetText)).toContain(
      'Updated Honcho recall mode to tools.',
    );

    const recallHelpText = await command?.handler(['recall'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    });
    expect(String(recallHelpText)).toContain(
      '/honcho recall <hybrid|context|tools>',
    );

    const searchText = await command?.handler(['search', 'mirroring'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    });
    expect(String(searchText)).toContain('I am mirroring the conversation');

    const identityText = await command?.handler(['identity', '--show'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    });
    expect(String(identityText)).toContain('Honcho identity');
    expect(String(identityText)).toContain('AI peer');

    const syncText = await command?.handler(['sync'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    });
    expect(String(syncText)).toContain('Honcho sync complete.');

    const profileText = await manager.executeTool({
      toolName: 'honcho_profile',
      sessionId: 'session-1',
      channelId: 'web',
      args: {},
    });
    expect(profileText).toContain('Honcho profile');

    const toolSearchText = await manager.executeTool({
      toolName: 'honcho_search',
      sessionId: 'session-1',
      channelId: 'web',
      args: {
        query: 'memory',
      },
    });
    expect(toolSearchText).toContain('Honcho search');
    expect(toolSearchText).toContain('Session message matches:');

    const toolContextText = await manager.executeTool({
      toolName: 'honcho_context',
      sessionId: 'session-1',
      channelId: 'web',
      args: {
        query: 'What matters most about this user?',
      },
    });
    expect(toolContextText).toContain('Honcho says');

    const toolConcludeText = await manager.executeTool({
      toolName: 'honcho_conclude',
      sessionId: 'session-1',
      channelId: 'web',
      args: {
        conclusion: 'User prefers source-compatible integrations.',
      },
    });
    expect(toolConcludeText).toContain('Conclusion saved:');
    expect(honcho.conclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: 'User prefers source-compatible integrations.',
        }),
      ]),
    );
  } finally {
    await manager.shutdown();
    await honcho.close();
  }
});

test('honcho-memory backfills stored session history once when activated mid-session', async () => {
  const honcho = createHonchoStubServer();
  const baseUrl = await honcho.listen();

  const runtimeHome = makeTempDir('hybridclaw-honcho-home-');
  const cwd = makeTempDir('hybridclaw-honcho-project-');
  process.env.HYBRIDCLAW_DATA_DIR = runtimeHome;
  installBundledPlugin(cwd);

  const [{ PluginManager }, dbModule] = await Promise.all([
    import('../src/plugins/plugin-manager.js'),
    import('../src/memory/db.js'),
  ]);

  const priorMessages = [
    {
      id: 1,
      session_id: 'session-backfill',
      user_id: 'user-backfill',
      username: 'alice',
      role: 'user',
      content: 'Earlier session context that Honcho should backfill.',
      created_at: '2026-04-08T09:00:00.000Z',
    },
    {
      id: 2,
      session_id: 'session-backfill',
      user_id: 'user-backfill',
      username: 'assistant',
      role: 'assistant',
      content: 'Acknowledged. This should be preserved on activation.',
      created_at: '2026-04-08T09:00:02.000Z',
    },
  ];

  vi.spyOn(dbModule, 'getSessionById').mockReturnValue({
    agent_id: 'main',
  } as never);
  vi.spyOn(dbModule, 'getRecentMessages').mockImplementation(
    (sessionId: string) => {
      if (sessionId === 'session-backfill') {
        return priorMessages as never;
      }
      return [] as never;
    },
  );

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'honcho-memory',
      enabled: true,
      config: {
        baseUrl,
        workspaceId: 'hybridclaw-test',
        writeFrequency: 'turn',
        sessionStrategy: 'per-session',
      },
    },
  ];

  const manager = new PluginManager({
    homeDir: runtimeHome,
    cwd,
    getRuntimeConfig: () => config,
  });

  const currentTurn = [
    {
      id: 10,
      session_id: 'session-backfill',
      user_id: 'user-backfill',
      username: 'alice',
      role: 'user',
      content: 'Continue from the earlier conversation.',
      created_at: '2026-04-08T09:10:00.000Z',
    },
    {
      id: 11,
      session_id: 'session-backfill',
      user_id: 'user-backfill',
      username: 'assistant',
      role: 'assistant',
      content: 'Honcho is active and caught up now.',
      created_at: '2026-04-08T09:10:01.000Z',
    },
  ];

  try {
    await manager.ensureInitialized();

    await manager.notifyTurnComplete({
      sessionId: 'session-backfill',
      userId: 'user-backfill',
      agentId: 'main',
      messages: currentTurn,
    });

    const mirroredMessageIds = honcho.createdMessages
      .map((message) => Number(message.metadata?.hybridclaw_message_id || 0))
      .filter(Boolean);
    expect(mirroredMessageIds).toEqual([1, 2, 10, 11]);

    await manager.notifyTurnComplete({
      sessionId: 'session-backfill',
      userId: 'user-backfill',
      agentId: 'main',
      messages: currentTurn,
    });

    const dedupedMessageIds = honcho.createdMessages
      .map((message) => Number(message.metadata?.hybridclaw_message_id || 0))
      .filter(Boolean);
    expect(dedupedMessageIds).toEqual([1, 2, 10, 11]);
  } finally {
    await manager.shutdown();
    await honcho.close();
  }
});

test('honcho-memory guarantees first prompt context when prefetch is not ready yet', async () => {
  const honcho = createHonchoStubServer();
  const baseUrl = await honcho.listen();

  const runtimeHome = makeTempDir('hybridclaw-honcho-home-');
  const cwd = makeTempDir('hybridclaw-honcho-project-');
  process.env.HYBRIDCLAW_DATA_DIR = runtimeHome;
  installBundledPlugin(cwd);

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'honcho-memory',
      enabled: true,
      config: {
        baseUrl,
        workspaceId: 'hybridclaw-test',
        writeFrequency: 'turn',
      },
    },
  ];

  const manager = new PluginManager({
    homeDir: runtimeHome,
    cwd,
    getRuntimeConfig: () => config,
  });

  try {
    await manager.ensureInitialized();

    const promptContext = await manager.collectPromptContext({
      sessionId: 'session-first-prompt',
      userId: 'user-first-prompt',
      agentId: 'main',
      channelId: 'web',
      recentMessages: [
        {
          id: 21,
          session_id: 'session-first-prompt',
          user_id: 'user-first-prompt',
          username: 'alice',
          role: 'user',
          content: 'Tell me what you know about me.',
          created_at: '2026-04-08T10:01:00.000Z',
        },
      ],
    });

    expect(promptContext.join('\n\n')).toContain('# Honcho Memory Context');
    expect(honcho.contextRequests).toHaveLength(2);
    expect(honcho.chatRequests).toHaveLength(0);

    const contextRequestsBefore = honcho.contextRequests.length;
    const promptContextAgain = await manager.collectPromptContext({
      sessionId: 'session-first-prompt',
      userId: 'user-first-prompt',
      agentId: 'main',
      channelId: 'web',
      recentMessages: [
        {
          id: 21,
          session_id: 'session-first-prompt',
          user_id: 'user-first-prompt',
          username: 'alice',
          role: 'user',
          content: 'Tell me what you know about me.',
          created_at: '2026-04-08T10:01:00.000Z',
        },
      ],
    });

    expect(promptContextAgain.join('\n\n')).toContain(
      '# Honcho Memory Context',
    );
    expect(honcho.contextRequests.length).toBe(contextRequestsBefore);
  } finally {
    await manager.shutdown();
    await honcho.close();
  }
});

test('honcho-memory uses prefetched prompt context without fetching during prompt build', async () => {
  const honcho = createHonchoStubServer();
  const baseUrl = await honcho.listen();

  const runtimeHome = makeTempDir('hybridclaw-honcho-home-');
  const cwd = makeTempDir('hybridclaw-honcho-project-');
  process.env.HYBRIDCLAW_DATA_DIR = runtimeHome;
  installBundledPlugin(cwd);

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'honcho-memory',
      enabled: true,
      config: {
        baseUrl,
        workspaceId: 'hybridclaw-test',
        writeFrequency: 'turn',
      },
    },
  ];

  const manager = new PluginManager({
    homeDir: runtimeHome,
    cwd,
    getRuntimeConfig: () => config,
  });

  try {
    await manager.ensureInitialized();
    await manager.notifySessionStart({
      sessionId: 'session-2',
      userId: 'user-2',
      agentId: 'main',
      channelId: 'web',
    });
    await waitFor(() => honcho.contextRequests.length >= 2);
    await waitFor(() => honcho.chatRequests.length >= 1);

    const contextRequestsBefore = honcho.contextRequests.length;
    const chatRequestsBefore = honcho.chatRequests.length;

    const promptContext = await manager.collectPromptContext({
      sessionId: 'session-2',
      userId: 'user-2',
      agentId: 'main',
      channelId: 'web',
      recentMessages: [
        {
          id: 20,
          session_id: 'session-2',
          user_id: 'user-2',
          username: 'alice',
          role: 'user',
          content: 'Summarize my preferences.',
          created_at: '2026-04-07T10:01:00.000Z',
        },
      ],
    });

    expect(promptContext.join('\n\n')).toContain('# Honcho Memory Context');
    expect(honcho.contextRequests.length).toBe(contextRequestsBefore);
    expect(honcho.chatRequests.length).toBe(chatRequestsBefore);
  } finally {
    await manager.shutdown();
    await honcho.close();
  }
});

test('honcho-memory persists dedup state across manager restarts', async () => {
  const honcho = createHonchoStubServer();
  const baseUrl = await honcho.listen();

  const runtimeHome = makeTempDir('hybridclaw-honcho-home-');
  const cwd = makeTempDir('hybridclaw-honcho-project-');
  process.env.HYBRIDCLAW_DATA_DIR = runtimeHome;
  installBundledPlugin(cwd);

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'honcho-memory',
      enabled: true,
      config: {
        baseUrl,
        workspaceId: 'hybridclaw-test',
        writeFrequency: 'turn',
      },
    },
  ];

  const turnMessages = [
    {
      id: 30,
      session_id: 'session-3',
      user_id: 'user-3',
      username: 'alice',
      role: 'user',
      content: 'Persist this turn in Honcho.',
      created_at: '2026-04-07T10:00:00.000Z',
    },
    {
      id: 31,
      session_id: 'session-3',
      user_id: 'user-3',
      username: 'assistant',
      role: 'assistant',
      content: 'Persisting the turn now.',
      created_at: '2026-04-07T10:00:01.000Z',
    },
  ];

  const managerA = new PluginManager({
    homeDir: runtimeHome,
    cwd,
    getRuntimeConfig: () => config,
  });
  await managerA.ensureInitialized();
  await managerA.notifyTurnComplete({
    sessionId: 'session-3',
    userId: 'user-3',
    agentId: 'main',
    messages: turnMessages,
  });
  await managerA.shutdown();

  const managerB = new PluginManager({
    homeDir: runtimeHome,
    cwd,
    getRuntimeConfig: () => config,
  });

  try {
    await managerB.ensureInitialized();
    await managerB.notifyTurnComplete({
      sessionId: 'session-3',
      userId: 'user-3',
      agentId: 'main',
      messages: turnMessages,
    });

    const mirroredTurns = honcho.createdMessages.filter((message) =>
      [30, 31].includes(Number(message.metadata?.hybridclaw_message_id || 0)),
    );
    expect(mirroredTurns).toHaveLength(2);
  } finally {
    await managerB.shutdown();
    await honcho.close();
  }
});

test('honcho-memory tools mode keeps prompt recall disabled and lazily initializes Honcho tools', async () => {
  const honcho = createHonchoStubServer();
  const baseUrl = await honcho.listen();

  const runtimeHome = makeTempDir('hybridclaw-honcho-home-');
  const cwd = makeTempDir('hybridclaw-honcho-project-');
  process.env.HYBRIDCLAW_DATA_DIR = runtimeHome;
  installBundledPlugin(cwd);

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'honcho-memory',
      enabled: true,
      config: {
        baseUrl,
        workspaceId: 'hybridclaw-test',
        recallMode: 'tools',
        writeFrequency: 'turn',
      },
    },
  ];

  const manager = new PluginManager({
    homeDir: runtimeHome,
    cwd,
    getRuntimeConfig: () => config,
  });

  try {
    await manager.ensureInitialized();

    expect(manager.getToolDefinitions().map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'honcho_profile',
        'honcho_search',
        'honcho_context',
        'honcho_conclude',
      ]),
    );

    const promptContext = await manager.collectPromptContext({
      sessionId: 'session-tools-mode',
      userId: 'user-tools',
      agentId: 'main',
      channelId: 'web',
      recentMessages: [
        {
          id: 1,
          session_id: 'session-tools-mode',
          user_id: 'user-tools',
          username: 'alice',
          role: 'user',
          content: 'Use Honcho only through tools.',
          created_at: '2026-04-09T10:00:00.000Z',
        },
      ],
    });

    expect(promptContext.join('\n\n')).toContain('# Honcho Memory');
    expect(promptContext.join('\n\n')).not.toContain('# Honcho Memory Context');
    expect(honcho.contextRequests).toHaveLength(0);
    expect(honcho.chatRequests).toHaveLength(0);

    const profileText = await manager.executeTool({
      toolName: 'honcho_profile',
      sessionId: 'session-tools-mode',
      channelId: 'web',
      args: {},
    });

    expect(profileText).toContain('Honcho profile');
    expect(honcho.contextRequests.length).toBeGreaterThan(0);
  } finally {
    await manager.shutdown();
    await honcho.close();
  }
});

test('honcho-memory flushes buffered turn sync on session end when configured for session writes', async () => {
  const honcho = createHonchoStubServer();
  const baseUrl = await honcho.listen();

  const runtimeHome = makeTempDir('hybridclaw-honcho-home-');
  const cwd = makeTempDir('hybridclaw-honcho-project-');
  process.env.HYBRIDCLAW_DATA_DIR = runtimeHome;
  installBundledPlugin(cwd);

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'honcho-memory',
      enabled: true,
      config: {
        baseUrl,
        workspaceId: 'hybridclaw-test',
        writeFrequency: 'session',
      },
    },
  ];

  const manager = new PluginManager({
    homeDir: runtimeHome,
    cwd,
    getRuntimeConfig: () => config,
  });

  const turnMessages = [
    {
      id: 40,
      session_id: 'session-flush',
      user_id: 'user-flush',
      username: 'alice',
      role: 'user',
      content: 'Buffer this turn until the session ends.',
      created_at: '2026-04-09T10:00:00.000Z',
    },
    {
      id: 41,
      session_id: 'session-flush',
      user_id: 'user-flush',
      username: 'assistant',
      role: 'assistant',
      content: 'Buffered for the session-end flush.',
      created_at: '2026-04-09T10:00:01.000Z',
    },
  ];

  try {
    await manager.ensureInitialized();
    await manager.notifyTurnComplete({
      sessionId: 'session-flush',
      userId: 'user-flush',
      agentId: 'main',
      messages: turnMessages,
    });

    expect(
      honcho.createdMessages.filter((message) =>
        [40, 41].includes(Number(message.metadata?.hybridclaw_message_id || 0)),
      ),
    ).toHaveLength(0);

    await manager.notifySessionEnd({
      sessionId: 'session-flush',
      userId: 'user-flush',
      agentId: 'main',
      channelId: 'web',
    });

    expect(
      honcho.createdMessages.filter((message) =>
        [40, 41].includes(Number(message.metadata?.hybridclaw_message_id || 0)),
      ),
    ).toHaveLength(2);
  } finally {
    await manager.shutdown();
    await honcho.close();
  }
});

test('honcho-memory converts native user profile writes into Honcho conclusions', async () => {
  const honcho = createHonchoStubServer();
  const baseUrl = await honcho.listen();

  const homeDir = makeTempDir('hybridclaw-honcho-home-');
  const cwd = makeTempDir('hybridclaw-honcho-project-');
  process.env.HYBRIDCLAW_DATA_DIR = homeDir;
  installBundledPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'honcho-memory',
      enabled: true,
      config: {
        baseUrl,
        workspaceId: 'hybridclaw-test',
        contextTokens: 2000,
        searchLimit: 5,
        maxInjectedChars: 2500,
      },
    },
  ];

  let manager: { shutdown(): Promise<void> } | null = null;

  try {
    const { PluginManager } = await import('../src/plugins/plugin-manager.js');
    manager = new PluginManager({
      homeDir,
      cwd,
      getRuntimeConfig: () => config,
    });

    await manager.ensureInitialized();

    await manager.collectPromptContext({
      sessionId: 'session-native-memory',
      userId: 'user-1',
      agentId: 'main',
      channelId: 'web',
      recentMessages: [
        {
          id: 1,
          session_id: 'session-native-memory',
          user_id: 'user-1',
          username: 'alice',
          role: 'user',
          content: 'Remember the auth migration decision.',
          created_at: '2026-04-09T10:00:00.000Z',
        },
      ],
    });

    await manager.notifyMemoryWrites({
      sessionId: 'session-native-memory',
      agentId: 'main',
      channelId: 'web',
      toolExecutions: [
        {
          name: 'memory',
          arguments:
            '{"action":"append","target":"user","content":"Prefers concise migration plans."}',
          result: 'Appended 33 chars to USER.md',
          durationMs: 8,
        },
        {
          name: 'memory',
          arguments:
            '{"action":"append","file_path":"memory/2026-04-09.md","content":"Daily note that should stay in transcript sync only."}',
          result: 'Appended 51 chars to memory/2026-04-09.md',
          durationMs: 8,
        },
      ],
    });

    expect(honcho.createdMessages).toHaveLength(0);
    expect(honcho.conclusions).toEqual([
      expect.objectContaining({
        content: 'Prefers concise migration plans.',
        session_id: 'session-native-memory',
        observer_id: 'agent-main',
        observed_id: 'user-user-1',
      }),
    ]);
  } finally {
    await manager?.shutdown();
    await honcho.close();
  }
});
