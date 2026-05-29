import fs from 'node:fs';

import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import type { StructuredAuditEntry } from '../src/types/audit.js';
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

function structuredAuditEntry(params: {
  id: number;
  eventType: string;
  runId?: string;
  payload?: Record<string, unknown>;
}): StructuredAuditEntry {
  const timestamp = new Date(1_800_000_000_000 + params.id).toISOString();
  return {
    id: params.id,
    session_id: 'session-audit-unit',
    seq: params.id,
    event_type: params.eventType,
    timestamp,
    run_id: params.runId || 'turn_audit_unit',
    parent_run_id: null,
    payload: JSON.stringify(params.payload || {}),
    wire_hash: `hash-${params.id}`,
    wire_prev_hash: `hash-${params.id - 1}`,
    created_at: timestamp,
  };
}

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

test('audit command shows latest turn-level tool trace with redacted details', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { emitToolExecutionAuditEvents, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );

  initDatabase({ quiet: true });
  recordAuditEvent({
    sessionId: 'session-turn-audit',
    runId: 'turn_audit_1',
    event: {
      type: 'turn.start',
      turnIndex: 1,
      userInput: 'First request',
    },
  });
  recordAuditEvent({
    sessionId: 'session-turn-audit',
    runId: 'turn_audit_1',
    event: { type: 'turn.end', turnIndex: 1, finishReason: 'completed' },
  });

  recordAuditEvent({
    sessionId: 'session-turn-audit',
    runId: 'turn_audit_2',
    event: {
      type: 'turn.start',
      turnIndex: 2,
      userInput: 'Fetch status with token=sk-test-ABCDEFGHIJKLMNOP1234567890',
    },
  });
  recordAuditEvent({
    sessionId: 'session-turn-audit',
    runId: 'turn_audit_2',
    event: {
      type: 'model.usage',
      provider: 'hybridai',
      model: 'gpt-5-nano',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    },
  });
  emitToolExecutionAuditEvents({
    sessionId: 'session-turn-audit',
    runId: 'turn_audit_2',
    toolExecutions: [
      {
        name: 'update_plan',
        arguments: '{"steps":["inspect","fix"]}',
        result: 'plan updated',
        durationMs: 2,
        isError: false,
      },
      {
        name: 'web_fetch',
        arguments:
          '{"url":"https://example.com/status?token=sk-test-ABCDEFGHIJKLMNOP1234567890","headers":{"Authorization":"Bearer abcdefghijklmnopqrstuvwxyz"}}',
        result: 'ok token=sk-test-ABCDEFGHIJKLMNOP1234567890',
        durationMs: 42,
        isError: false,
        approvalDecision: 'implicit',
        approvalTier: 'yellow',
      },
    ],
  });
  recordAuditEvent({
    sessionId: 'session-turn-audit',
    runId: 'turn_audit_2',
    event: {
      type: 'skill.execution',
      skillName: 'status-check',
      outcome: 'success',
      durationMs: 12,
    },
  });
  recordAuditEvent({
    sessionId: 'session-turn-audit',
    runId: 'turn_audit_2',
    event: {
      type: 'turn.end',
      turnIndex: 2,
      finishReason: 'completed',
      durationMs: 60,
    },
  });

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'session-turn-audit',
    guildId: null,
    channelId: 'channel-turn-audit',
    args: ['audit', 'last'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.title).toBe('Audit Turn (session-turn-audit)');
  expect(result.text).toContain('Turn: 2');
  expect(result.text).toContain('Run: turn_audit_2');
  expect(result.text).toContain('update_plan (helper/planning) ok');
  expect(result.text).toContain('web_fetch (network execution) ok');
  expect(result.text).toContain('authorization:');
  expect(result.text).toContain('"toolCallId":"turn_audit_2:tool:2"');
  expect(result.text).toContain('"model":"order2_markov_frequency_v1"');
  expect(result.text).toContain('Model usage:');
  expect(result.text).toContain('status-check: success');
  expect(result.text).toContain('Duration: total 60ms, tools 44ms');
  expect(result.text).not.toContain('sk-test-ABCDEFGHIJKLMNOP1234567890');
  expect(result.text).not.toContain('abcdefghijklmnopqrstuvwxyz');
  expect(result.text).toContain('***REDACTED***');
});

