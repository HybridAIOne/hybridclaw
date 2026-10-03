import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { ChatMessage } from '../src/types/api.js';
import type {
  ContainerInput,
  ContainerOutput,
} from '../src/types/container.js';
import { runContainerWorker } from './helpers/container-worker.js';

let root: string;
let db: typeof import('../src/memory/db.js');
let memory: typeof import('../src/memory/memory-service.js').memoryService;
let buildContext: typeof import('../src/agent/conversation.js').buildConversationContext;
let appendTranscript: typeof import('../src/session/session-transcripts.js').appendSessionTranscript;
let workspace: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-tool-history-'));
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', root);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.resetModules();
  db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true, dbPath: path.join(root, 'history.db') });
  memory = (await import('../src/memory/memory-service.js')).memoryService;
  buildContext = (await import('../src/agent/conversation.js'))
    .buildConversationContext;
  appendTranscript = (await import('../src/session/session-transcripts.js'))
    .appendSessionTranscript;
  const ipc = await import('../src/infra/ipc.js');
  ipc.ensureAgentDirs('main');
  workspace = ipc.agentWorkspaceDir('main');
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

test('upgrades schema 58 without losing chat or scheduler failure data', async () => {
  const { DATABASE_SCHEMA_VERSION, runMigrations } = await import(
    '../src/memory/schema/migrations.js'
  );
  const database = new Database(':memory:');
  try {
    runMigrations(database, { quiet: true });
    database.exec(`
      ALTER TABLE messages DROP COLUMN tool_history_json;
      DELETE FROM migrations WHERE version = 59;
      PRAGMA user_version = 58;
      INSERT INTO messages (session_id, user_id, role, content)
        VALUES ('session-a', 'assistant', 'assistant', 'Existing reply');
      INSERT INTO jobs (id, kind, schedule, action, delivery, last_error)
        VALUES ('job-a', 'scheduler_job', '{}', '{}', '{}', 'Delivery failed');
      INSERT INTO proactive_message_queue
        (channel_id, text, source, failed_at, failure_reason)
        VALUES ('channel-a', 'Queued reply', 'scheduler',
          '2026-09-10T00:00:00Z', 'Channel unavailable');
    `);
    const schedulerMigration = database
      .prepare('SELECT * FROM migrations WHERE version = 58')
      .get();

    runMigrations(database, { quiet: true });
    runMigrations(database, { quiet: true });

    expect(database.pragma('user_version', { simple: true })).toBe(
      DATABASE_SCHEMA_VERSION,
    );
    expect(
      database.prepare('SELECT content, tool_history_json FROM messages').all(),
    ).toEqual([{ content: 'Existing reply', tool_history_json: null }]);
    expect(database.prepare('SELECT last_error FROM jobs').get()).toEqual({
      last_error: 'Delivery failed',
    });
    expect(
      database
        .prepare(
          'SELECT failed_at, failure_reason FROM proactive_message_queue',
        )
        .get(),
    ).toEqual({
      failed_at: '2026-09-10T00:00:00Z',
      failure_reason: 'Channel unavailable',
    });
    expect(
      database.prepare('SELECT * FROM migrations WHERE version = 58').get(),
    ).toEqual(schedulerMigration);
    expect(
      database
        .prepare('SELECT version FROM migrations WHERE version = 59')
        .all(),
    ).toEqual([{ version: 59 }]);
  } finally {
    database.close();
  }
});

function runFreshWorker(
  sessionId: string,
  messages: ChatMessage[],
  baseUrl: string,
  overrides: Partial<ContainerInput> = {},
): Promise<ContainerOutput> {
  return runContainerWorker(
    {
      sessionId,
      messages,
      apiKey: 'test-key',
      baseUrl,
      provider: 'hybridai',
      model: 'test-model',
      chatbotId: 'test-bot',
      channelId: 'test-channel',
      enableRag: false,
      allowedTools: ['read'],
      skipContainerSystemPrompt: true,
      contextWindow: 128_000,
      ...overrides,
    },
    {
      HYBRIDCLAW_AGENT_WORKSPACE_ROOT: workspace,
      HYBRIDCLAW_AGENT_ALLOWED_ROOTS: JSON.stringify([workspace]),
    },
  );
}

