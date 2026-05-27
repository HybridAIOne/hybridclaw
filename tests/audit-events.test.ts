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
    'autonomy.decision',
    'authorization.check',
    'tool.call',
  ]);
  expect(JSON.parse(events[0].payload)).toEqual(
    expect.objectContaining({
      type: 'tool.result',
      resultSummary: 'ok',
      resultPreview: 'ok',
    }),
  );
  expect(JSON.parse(events[1].payload)).toEqual(
    expect.objectContaining({
      type: 'autonomy.decision',
      autonomyLevel: 'full-autonomous',
      stakes: 'low',
      escalationRoute: 'none',
      approvalDecision: 'auto',
    }),
  );
});

test('reads recent structured audit rows for multiple sessions with a per-session cap', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const {
    getRecentStructuredAuditForSessions,
    initDatabase,
    logStructuredAuditEvent,
  } = await import('../src/memory/db.ts');

  initDatabase({ quiet: true });
  for (const sessionId of ['session-a', 'session-b']) {
    for (let seq = 1; seq <= 3; seq += 1) {
      logStructuredAuditEvent({
        version: '2.0',
        seq,
        timestamp: `2026-04-29T12:0${seq}:00.000Z`,
        runId: `${sessionId}-run-${seq}`,
        sessionId,
        event: {
          type: seq === 3 ? 'error' : 'tool.result',
        },
        _prevHash: `prev-${sessionId}-${seq}`,
        _hash: `hash-${sessionId}-${seq}`,
      });
    }
  }

  const events = getRecentStructuredAuditForSessions(
    ['session-a', 'session-b'],
    2,
  );

  expect(events).toHaveLength(4);
  expect(
    events.filter((event) => event.session_id === 'session-a'),
  ).toHaveLength(2);
  expect(
    events.filter((event) => event.session_id === 'session-b'),
  ).toHaveLength(2);
  expect(events.map((event) => event.seq)).toEqual([3, 2, 3, 2]);
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
        autonomyLevel: 'full-autonomous',
        stakes: 'high',
        escalationRoute: 'approval_request',
        escalationTarget: {
          channel: 'slack:COPS',
          recipient: 'ops-lead',
        },
        approvalDecision: 'required',
        approvalActionKey: 'bash:other',
        approvalIntent: 'run shell command `open -a Music`',
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
    'escalation.decision',
    'autonomy.decision',
    'authorization.check',
    'tool.call',
  ]);
  const escalationEvent = events.find(
    (event) => event.event_type === 'escalation.decision',
  );
  expect(JSON.parse(escalationEvent?.payload || '{}')).toEqual(
    expect.objectContaining({
      type: 'escalation.decision',
      proposedAction: 'run shell command `open -a Music`',
      escalationRoute: 'approval_request',
      target: {
        channel: 'slack:COPS',
        recipient: 'ops-lead',
      },
      classifier: null,
      classifierReasoning: [],
    }),
  );
});

test('tool result audit stores a redacted truncated preview beyond the summary', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { getRecentStructuredAuditForSession, initDatabase } = await import(
    '../src/memory/db.ts'
  );
  const { emitToolExecutionAuditEvents } = await import(
    '../src/audit/audit-events.ts'
  );

  initDatabase({ quiet: true });
  emitToolExecutionAuditEvents({
    sessionId: 'session-result-preview',
    runId: 'run-result-preview',
    toolExecutions: [
      {
        name: 'bash',
        arguments: '{"command":"node script.js"}',
        result: [
          'prefix sk-test-ABCDEFGHIJKLMNOP1234567890',
          'https://example.com/callback?token=opaque-query-token',
          'unknown Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1',
          'x'.repeat(5000),
        ].join(' '),
        durationMs: 10,
        isError: false,
      },
    ],
  });

  const result = getRecentStructuredAuditForSession(
    'session-result-preview',
    10,
  ).find((event) => event.event_type === 'tool.result');
  const payload = JSON.parse(result?.payload || '{}') as Record<string, string>;
  expect(payload.resultSummary.length).toBeLessThanOrEqual(283);
  expect(payload.resultPreview.length).toBeGreaterThan(
    payload.resultSummary.length,
  );
  expect(payload.resultPreview.length).toBeLessThanOrEqual(4003);
  expect(payload.resultPreview).not.toContain(
    'sk-test-ABCDEFGHIJKLMNOP1234567890',
  );
  expect(payload.resultPreview).toContain('token=***REDACTED***');
  expect(payload.resultPreview).toContain('***HIGH_ENTROPY_SECRET_REDACTED***');
});