test('turn audit scopes action-only authorization checks to nearest matching tool', async () => {
  const { buildAuditTurnTraceRecords } = await import(
    '../src/session/session-turn-trace.js'
  );
  const auditEntries = [
    structuredAuditEntry({
      id: 1,
      eventType: 'turn.start',
      payload: { turnIndex: 1, userInput: 'Run two shell checks' },
    }),
    structuredAuditEntry({
      id: 2,
      eventType: 'tool.call',
      payload: {
        toolCallId: 'turn_audit_unit:tool:1',
        toolName: 'bash',
        arguments: { command: 'first' },
      },
    }),
    structuredAuditEntry({
      id: 3,
      eventType: 'authorization.check',
      payload: {
        action: 'tool:bash',
        resource: 'container.sandbox',
        allowed: true,
        reason: 'first-check',
      },
    }),
    structuredAuditEntry({
      id: 4,
      eventType: 'tool.result',
      payload: {
        toolCallId: 'turn_audit_unit:tool:1',
        toolName: 'bash',
        durationMs: 1,
        isError: false,
      },
    }),
    structuredAuditEntry({
      id: 5,
      eventType: 'tool.call',
      payload: {
        toolCallId: 'turn_audit_unit:tool:2',
        toolName: 'bash',
        arguments: { command: 'second' },
      },
    }),
    structuredAuditEntry({
      id: 6,
      eventType: 'authorization.check',
      payload: {
        action: 'tool:bash',
        resource: 'container.sandbox',
        allowed: true,
        reason: 'second-check',
      },
    }),
    structuredAuditEntry({
      id: 7,
      eventType: 'tool.result',
      payload: {
        toolCallId: 'turn_audit_unit:tool:2',
        toolName: 'bash',
        durationMs: 1,
        isError: false,
      },
    }),
    structuredAuditEntry({
      id: 8,
      eventType: 'turn.end',
      payload: { turnIndex: 1, finishReason: 'completed' },
    }),
  ];

  const result = buildAuditTurnTraceRecords({
    sessionId: 'session-audit-unit',
    auditEntries,
    selector: { latest: true },
  });

  expect(result).toHaveProperty('records');
  if ('error' in result) throw new Error(result.error);
  expect(result.records[0]?.tools[0]?.authorization).toHaveLength(1);
  expect(result.records[0]?.tools[0]?.authorization[0]?.summary).toContain(
    'first-check',
  );
  expect(result.records[0]?.tools[1]?.authorization).toHaveLength(1);
  expect(result.records[0]?.tools[1]?.authorization[0]?.summary).toContain(
    'second-check',
  );
});

test('turn audit prefers full tool results over preview output', async () => {
  const { formatAuditTurnTrace } = await import(
    '../src/session/session-turn-trace.js'
  );
  const auditEntries = [
    structuredAuditEntry({
      id: 1,
      eventType: 'turn.start',
      payload: { turnIndex: 1, userInput: 'Show device status' },
    }),
    structuredAuditEntry({
      id: 2,
      eventType: 'tool.call',
      payload: {
        toolCallId: 'turn_full_result:tool:1',
        toolName: 'bash',
        arguments: { command: 'node helper.cjs status' },
      },
    }),
    structuredAuditEntry({
      id: 3,
      eventType: 'tool.result',
      payload: {
        toolCallId: 'turn_full_result:tool:1',
        toolName: 'bash',
        isError: false,
        resultSummary: 'summary',
        resultPreview: '{"status":"ON","details":"truncated..."}',
        resultFull: `{"status":"ON","details":"${'full-result-'.repeat(80)}END"}`,
        durationMs: 25,
      },
    }),
    structuredAuditEntry({
      id: 4,
      eventType: 'turn.end',
      payload: { turnIndex: 1, finishReason: 'completed' },
    }),
  ];

  const result = formatAuditTurnTrace({
    sessionId: 'session-audit-unit',
    auditEntries,
    selector: { latest: true },
  });
  const text = 'text' in result ? result.text : result.error;

  expect(text).toContain('full-result-');
  expect(text).toContain('END');
  expect(text).not.toContain('truncated...');
});

