import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const tempDirs: string[] = [];

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

function createHonchoStubServer() {
  const createdMessages: Array<Record<string, unknown>> = [];
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
      const peerId = String(body?.id || 'peer');
      sendJson(200, {
        id: peerId,
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
      const messages = Array.isArray(body?.messages)
        ? (body?.messages as Array<Record<string, unknown>>)
        : [];
      createdMessages.push(...messages);
      sendJson(
        200,
        messages.map((message, index) => ({
          id: `m-${createdMessages.length - messages.length + index + 1}`,
          content: String(message.content || ''),
          peer_id: String(message.peer_id || ''),
          session_id: 'session-1',
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
      sendJson(200, {
        id: 'session-1',
        messages: createdMessages.slice(-2).map((message, index) => ({
          id: `ctx-${index + 1}`,
          content: String(message.content || ''),
          peer_id: String(message.peer_id || ''),
          session_id: 'session-1',
          workspace_id: 'hybridclaw-test',
          metadata: message.metadata || {},
          created_at: String(message.created_at || '2026-04-07T10:00:00.000Z'),
          token_count: 12,
        })),
        summary: {
          content: 'User prefers concise status updates.',
          message_id: 'ctx-1',
          summary_type: 'short',
          created_at: '2026-04-07T10:05:00.000Z',
          token_count: 24,
        },
        peer_representation:
          'The user is actively working on HybridClaw memory integrations.',
        peer_card: [
          'prefers concise responses',
          'cares about real source compatibility',
        ],
      });
      return;
    }

    if (
      req.method === 'GET' &&
      /^\/v3\/workspaces\/[^/]+\/queue\/status$/.test(url.pathname)
    ) {
      queueStatusRequests += 1;
      sendJson(200, {
        total_work_units: 2,
        completed_work_units: createdMessages.length,
        in_progress_work_units: 0,
        pending_work_units: Math.max(0, 2 - createdMessages.length),
      });
      return;
    }

    if (
      req.method === 'POST' &&
      /^\/v3\/workspaces\/[^/]+\/sessions\/[^/]+\/search$/.test(url.pathname)
    ) {
      const query = String(body?.query || '').toLowerCase();
      const filtered = createdMessages.filter((message) =>
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
          session_id: 'session-1',
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
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
});

test('honcho-memory syncs turns, deduplicates repeated sync, injects context, and exposes status/search commands', async () => {
  const honcho = createHonchoStubServer();
  const baseUrl = await honcho.listen();

  const homeDir = makeTempDir('hybridclaw-honcho-home-');
  const cwd = makeTempDir('hybridclaw-honcho-project-');
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

  try {
    const { PluginManager } = await import('../src/plugins/plugin-manager.js');
    const manager = new PluginManager({
      homeDir,
      cwd,
      getRuntimeConfig: () => config,
    });

    await manager.ensureInitialized();

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

    expect(honcho.createdMessages).toHaveLength(2);

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

    expect(promptContext).toHaveLength(1);
    expect(promptContext[0]).toContain('Honcho session memory context:');
    expect(promptContext[0]).toContain('User prefers concise status updates.');
    expect(promptContext[0]).toContain('HybridClaw memory integrations');
    expect(promptContext[0]).toContain('user: Please integrate Honcho memory');
    expect(promptContext[0]).toContain(
      'assistant: I am mirroring the conversation into Honcho now.',
    );

    const command = manager.findCommand('honcho');
    expect(command).toBeDefined();

    const statusText = await command?.handler(['status'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    });
    expect(String(statusText)).toContain('Honcho status');
    expect(String(statusText)).toContain('Workspace: hybridclaw-test');
    expect(honcho.queueStatusRequests).toBeGreaterThan(0);

    const searchText = await command?.handler(['search', 'mirroring'], {
      sessionId: 'session-1',
      channelId: 'web',
      userId: 'user-1',
    });
    expect(String(searchText)).toContain('I am mirroring the conversation');
  } finally {
    await honcho.close();
  }
});
