import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-audit-events-'));
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
});

test('does not emit approval events for auto-approved read-only tools', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, getRecentStructuredAuditForSession } = await import(
    '../src/memory/db.ts'
  );
  const { emitToolExecutionAuditEvents } = await import(
    '../src/audit/audit-events.ts'
  );

  initDatabase({ quiet: true });
  emitToolExecutionAuditEvents({
    sessionId: 'session-auto-read',
    runId: 'run-auto-read',
    toolExecutions: [
      {
        name: 'read',
        arguments: '{"path":"skills/apple-music/SKILL.md"}',
        result: 'ok',
        durationMs: 3,
        isError: false,
        blocked: false,
        approvalTier: 'green',
        approvalBaseTier: 'green',
        approvalDecision: 'auto',
        approvalActionKey: 'read',
        approvalReason: 'this is a read-only operation',
      },
    ],
  });

  const events = getRecentStructuredAuditForSession('session-auto-read', 10);
  expect(events.map((event) => event.event_type)).toEqual([
    'tool.result',
    'authorization.check',
    'tool.call',
  ]);
});

test('emits approval request and response events for pending red actions', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, getRecentStructuredAuditForSession } = await import(
    '../src/memory/db.ts'
  );
  const { emitToolExecutionAuditEvents } = await import(
    '../src/audit/audit-events.ts'
  );

  initDatabase({ quiet: true });
  emitToolExecutionAuditEvents({
    sessionId: 'session-red-pending',
    runId: 'run-red-pending',
    toolExecutions: [
      {
        name: 'bash',
        arguments: '{"command":"open -a Music"}',
        result:
          'I need your approval before I run shell command `open -a Music`.',
        durationMs: 8,
        isError: false,
        blocked: true,
        blockedReason: 'this command may change local state',
        approvalTier: 'red',
        approvalBaseTier: 'red',
        approvalDecision: 'required',
        approvalActionKey: 'bash:other',
        approvalReason: 'this command may change local state',
        approvalRequestId: 'approve123',
      },
    ],
  });

  const events = getRecentStructuredAuditForSession('session-red-pending', 10);
  expect(events.map((event) => event.event_type)).toEqual([
    'tool.result',
    'approval.response',
    'approval.request',
    'authorization.check',
    'tool.call',
  ]);
});

test('emits Browser Use session and cost audit events for browser_agent_task', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, getRecentStructuredAuditForSession } = await import(
    '../src/memory/db.ts'
  );
  const { emitToolExecutionAuditEvents } = await import(
    '../src/audit/audit-events.ts'
  );

  initDatabase({ quiet: true });
  emitToolExecutionAuditEvents({
    sessionId: 'session-browser-use-audit',
    runId: 'run-browser-use-audit',
    toolExecutions: [
      {
        name: 'browser_agent_task',
        arguments:
          '{"task":"Extract account balances","output_schema":{"type":"object"}}',
        result: JSON.stringify({
          execution_strategy: 'cloud-agent',
          session_id: 'browser-use-session-123',
          status: 'idle',
          is_task_successful: true,
          step_count: 4,
          llm_cost_usd: '0.12',
          proxy_cost_usd: '0.02',
          browser_cost_usd: '0.03',
          total_cost_usd: '0.17',
          total_input_tokens: 345,
          total_output_tokens: 67,
          profile_id: 'profile-123',
          workspace_id: 'workspace-123',
          live_url: 'https://browser-use.example/live/session-123',
          recording_paths: [
            '.browser-artifacts/recordings/session-session-browser-use-audit-1.mp4',
          ],
        }),
        durationMs: 1578,
        isError: false,
        blocked: false,
        approvalTier: 'green',
        approvalBaseTier: 'green',
        approvalDecision: 'auto',
      },
    ],
  });

  const events = getRecentStructuredAuditForSession(
    'session-browser-use-audit',
    10,
  );
  const sessionEvent = events.find(
    (event) => event.event_type === 'browser.session',
  );
  const agentTaskEvent = events.find(
    (event) => event.event_type === 'browser.agent_task',
  );

  expect(sessionEvent).toBeDefined();
  expect(agentTaskEvent).toBeDefined();
  expect(sessionEvent ? JSON.parse(sessionEvent.payload) : null).toMatchObject({
    type: 'browser.session',
    executionStrategy: 'cloud-agent',
    cloudSessionId: 'browser-use-session-123',
    toolName: 'browser_agent_task',
  });
  expect(
    sessionEvent ? JSON.parse(sessionEvent.payload) : null,
  ).not.toHaveProperty('liveUrl');
  expect(
    agentTaskEvent ? JSON.parse(agentTaskEvent.payload) : null,
  ).toMatchObject({
    type: 'browser.agent_task',
    sessionId: 'browser-use-session-123',
    status: 'idle',
    executionStrategy: 'cloud-agent',
    isTaskSuccessful: true,
    stepCount: 4,
    llmCostUsd: '0.12',
    totalCostUsd: '0.17',
    totalInputTokens: 345,
    totalOutputTokens: 67,
    profileId: 'profile-123',
    workspaceId: 'workspace-123',
    recordingCount: 1,
  });
  expect(
    agentTaskEvent ? JSON.parse(agentTaskEvent.payload) : null,
  ).not.toHaveProperty('liveUrl');
  const toolResultEvent = events.find(
    (event) => event.event_type === 'tool.result',
  );
  expect(
    toolResultEvent ? JSON.parse(toolResultEvent.payload) : null,
  ).toMatchObject({
    resultSummary: expect.not.stringContaining(
      'https://browser-use.example/live/session-123',
    ),
  });
});
