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