test('a fresh worker uses the previous turn’s stored result without calling the tool again', async () => {
  const session = memory.getOrCreateSession(
    'tool-history',
    null,
    'test-channel',
  );
  fs.writeFileSync(path.join(workspace, 'report.txt'), 'Inventory count: 42');
  const requests: ChatMessage[][] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const messages = JSON.parse(body).messages as ChatMessage[];
    requests.push(messages);
    const result = messages.find((message) => message.role === 'tool');
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: result
              ? { role: 'assistant', content: 'Inventory count is 42.' }
              : {
                  role: 'assistant',
                  content: 'Reading inventory.',
                  tool_calls: [
                    {
                      id: 'inventory-read',
                      type: 'function',
                      function: {
                        name: 'read',
                        arguments: '{"path":"report.txt"}',
                      },
                    },
                  ],
                },
            finish_reason: result ? 'stop' : 'tool_calls',
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const first = await runFreshWorker(
      session.id,
      [{ role: 'user', content: 'Read inventory' }],
      baseUrl,
    );
    expect(first.status).toBe('success');
    expect(first.toolHistory).toHaveLength(2);
    expect(first.toolHistory?.[1].content).toContain('Inventory count: 42');
    const { recordSuccessfulTurn } = await import(
      '../src/gateway/gateway-service.js'
    );
    recordSuccessfulTurn({
      sessionId: session.id,
      agentId: 'main',
      chatbotId: 'test-bot',
      enableRag: false,
      model: 'test-model',
      channelId: 'test-channel',
      runId: 'test-run',
      turnIndex: 1,
      userId: 'user_a',
      username: null,
      canonicalScopeId: '',
      userContent: 'Read inventory',
      resultText: first.result || '',
      toolCallCount: 1,
      toolHistory: first.toolHistory,
      toolHistoryForReplay: first.toolHistoryForReplay,
      startedAt: Date.now(),
    });
    db.initDatabase({ quiet: true, dbPath: path.join(root, 'history.db') });
    const history = memory.getConversationHistory(session.id);
    expect(history).toHaveLength(2);
    const context = buildContext({
      agentId: 'main',
      promptMode: 'none',
      history,
    });
    const previousResult = context.messages.find(
      (message) => message.role === 'tool',
    );
    expect(previousResult).toEqual(
      requests[1].find((message) => message.role === 'tool'),
    );
    fs.unlinkSync(path.join(workspace, 'report.txt'));
    const second = await runFreshWorker(
      session.id,
      [...context.messages, { role: 'user', content: 'What was the count?' }],
      baseUrl,
    );
    expect(second.result).toBe('Inventory count is 42.');
    expect(second.toolsUsed).toEqual([]);
    expect(requests).toHaveLength(3);

    const transcriptPath = path.join(
      workspace,
      '.session-transcripts',
      `${session.id}.jsonl`,
    );
    const rows = fs
      .readFileSync(transcriptPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => row.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(rows[2].tool_call_id).toBe('inventory-read');

    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
    const tools = await import('../container/src/tools.js');
    tools.setSessionContext(session.id);
    const search = JSON.parse(
      await tools.executeTool(
        'session_search',
        JSON.stringify({ query: 'inventory-read', include_current: true }),
      ),
    );
    expect(search.results[0].transcript_path).toContain(
      '.session-transcripts/',
    );
    expect(search.results[0].snippets.join('\n')).toContain(
      'Inventory count: 42',
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 60_000);

test('a file reference reaches the outbound request but never the recorded call', async () => {
  // Approval, the before/after hooks, and tool history all see the call the
  // model wrote; only dispatch sees the bytes. Pin that from the outside.
  const session = memory.getOrCreateSession(
    'file-reference',
    null,
    'test-channel',
  );
  const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
  const encoded = logo.toString('base64');
  fs.writeFileSync(path.join(workspace, 'logo.png'), logo);
  const modelRequests: ChatMessage[][] = [];
  const gatewayRequests: Array<{ json?: { content?: string } }> = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/http/request') {
      gatewayRequests.push(JSON.parse(body));
      res.end(JSON.stringify({ ok: true, status: 201, body: '{}' }));
      return;
    }
    const messages = JSON.parse(body).messages as ChatMessage[];
    modelRequests.push(messages);
    const answered = messages.some((message) => message.role === 'tool');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: answered
              ? { role: 'assistant', content: 'Committed the logo.' }
              : {
                  role: 'assistant',
                  content: 'Committing the logo.',
                  tool_calls: [
                    {
                      id: 'logo-put',
                      type: 'function',
                      function: {
                        name: 'http_request',
                        arguments: JSON.stringify({
                          url: 'https://api.github.com/repos/user_a/site/contents/logo.png',
                          method: 'PUT',
                          json: {
                            message: 'chore: add logo',
                            content: '<file-base64:logo.png>',
                          },
                        }),
                      },
                    },
                  ],
                },
            finish_reason: answered ? 'stop' : 'tool_calls',
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const output = await runFreshWorker(
      session.id,
      [{ role: 'user', content: 'Commit the logo' }],
      baseUrl,
      {
        allowedTools: ['http_request'],
        gatewayBaseUrl: baseUrl,
        gatewayApiToken: 'test-token',
        approvalMode: 'full',
      },
    );

    expect(output.status).toBe('success');
    expect(gatewayRequests).toHaveLength(1);
    expect(gatewayRequests[0].json?.content).toBe(encoded);
    for (const recorded of [output.toolHistory, modelRequests[1]]) {
      const text = JSON.stringify(recorded);
      expect(text).toContain('<file-base64:logo.png>');
      expect(text).toContain(`sent logo.png (${logo.length} bytes)`);
      expect(text).not.toContain(encoded);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 60_000);

test('a large tool result crosses IPC once, as a reference while the model and replay retain full content', async () => {
  // Two full copies of a 6 MB result used to exceed the 10 MB output limit.
  const session = memory.getOrCreateSession('large-result', null, 'test-channel');
  const body = 'row,value\n'.repeat(600_000);
  let observedModelResult: unknown;
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += String(chunk);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/http/request') {
      res.end(JSON.stringify({ ok: true, status: 200, body }));
      return;
    }
    const messages = JSON.parse(text).messages as ChatMessage[];
    const toolResult = messages.find((message) => message.role === 'tool');
    observedModelResult = toolResult?.content;
    const answered = Boolean(toolResult);
    res.end(
      JSON.stringify({
        choices: [
          {
            message: answered
              ? { role: 'assistant', content: 'Fetched the export.' }
              : {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'export-get',
                      type: 'function',
                      function: {
                        name: 'http_request',
                        arguments: '{"url":"https://example.com/export.csv"}',
                      },
                    },
                  ],
                },
            finish_reason: answered ? 'stop' : 'tool_calls',
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const output = await runFreshWorker(
      session.id,
      [{ role: 'user', content: 'Fetch the export' }],
      baseUrl,
      {
        allowedTools: ['http_request'],
        gatewayBaseUrl: baseUrl,
        gatewayApiToken: 'test-token',
        approvalMode: 'full',
        contextGuard: { enabled: false },
      },
    );

    expect(output.status).toBe('success');
    expect(JSON.stringify(output).length).toBeLessThan(100_000);
    expect(output.spilledToolCallIds).toEqual(['export-get']);

    const { restoreSpilledToolResults } = await import(
      '../src/agent/spilled-tool-results.js'
    );
    const restored = restoreSpilledToolResults(output, {
      sessionId: session.id,
      workspaceRoot: workspace,
    });
    const saved = fs.readFileSync(
      path.join(workspace, '.tool-results', session.id, 'export-get.txt'),
      'utf8',
    );
    expect(JSON.parse(saved).body === body).toBe(true);
    expect(observedModelResult === saved).toBe(true);
    expect(restored.toolExecutions?.[0].result === saved).toBe(true);
    expect(restored.toolHistory?.[1].content === saved).toBe(true);
    expect(restored.toolHistoryForReplay?.[1].content === saved).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 60_000);

test('forks retain exchanges and other sessions never inherit them', () => {
  const session = memory.getOrCreateSession('fork-tools', null, 'fork-channel');
  const toolHistory: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-a',
          type: 'function',
          function: { name: 'read', arguments: '{}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call-a', content: 'Only for this session' },
  ];
  memory.storeTurn({
    sessionId: session.id,
    user: { userId: 'user_a', username: null, content: 'Read' },
    assistant: { content: 'Done', toolHistory },
  });
  const nextId = memory.storeMessage({
    sessionId: session.id,
    userId: 'user_a',
    username: null,
    role: 'user',
    content: 'Next',
  });
  const fork = memory.forkSessionBranch({
    sessionId: session.id,
    beforeMessageId: nextId,
  });
  const forkHistory = memory.getConversationHistory(fork.session.id);
  expect(JSON.parse(forkHistory[0].tool_history_json || '[]')).toEqual(
    toolHistory,
  );
  const other = memory.getOrCreateSession('other-tools', null, 'other-channel');
  expect(memory.getConversationHistory(other.id)).toEqual([]);
});

test('transcript writes refuse symlinks', () => {
  const target = path.join(root, 'outside.txt');
  fs.writeFileSync(target, 'unchanged');
  fs.symlinkSync(
    target,
    path.join(workspace, '.session-transcripts', 'symlink.jsonl'),
  );
  appendTranscript('main', {
    sessionId: 'symlink',
    channelId: 'test-channel',
    role: 'assistant',
    userId: 'assistant',
    username: null,
    content: 'Do not write outside',
  });
  expect(fs.readFileSync(target, 'utf8')).toBe('unchanged');
});
