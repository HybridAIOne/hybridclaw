import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-gateway-history-'),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getGatewayHistorySummary reports windowed usage, tools, and file changes', async () => {
  process.env.HOME = makeTempHome();
  vi.resetModules();

  const { initDatabase, recordUsageEvent } = await import(
    '../src/memory/db.ts'
  );
  const { emitToolExecutionAuditEvents, makeAuditRunId } = await import(
    '../src/audit/audit-events.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { getGatewayHistorySummary } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const session = memoryService.getOrCreateSession(
    'cli-session-1',
    null,
    'tui',
  );
  memoryService.storeTurn({
    sessionId: session.id,
    user: {
      userId: 'user-1',
      username: 'user',
      content: 'hello',
    },
    assistant: {
      content: 'world',
    },
  });

  recordUsageEvent({
    sessionId: session.id,
    agentId: session.agent_id,
    model: 'gpt-5',
    inputTokens: 999,
    outputTokens: 111,
    toolCalls: 4,
    costUsd: 0.99,
  });
  emitToolExecutionAuditEvents({
    sessionId: session.id,
    runId: makeAuditRunId('before'),
    toolExecutions: [
      {
        name: 'bash',
        arguments: '{}',
        result: 'ok',
        durationMs: 10,
      },
      {
        name: 'delete',
        arguments: '{"path":"stale.txt"}',
        result: 'approval required',
        durationMs: 9,
        blocked: true,
      },
    ],
  });

  const sinceMs = Date.now();

  recordUsageEvent({
    sessionId: session.id,
    agentId: session.agent_id,
    model: 'gpt-5',
    inputTokens: 12_847,
    outputTokens: 8_203,
    toolCalls: 4,
    costUsd: 0.42,
    timestamp: new Date(sinceMs + 2_000).toISOString(),
  });
  emitToolExecutionAuditEvents({
    sessionId: session.id,
    runId: makeAuditRunId('after'),
    toolExecutions: [
      {
        name: 'edit',
        arguments: '{"path":"existing.txt","old":"a","new":"b"}',
        result: 'ok',
        durationMs: 12,
      },
      {
        name: 'write',
        arguments: '{"path":"created.txt","contents":"hello"}',
        result: 'ok',
        durationMs: 15,
      },
      {
        name: 'read',
        arguments: '{"path":"existing.txt"}',
        result: 'ok',
        durationMs: 8,
      },
      {
        name: 'delete',
        arguments: '{"path":"stale.txt"}',
        result: 'ok',
        durationMs: 6,
      },
    ],
  });

  expect(getGatewayHistorySummary(session.id, { sinceMs })).toEqual({
    messageCount: 2,
    userMessageCount: 1,
    toolCallCount: 4,
    inputTokenCount: 12_847,
    outputTokenCount: 8_203,
    costUsd: 0.42,
    toolBreakdown: [
      { toolName: 'delete', count: 1 },
      { toolName: 'edit', count: 1 },
      { toolName: 'read', count: 1 },
      { toolName: 'write', count: 1 },
    ],
    fileChanges: {
      readCount: 1,
      modifiedCount: 1,
      createdCount: 1,
      deletedCount: 1,
    },
  });
});

test('getGatewayHistorySummary returns zero counts for unknown sessions', async () => {
  process.env.HOME = makeTempHome();
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getGatewayHistorySummary } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  expect(getGatewayHistorySummary('missing-session')).toEqual({
    messageCount: 0,
    userMessageCount: 0,
    toolCallCount: 0,
    inputTokenCount: 0,
    outputTokenCount: 0,
    costUsd: 0,
    toolBreakdown: [],
    fileChanges: {
      readCount: 0,
      modifiedCount: 0,
      createdCount: 0,
      deletedCount: 0,
    },
  });
});

test('getGatewayHistorySummary accepts canonical session keys and preserves tool/file summaries', async () => {
  process.env.HOME = makeTempHome();
  vi.resetModules();

  const { initDatabase, recordUsageEvent } = await import(
    '../src/memory/db.ts'
  );
  const { emitToolExecutionAuditEvents, makeAuditRunId } = await import(
    '../src/audit/audit-events.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { getGatewayHistorySummary } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });

  const session = memoryService.getOrCreateSession(
    'agent:main:channel:tui:chat:dm:peer:test-key',
    null,
    'tui',
  );
  const sinceMs = Date.now();

  recordUsageEvent({
    sessionId: session.id,
    agentId: session.agent_id,
    model: 'gpt-5',
    inputTokens: 123,
    outputTokens: 45,
    toolCalls: 2,
    costUsd: 0.01,
    timestamp: new Date(sinceMs + 2_000).toISOString(),
  });
  emitToolExecutionAuditEvents({
    sessionId: session.id,
    runId: makeAuditRunId('after'),
    toolExecutions: [
      {
        name: 'read',
        arguments: '{"path":"existing.txt"}',
        result: 'ok',
        durationMs: 8,
      },
      {
        name: 'edit',
        arguments: '{"path":"existing.txt","old":"a","new":"b"}',
        result: 'ok',
        durationMs: 12,
      },
    ],
  });

  expect(
    getGatewayHistorySummary(session.session_key || session.id, { sinceMs }),
  ).toEqual({
    messageCount: 0,
    userMessageCount: 0,
    toolCallCount: 2,
    inputTokenCount: 123,
    outputTokenCount: 45,
    costUsd: 0.01,
    toolBreakdown: [
      { toolName: 'edit', count: 1 },
      { toolName: 'read', count: 1 },
    ],
    fileChanges: {
      readCount: 1,
      modifiedCount: 1,
      createdCount: 0,
      deletedCount: 0,
    },
  });
});
