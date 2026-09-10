import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { ChatMessage } from '../src/types/api.js';
import type { ContainerOutput } from '../src/types/container.js';

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
  const { runMigrations } = await import('../src/memory/schema/migrations.js');
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

    expect(database.pragma('user_version', { simple: true })).toBe(59);
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

async function runFreshWorker(
  sessionId: string,
  messages: ChatMessage[],
  baseUrl: string,
): Promise<ContainerOutput> {
  const ipcDir = fs.mkdtempSync(path.join(root, 'ipc-'));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'container/src/index.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HYBRIDCLAW_AGENT_WORKSPACE_ROOT: workspace,
        HYBRIDCLAW_AGENT_IPC_DIR: ipcDir,
        HYBRIDCLAW_AGENT_ALLOWED_ROOTS: JSON.stringify([workspace]),
        HYBRIDCLAW_RETRY_ENABLED: 'false',
        CONTAINER_IDLE_TIMEOUT: '25',
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  child.stdin.end(
    JSON.stringify({
      sessionId,
      messages,
      apiKey: 'test-key',
      baseUrl,
      provider: 'hybridai',
      model: 'test-model',
      chatbotId: 'test-bot',
      enableRag: false,
      allowedTools: ['read'],
      skipContainerSystemPrompt: true,
      contextWindow: 128_000,
    }) + '\n',
  );
  try {
    const outputPath = path.join(ipcDir, 'output.json');
    const deadline = Date.now() + 20_000;
    while (
      !fs.existsSync(outputPath) &&
      Date.now() < deadline &&
      child.exitCode === null
    )
      await delay(25);
    if (!fs.existsSync(outputPath))
      throw new Error(`Worker produced no IPC output: ${stderr}`);
    return JSON.parse(fs.readFileSync(outputPath, 'utf8')) as ContainerOutput;
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
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
