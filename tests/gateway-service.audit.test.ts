import fs from 'node:fs';

import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-audit-',
  envVars: ['HYBRIDCLAW_LOG_REQUESTS'],
  cleanup: () => {
    runAgentMock.mockReset();
    vi.doUnmock('../src/providers/hybridai-bots.ts');
    vi.doUnmock('../src/logger.js');
  },
});

test('audit command shows recent structured audit events for the current session', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { makeAuditRunId, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );

  initDatabase({ quiet: true });
  recordAuditEvent({
    sessionId: 'session-audit',
    runId: makeAuditRunId('test'),
    event: {
      type: 'tool.result',
      toolName: 'bash',
      isError: false,
      durationMs: 12,
    },
  });

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-audit',
    guildId: null,
    channelId: 'channel-audit',
    args: ['audit'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Audit (session-audit)');
  expect(result.text).toContain('tool.result');
  expect(result.text).toContain('bash ok 12ms');
});

test('admin tools exposes recent tool error summaries', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { makeAuditRunId, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );

  initDatabase({ quiet: true });
  recordAuditEvent({
    sessionId: 'session-read',
    runId: makeAuditRunId('test'),
    event: {
      type: 'tool.result',
      toolName: 'read',
      isError: true,
      resultSummary: 'File not found: notes.txt',
      durationMs: 145,
    },
  });

  const { getGatewayAdminTools } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = getGatewayAdminTools();
  const readTool = result.groups
    .flatMap((group) => group.tools)
    .find((tool) => tool.name === 'read');

  expect(readTool).toBeDefined();
  expect(readTool?.recentErrors).toBe(1);
  expect(readTool?.recentErrorSamples).toEqual([
    expect.objectContaining({
      sessionId: 'session-read',
      summary: 'File not found: notes.txt',
    }),
  ]);
  expect(result.recentExecutions[0]).toMatchObject({
    toolName: 'read',
    isError: true,
    summary: 'File not found: notes.txt',
  });
});

test('bot set records a structured audit event for observability export', async () => {
  setupHome();
  const userId = 'u'.repeat(200);
  const username = 'a'.repeat(200);

  const { initDatabase, getRecentStructuredAuditForSession, getSessionById } =
    await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  vi.doMock('../src/providers/hybridai-bots.ts', () => ({
    HybridAIBotFetchError: class HybridAIBotFetchError extends Error {},
    fetchHybridAIBots: vi.fn(async () => [
      {
        id: 'bot-research',
        name: 'Research Bot',
        description: 'Answers with research context',
        model: 'gpt-4o-mini',
      },
    ]),
  }));

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-bot-set-audit',
    guildId: null,
    channelId: 'channel-bot-set-audit',
    userId,
    username,
    args: ['bot', 'set', 'Research Bot'],
  });

  expect(result).toMatchObject({
    kind: 'plain',
    text: 'Chatbot set to `bot-research` and model set to `hybridai/gpt-4o-mini` for this session.',
  });

  const events = getRecentStructuredAuditForSession(
    'session-bot-set-audit',
    10,
  );
  expect(events).toHaveLength(1);
  expect(events[0]?.event_type).toBe('bot.set');
  expect(JSON.parse(events[0]?.payload || '{}')).toMatchObject({
    type: 'bot.set',
    source: 'command',
    requestedBot: 'Research Bot',
    previousBotId: null,
    resolvedBotId: 'bot-research',
    changed: true,
    userId: userId.slice(0, 128),
    username: username.slice(0, 128),
  });
  expect(getSessionById('session-bot-set-audit')?.chatbot_id).toBe(
    'bot-research',
  );
  expect(getSessionById('session-bot-set-audit')?.model).toBe('gpt-4o-mini');
});