test('autonomy audit falls back to internally consistent approval metadata', async () => {
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
    sessionId: 'session-autonomy-fallback',
    runId: 'run-autonomy-fallback',
    toolExecutions: [
      {
        name: 'bash',
        arguments: '{"command":"touch out.txt"}',
        result: 'blocked',
        durationMs: 4,
        blocked: true,
        blockedReason: 'blocked by security hook',
        approvalTier: 'yellow',
        approvalDecision: 'denied',
      },
    ],
  });

  const events = getRecentStructuredAuditForSession(
    'session-autonomy-fallback',
    10,
  );
  const autonomyEvent = events.find(
    (event) => event.event_type === 'autonomy.decision',
  );
  expect(autonomyEvent).toBeDefined();
  const autonomy = JSON.parse(autonomyEvent?.payload || '{}');
  expect(autonomy).toEqual(
    expect.objectContaining({
      type: 'autonomy.decision',
      escalationRoute: 'policy_denial',
      approvalTier: 'yellow',
      approvalBaseTier: 'yellow',
      approvalDecision: 'denied',
      reason: 'blocked by security hook',
    }),
  );
});

test('weekly agent anomaly rollups count flagged and confirmed-normal tool checks', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const {
    getOrCreateSession,
    getRecentStructuredAuditForSession,
    getWeeklyAgentAnomalyRollups,
    initDatabase,
  } = await import('../src/memory/db.ts');
  const { emitToolExecutionAuditEvents } = await import(
    '../src/audit/audit-events.ts'
  );

  initDatabase({ quiet: true });
  getOrCreateSession('session-anomaly-rollup', null, 'channel-a', 'lena');
  emitToolExecutionAuditEvents({
    sessionId: 'session-anomaly-rollup',
    runId: 'run-anomaly-rollup',
    toolExecutions: [
      {
        name: 'read',
        arguments: '{"path":"README.md"}',
        result: 'ok',
        durationMs: 3,
        approvalTier: 'yellow',
        approvalBaseTier: 'yellow',
        approvalDecision: 'implicit',
        approvalActionKey: 'read',
        anomaly: {
          score: 0.96,
          threshold: 0.9,
          reason:
            'behavior anomaly score 0.960 exceeds adaptive threshold 0.900',
          status: 'scored',
          model: 'order2_markov_frequency_v1',
          trajectoryCount: 80,
          tuple: 'read',
        },
      },
    ],
  });

  expect(
    getWeeklyAgentAnomalyRollups(new Date()).find(
      (rollup) => rollup.agent_id === 'lena',
    ),
  ).toEqual({
    agent_id: 'lena',
    flagged: 1,
    confirmed_normal: 1,
  });

  const autonomyEvent = getRecentStructuredAuditForSession(
    'session-anomaly-rollup',
    10,
  ).find((event) => event.event_type === 'autonomy.decision');
  expect(JSON.parse(autonomyEvent?.payload || '{}').anomaly).toEqual(
    expect.objectContaining({
      tuple: 'read',
    }),
  );
});

test('weekly agent anomaly rollups scan the full UTC week without row cap', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const {
    getOrCreateSession,
    getWeeklyAgentAnomalyRollups,
    initDatabase,
    logStructuredAuditEvent,
  } = await import('../src/memory/db.ts');

  initDatabase({ quiet: true });
  getOrCreateSession('session-anomaly-cap', null, 'channel-a', 'lena');

  logStructuredAuditEvent({
    version: '2.0',
    seq: 1,
    timestamp: '2026-05-04T00:00:00.000Z',
    runId: 'run-anomaly-cap-flagged',
    sessionId: 'session-anomaly-cap',
    event: {
      type: 'autonomy.decision',
      approvalDecision: 'implicit',
      anomaly: {
        score: 0.96,
        threshold: 0.9,
      },
    },
    _prevHash: 'prev-flagged',
    _hash: 'hash-flagged',
  });

  for (let index = 0; index < 10_000; index += 1) {
    logStructuredAuditEvent({
      version: '2.0',
      seq: index + 2,
      timestamp: '2026-05-08T12:00:00.000Z',
      runId: `run-anomaly-cap-benign-${index}`,
      sessionId: 'session-anomaly-cap',
      event: {
        type: 'autonomy.decision',
        approvalDecision: 'auto',
      },
      _prevHash: `prev-benign-${index}`,
      _hash: `hash-benign-${index}`,
    });
  }

  expect(
    getWeeklyAgentAnomalyRollups(new Date('2026-05-09T12:00:00.000Z')).find(
      (rollup) => rollup.agent_id === 'lena',
    ),
  ).toEqual({
    agent_id: 'lena',
    flagged: 1,
    confirmed_normal: 1,
  });
});
