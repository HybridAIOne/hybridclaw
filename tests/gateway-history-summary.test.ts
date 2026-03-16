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

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test('getGatewayHistorySummary reports windowed usage, tools, and file changes', async () => {
  process.env.HOME = makeTempHome();
  vi.resetModules();

  const { initDatabase, recordUsageEvent } = await import(
    '../src/memory/db.ts'
  );
  const { emitToolExecutionAuditEvents, makeAuditRunId } = await import(
    '../src/audit/audit-events.ts'
  );
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
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
  const workspacePath = agentWorkspaceDir(session.agent_id);
  fs.mkdirSync(workspacePath, { recursive: true });

  const modifiedFilePath = path.join(workspacePath, 'existing.txt');
  fs.writeFileSync(modifiedFilePath, 'before\n', 'utf8');

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
    ],
  });

  await wait(25);
  const sinceMs = Date.now();
  await wait(25);

  fs.appendFileSync(modifiedFilePath, 'after\n', 'utf8');
  const modifiedAt = new Date(sinceMs + 1_000);
  fs.utimesSync(modifiedFilePath, modifiedAt, modifiedAt);

  const createdFilePath = path.join(workspacePath, 'created.txt');
  fs.writeFileSync(createdFilePath, 'new\n', 'utf8');

  recordUsageEvent({
    sessionId: session.id,
    agentId: session.agent_id,
    model: 'gpt-5',
    inputTokens: 12_847,
    outputTokens: 8_203,
    toolCalls: 3,
    costUsd: 0.42,
    timestamp: new Date(sinceMs + 2_000).toISOString(),
  });
  emitToolExecutionAuditEvents({
    sessionId: session.id,
    runId: makeAuditRunId('after'),
    toolExecutions: [
      {
        name: 'edit',
        arguments: '{}',
        result: 'ok',
        durationMs: 12,
      },
      {
        name: 'edit',
        arguments: '{}',
        result: 'ok',
        durationMs: 15,
      },
      {
        name: 'read',
        arguments: '{}',
        result: 'ok',
        durationMs: 8,
      },
    ],
  });

  expect(getGatewayHistorySummary(session.id, { sinceMs })).toEqual({
    messageCount: 2,
    userMessageCount: 1,
    toolCallCount: 3,
    inputTokenCount: 12_847,
    outputTokenCount: 8_203,
    costUsd: 0.42,
    toolBreakdown: [
      { toolName: 'edit', count: 2 },
      { toolName: 'read', count: 1 },
    ],
    fileChanges: {
      modifiedCount: 1,
      createdCount: 1,
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
      modifiedCount: 0,
      createdCount: 0,
    },
  });
});