test('bot set leaves the session model unchanged when the bot exposes no model', async () => {
  setupHome();

  const {
    getOrCreateSession,
    getSessionById,
    initDatabase,
    updateSessionModel,
  } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });
  getOrCreateSession(
    'session-bot-set-no-model',
    null,
    'channel-bot-set-no-model',
  );
  updateSessionModel('session-bot-set-no-model', 'gpt-5-nano');

  vi.doMock('../src/providers/hybridai-bots.ts', () => ({
    HybridAIBotFetchError: class HybridAIBotFetchError extends Error {},
    fetchHybridAIBots: vi.fn(async () => [
      {
        id: 'bot-research',
        name: 'Research Bot',
      },
    ]),
  }));

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-bot-set-no-model',
    guildId: null,
    channelId: 'channel-bot-set-no-model',
    args: ['bot', 'set', 'Research Bot'],
  });

  expect(result).toMatchObject({
    kind: 'plain',
    text: 'Chatbot set to `bot-research` for this session.',
  });
  expect(getSessionById('session-bot-set-no-model')?.chatbot_id).toBe(
    'bot-research',
  );
  expect(getSessionById('session-bot-set-no-model')?.model).toBe('gpt-5-nano');
});

test('bot clear clears the session chatbot and records a structured audit event', async () => {
  setupHome();

  const {
    getOrCreateSession,
    getRecentStructuredAuditForSession,
    getSessionById,
    initDatabase,
    updateSessionChatbot,
  } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });
  getOrCreateSession(
    'session-bot-clear-audit',
    null,
    'channel-bot-clear-audit',
  );
  updateSessionChatbot('session-bot-clear-audit', 'bot-research');

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-bot-clear-audit',
    guildId: null,
    channelId: 'channel-bot-clear-audit',
    args: ['bot', 'clear'],
  });

  expect(result).toMatchObject({
    kind: 'plain',
    text: 'Chatbot cleared for this session. HybridAI account fallback will be used when required.',
  });
  expect(getSessionById('session-bot-clear-audit')?.chatbot_id).toBeNull();

  const events = getRecentStructuredAuditForSession(
    'session-bot-clear-audit',
    10,
  );
  expect(events).toHaveLength(1);
  expect(events[0]?.event_type).toBe('bot.clear');
  expect(JSON.parse(events[0]?.payload || '{}')).toMatchObject({
    type: 'bot.clear',
    source: 'command',
    previousBotId: 'bot-research',
    changed: true,
  });
});

test('handleGatewayMessage records agent handoff before agent-side timeouts', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'error',
    result: null,
    toolsUsed: [],
    toolExecutions: [],
    error: 'Timeout waiting for agent output after 300000ms',
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getAuditWirePath } = await import('../src/audit/audit-trail.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  const sessionId = 'wa:491701234567@s.whatsapp.net';
  const result = await handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: '491701234567@s.whatsapp.net',
    userId: '+491701234567',
    username: 'alice',
    content: 'Von wem ist das?',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('error');

  const raw = fs.readFileSync(getAuditWirePath(sessionId), 'utf-8');
  const records = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event?: Record<string, unknown> })
    .filter((record) => record.event);
  const eventTypes = records.map((record) => String(record.event?.type));

  expect(eventTypes).toContain('context.optimization');
  expect(eventTypes).toContain('agent.start');

  const agentStartIndex = eventTypes.indexOf('agent.start');
  const contextOptimizationIndex = eventTypes.indexOf('context.optimization');
  const errorIndex = eventTypes.indexOf('error');
  expect(agentStartIndex).toBeGreaterThan(contextOptimizationIndex);
  expect(errorIndex).toBeGreaterThan(agentStartIndex);

  expect(records[agentStartIndex]?.event).toMatchObject({
    type: 'agent.start',
    model: 'vllm/Qwen/Qwen3.5-27B-FP8',
  });
  expect(
    typeof records[agentStartIndex]?.event?.systemPrompt === 'string' &&
      String(records[agentStartIndex]?.event?.systemPrompt).length > 0,
  ).toBe(true);
  expect(records[errorIndex]?.event).toMatchObject({
    type: 'error',
    errorType: 'agent',
    stage: 'processing-agent-output',
  });
});

