import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-gateway-audit-'));
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  runAgentMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/providers/hybridai-bots.ts');
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar(
    'HYBRIDCLAW_DISABLE_CONFIG_WATCHER',
    ORIGINAL_DISABLE_CONFIG_WATCHER,
  );
});

test('audit command shows recent structured audit events for the current session', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();

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
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();

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
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();

  const { initDatabase, getRecentStructuredAuditForSession, getSessionById } =
    await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  vi.doMock('../src/providers/hybridai-bots.ts', () => ({
    fetchHybridAIBots: vi.fn(async () => [
      {
        id: 'bot-research',
        name: 'Research Bot',
        description: 'Answers with research context',
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
    userId: 'user-1',
    username: 'alice',
    args: ['bot', 'set', 'Research Bot'],
  });

  expect(result).toMatchObject({
    kind: 'plain',
    text: 'Chatbot set to `bot-research` for this session.',
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
    userId: 'user-1',
    username: 'alice',
  });
  expect(getSessionById('session-bot-set-audit')?.chatbot_id).toBe(
    'bot-research',
  );
});

test('handleGatewayMessage records agent handoff before agent-side timeouts', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();

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
    '../src/gateway/gateway-service.ts'
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
  expect(records[errorIndex]?.event).toMatchObject({
    type: 'error',
    errorType: 'agent',
    stage: 'processing-agent-output',
  });
});