test('audit command selects a turn by session id and stable turn index', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { recordAuditEvent } = await import('../src/audit/audit-events.ts');

  initDatabase({ quiet: true });
  for (const index of [1, 2]) {
    recordAuditEvent({
      sessionId: 'session-turn-select',
      runId: `turn_select_${index}`,
      event: {
        type: 'turn.start',
        turnIndex: index,
        userInput: `Prompt ${index}`,
      },
    });
    recordAuditEvent({
      sessionId: 'session-turn-select',
      runId: `turn_select_${index}`,
      event: { type: 'turn.end', turnIndex: index, finishReason: 'completed' },
    });
  }

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = await handleGatewayCommand({
    sessionId: 'current-session',
    guildId: null,
    channelId: 'channel-turn-select',
    args: ['audit', 'session-turn-select', '--turn', '1'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${result.kind}`);
  }
  expect(result.text).toContain('Run: turn_select_1');
  expect(result.text).not.toContain('turn_select_2');

  const latestResult = await handleGatewayCommand({
    sessionId: 'current-session',
    guildId: null,
    channelId: 'channel-turn-select',
    args: ['audit', 'session-turn-select', '--last'],
  });

  expect(latestResult.kind).toBe('info');
  if (latestResult.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${latestResult.kind}`);
  }
  expect(latestResult.text).toContain('Run: turn_select_2');
  expect(latestResult.text).not.toContain('turn_select_1');

  const runFlagResult = await handleGatewayCommand({
    sessionId: 'current-session',
    guildId: null,
    channelId: 'channel-turn-select',
    args: ['audit', 'session-turn-select', '--run', 'turn_select_2'],
  });

  expect(runFlagResult.kind).toBe('info');
  if (runFlagResult.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${runFlagResult.kind}`);
  }
  expect(runFlagResult.text).toContain('Run: turn_select_2');
  expect(runFlagResult.text).not.toContain('turn_select_1');

  const runResult = await handleGatewayCommand({
    sessionId: 'session-turn-select',
    guildId: null,
    channelId: 'channel-turn-select',
    args: ['audit', 'run', 'turn_select_2'],
  });

  expect(runResult.kind).toBe('info');
  if (runResult.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${runResult.kind}`);
  }
  expect(runResult.text).toContain('Run: turn_select_2');
  expect(runResult.text).not.toContain('turn_select_1');
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
  const result = await getGatewayAdminTools();
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

test('admin audit event type filter supports partial type-ahead matches', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { makeAuditRunId, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );

  initDatabase({ quiet: true });
  recordAuditEvent({
    sessionId: 'session-usage',
    runId: makeAuditRunId('test'),
    event: {
      type: 'usage.batch_flushed',
      sessionCount: 1,
      recordCount: 1,
    },
  });
  recordAuditEvent({
    sessionId: 'session-tool',
    runId: makeAuditRunId('test'),
    event: {
      type: 'tool.result',
      toolName: 'bash',
      isError: false,
    },
  });

  const { getGatewayAdminAudit } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const result = getGatewayAdminAudit({
    eventType: 'usage',
    limit: 10,
  });

  expect(result.eventType).toBe('usage');
  expect(result.entries.map((entry) => entry.eventType)).toEqual([
    'usage.batch_flushed',
  ]);
});