test('handleGatewayMessage stores redacted request logs when enabled', async () => {
  setupHome({ HYBRIDCLAW_LOG_REQUESTS: '1' });
  const secret = 'supersecret1234567890';
  const signedSignature = 'amzsignature1234567890';
  const signedToken = 'signedtoken1234567890';
  const signedUrl = `https://s3.amazonaws.com/bucket?X-Amz-Signature=${signedSignature}&token=${signedToken}`;

  runAgentMock.mockResolvedValue({
    status: 'error',
    result: null,
    toolsUsed: ['browser_type'],
    toolExecutions: [
      {
        name: 'browser_type',
        arguments: JSON.stringify({
          element: 'password',
          text: secret,
        }),
        result: `uploaded to ${signedUrl}`,
        durationMs: 12,
      },
    ],
    error: `Password: ${secret}`,
  });

  const { DB_PATH } = await import('../src/config/config.ts');
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  const result = await handleGatewayMessage({
    sessionId: 'session-request-log',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content: `Username: alice\nPassword: ${secret}\nUpload URL: ${signedUrl}`,
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('error');

  const inspect = new Database(DB_PATH, { readonly: true });
  const row = inspect
    .prepare(
      `SELECT messages_json, status, response, error, tool_executions_json, tools_used
       FROM request_log
       WHERE session_id = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get('session-request-log') as
    | {
        messages_json: string | null;
        status: string | null;
        response: string | null;
        error: string | null;
        tool_executions_json: string | null;
        tools_used: string | null;
      }
    | undefined;
  inspect.close();

  expect(row).toBeDefined();
  expect(row?.status).toBe('error');
  expect(row?.response).toBeNull();
  expect(row?.tools_used).toBe(JSON.stringify(['browser_type']));
  expect(row?.messages_json).not.toContain(secret);
  expect(row?.messages_json).not.toContain(signedSignature);
  expect(row?.messages_json).not.toContain(signedToken);
  expect(row?.messages_json).toContain('Password: [REDACTED]');
  expect(row?.messages_json).toContain(
    'X-Amz-Signature=[REDACTED]&token=[REDACTED]',
  );
  expect(row?.error).toBe('Password: [REDACTED]');
  expect(row?.tool_executions_json).not.toContain(secret);
  expect(row?.tool_executions_json).not.toContain(signedSignature);
  expect(row?.tool_executions_json).not.toContain(signedToken);
  const toolExecutions = JSON.parse(
    row?.tool_executions_json || '[]',
  ) as Array<{
    arguments?: string;
    result?: string;
  }>;
  expect(toolExecutions[0]?.arguments).toContain('"text":"[REDACTED]"');
  expect(toolExecutions[0]?.result).toContain(
    'X-Amz-Signature=[REDACTED]&token=[REDACTED]',
  );
});

test('handleGatewayMessage skips request logs when request logging is disabled', async () => {
  setupHome();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'done',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { DB_PATH } = await import('../src/config/config.ts');
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  const result = await handleGatewayMessage({
    sessionId: 'session-request-log-disabled',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content: 'hello',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(result.status).toBe('success');

  const inspect = new Database(DB_PATH, { readonly: true });
  const rowCount = inspect
    .prepare(
      `SELECT COUNT(*) AS count
       FROM request_log
       WHERE session_id = ?`,
    )
    .get('session-request-log-disabled') as { count: number };
  inspect.close();

  expect(rowCount.count).toBe(0);
});

test('handleGatewayMessage warns once and disables request logs for invalid env values', async () => {
  setupHome({ HYBRIDCLAW_LOG_REQUESTS: 'true' });

  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  vi.doMock('../src/logger.js', () => ({ logger }));

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'done',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { DB_PATH } = await import('../src/config/config.ts');
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );

  initDatabase({ quiet: true });
  await handleGatewayMessage({
    sessionId: 'session-request-log-invalid-a',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content: 'hello',
    model: 'test-model',
    chatbotId: 'bot-1',
  });
  await handleGatewayMessage({
    sessionId: 'session-request-log-invalid-b',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'alice',
    content: 'hello again',
    model: 'test-model',
    chatbotId: 'bot-1',
  });

  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith(
    {
      envVar: 'HYBRIDCLAW_LOG_REQUESTS',
      expectedValue: '1',
      value: 'true',
    },
    'Ignoring invalid gateway request logging env value',
  );

  const inspect = new Database(DB_PATH, { readonly: true });
  const rowCount = inspect
    .prepare(
      `SELECT COUNT(*) AS count
       FROM request_log
       WHERE session_id IN (?, ?)`,
    )
    .get('session-request-log-invalid-a', 'session-request-log-invalid-b') as {
    count: number;
  };
  inspect.close();

  expect(rowCount.count).toBe(0);
});