test('admin audit returns nextCursor and paginates back via the cursor', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { makeAuditRunId, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );

  initDatabase({ quiet: true });
  for (let i = 0; i < 5; i += 1) {
    recordAuditEvent({
      sessionId: 'session-pagination',
      runId: makeAuditRunId('test'),
      event: { type: 'tool.result', toolName: `t${i}`, isError: false },
    });
  }

  const { getGatewayAdminAudit } = await import(
    '../src/gateway/gateway-service.ts'
  );

  const firstPage = getGatewayAdminAudit({
    sessionId: 'session-pagination',
    limit: 2,
  });
  expect(firstPage.entries).toHaveLength(2);
  expect(firstPage.nextCursor).toBe(firstPage.entries[1]?.id);

  const secondPage = getGatewayAdminAudit({
    sessionId: 'session-pagination',
    limit: 2,
    cursor: firstPage.nextCursor ?? undefined,
  });
  expect(secondPage.entries).toHaveLength(2);
  // Cursor advances: second page's newest id < first page's oldest id.
  expect(secondPage.entries[0]?.id).toBeLessThan(firstPage.nextCursor ?? 0);
  expect(secondPage.nextCursor).toBe(secondPage.entries[1]?.id);

  const lastPage = getGatewayAdminAudit({
    sessionId: 'session-pagination',
    limit: 2,
    cursor: secondPage.nextCursor ?? undefined,
  });
  expect(lastPage.entries).toHaveLength(1);
  expect(lastPage.nextCursor).toBeNull();
  // `total` reports all matching rows on every page, regardless of page size.
  expect(firstPage.total).toBe(5);
  expect(secondPage.total).toBe(5);
  expect(lastPage.total).toBe(5);
});

test('admin audit returns nextCursor when limit equals the DB maxLimit cap', async () => {
  // Regression: queryStructuredAuditEntries has its own maxLimit (default 200)
  // that silently clamped the +1 hasMore probe back to 200, leaving nextCursor
  // permanently null at the page boundary. getGatewayAdminAudit must lift the
  // cap when paginating.
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { makeAuditRunId, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );

  initDatabase({ quiet: true });
  for (let i = 0; i < 201; i += 1) {
    recordAuditEvent({
      sessionId: 'session-boundary',
      runId: makeAuditRunId('test'),
      event: { type: 'tool.result', toolName: `t${i}`, isError: false },
    });
  }

  const { getGatewayAdminAudit } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const page = getGatewayAdminAudit({
    sessionId: 'session-boundary',
    limit: 200,
  });
  expect(page.entries).toHaveLength(200);
  expect(page.nextCursor).not.toBeNull();
  expect(page.nextCursor).toBe(page.entries[199]?.id);
});

test('admin audit since filter excludes entries before the cutoff', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { makeAuditRunId, recordAuditEvent } = await import(
    '../src/audit/audit-events.ts'
  );

  initDatabase({ quiet: true });
  recordAuditEvent({
    sessionId: 'session-since',
    runId: makeAuditRunId('test'),
    event: { type: 'tool.result', toolName: 'bash', isError: false },
  });

  const { getGatewayAdminAudit } = await import(
    '../src/gateway/gateway-service.ts'
  );

  // A cutoff in the far future excludes every just-inserted row.
  const future = getGatewayAdminAudit({
    sessionId: 'session-since',
    since: '2099-01-01T00:00:00.000Z',
    limit: 10,
  });
  expect(future.entries).toHaveLength(0);
  expect(future.since).toBe('2099-01-01T00:00:00.000Z');

  // A cutoff in the distant past includes them.
  const past = getGatewayAdminAudit({
    sessionId: 'session-since',
    since: '1970-01-01T00:00:00.000Z',
    limit: 10,
  });
  expect(past.entries).toHaveLength(1);
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
  expect(getSessionById('session-bot-set-audit')?.model).toBe(
    'hybridai/gpt-4o-mini',
  );
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

  const requestLogWarnings = logger.warn.mock.calls.filter(
    ([, message]) =>
      message === 'Ignoring invalid gateway request logging env value',
  );
  expect(requestLogWarnings).toHaveLength(1);
  expect(requestLogWarnings[0]).toEqual([
    {
      envVar: 'HYBRIDCLAW_LOG_REQUESTS',
      expectedValue: '1',
      value: 'true',
    },
    'Ignoring invalid gateway request logging env value',
  ]);

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
