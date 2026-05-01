import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const originalDataDir = process.env.HYBRIDCLAW_DATA_DIR;
let tmpDir: string | null = null;

async function importInteractiveEscalation(options?: {
  agents?: unknown[];
  enqueueProactiveMessage?: ReturnType<typeof vi.fn>;
}) {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-interactive-escalation-'),
  );
  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  vi.resetModules();
  vi.doMock('../src/audit/audit-events.js', () => ({
    makeAuditRunId: (prefix: string) => `${prefix}-run`,
    recordAuditEvent: vi.fn(),
  }));
  if (options?.agents) {
    vi.doMock('../src/agents/agent-registry.js', () => ({
      listAgents: () => options.agents,
    }));
  }
  if (options?.enqueueProactiveMessage) {
    vi.doMock('../src/memory/db.js', () => ({
      enqueueProactiveMessage: options.enqueueProactiveMessage,
    }));
  }
  return import('../src/gateway/interactive-escalation.js');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../src/audit/audit-events.js');
  vi.doUnmock('../src/agents/agent-registry.js');
  vi.doUnmock('../src/memory/db.js');
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
  if (originalDataDir) {
    process.env.HYBRIDCLAW_DATA_DIR = originalDataDir;
  } else {
    delete process.env.HYBRIDCLAW_DATA_DIR;
  }
});

test('detectTwoFactorChallenge recognizes selector and page text signals', async () => {
  const escalation = await importInteractiveEscalation();

  expect(
    escalation.detectTwoFactorChallenge({
      title: 'Verification code required',
      text: 'Enter the code from your authenticator app.',
      selectors: ['input[autocomplete="one-time-code"]'],
    }),
  ).toEqual({
    detected: true,
    modality: 'totp',
    signals: ['selector:input[autocomplete="one-time-code"]', 'totp text'],
  });
});

test('parseOperatorReturnText handles code and approval replies', async () => {
  const escalation = await importInteractiveEscalation();

  expect(escalation.parseOperatorReturnText('123 456', ['code'])).toEqual({
    kind: 'code',
    value: '123456',
  });
  expect(
    escalation.parseOperatorReturnText('approved', ['approved', 'declined']),
  ).toEqual({ kind: 'approved' });
  expect(
    escalation.parseOperatorReturnText('deny: wrong account', ['declined']),
  ).toEqual({
    kind: 'declined',
    reason: 'wrong account',
  });
});

test('suspended sessions persist, rehydrate, and redact code responses', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-30T12:00:00Z'));
  const escalation = await importInteractiveEscalation();

  const created = escalation.createSuspendedSession({
    sessionId: 'session-2fa',
    approvalId: 'approval-2fa',
    prompt: 'Enter the SMS verification code.',
    userId: 'operator-1',
    modality: 'sms',
    ttlMs: 600_000,
    frameSnapshot: {
      url: 'https://sap.example/login',
      title: 'Verify sign in',
      screenshotRef: 'artifact://shot-1',
    },
    context: {
      host: 'sap.example',
      pageTitle: 'Verify sign in',
      screenshotRef: 'artifact://shot-1',
    },
  });

  expect(created.expectedReturnKinds).toEqual(['code', 'declined', 'timeout']);
  expect(escalation.listSuspendedSessions()).toHaveLength(1);

  vi.resetModules();
  const reloaded = await import('../src/gateway/interactive-escalation.js');
  expect(reloaded.getSuspendedSession('session-2fa')).toMatchObject({
    approvalId: 'approval-2fa',
    modality: 'sms',
    status: 'pending',
  });

  const resumed = reloaded.resumeWith('session-2fa', {
    kind: 'code',
    value: '123456',
  });
  expect(resumed).toMatchObject({
    status: 'resumed',
    response: { kind: 'code', valueRedacted: true },
  });
  expect(JSON.stringify(resumed)).not.toContain('123456');
  expect(reloaded.consumeOperatorReturn('session-2fa')).toEqual({
    kind: 'code',
    value: '123456',
  });
  expect(reloaded.consumeOperatorReturn('session-2fa')).toBeNull();
});

test('emitInteractionNeededEvent records typed F14 payload with routing hints', async () => {
  const escalation = await importInteractiveEscalation();
  const session = escalation.awaitTwoFactor({
    sessionId: 'session-push',
    approvalId: 'approval-push',
    prompt: 'Approve the sign-in push.',
    userId: 'operator-1',
    modality: 'push',
    frameSnapshot: { url: 'https://datev.example/login' },
    context: { host: 'datev.example' },
    escalationTarget: { channel: 'sms', recipient: 'operator-1' },
  });
  const recordAudit = vi.fn();

  escalation.emitInteractionNeededEvent({
    session,
    runId: 'run-1',
    recordAudit,
  });

  expect(recordAudit).toHaveBeenCalledWith({
    sessionId: 'session-push',
    runId: 'run-1',
    event: expect.objectContaining({
      type: 'escalation.interaction_needed',
      approvalId: 'approval-push',
      modality: 'push',
      expectedReturnKinds: ['approved', 'declined', 'timeout'],
      routing: expect.objectContaining({
        preferredChannels: ['push', 'mobile_admin'],
        fallbackChannels: ['push', 'mobile_admin', 'sms', 'email'],
      }),
    }),
  });
});

test('expired sessions queue F10 manager timeout escalation when configured', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-30T12:00:00Z'));
  const enqueueProactiveMessage = vi.fn(() => ({ queued: 1, dropped: 0 }));
  const escalation = await importInteractiveEscalation({
    agents: [
      { id: 'worker', reportsTo: 'manager' },
      {
        id: 'manager',
        escalationTarget: { channel: 'tui', recipient: 'lead' },
      },
    ],
    enqueueProactiveMessage,
  });

  escalation.createSuspendedSession({
    sessionId: 'session-timeout',
    approvalId: 'approval-timeout',
    prompt: 'Approve the push challenge.',
    userId: 'operator-1',
    agentId: 'worker',
    modality: 'push',
    expiresAt: Date.now() + 60_000,
    frameSnapshot: { url: 'https://sap.example/login' },
    context: { host: 'sap.example' },
  });

  vi.setSystemTime(new Date('2026-04-30T12:01:01Z'));
  expect(escalation.listSuspendedSessions()).toEqual([]);
  expect(enqueueProactiveMessage).toHaveBeenCalledWith(
    'tui',
    expect.stringContaining('Timeout escalation: push handover'),
    'interactive-escalation:timeout',
    100,
  );
  expect(escalation.getSuspendedSession('session-timeout')).toMatchObject({
    status: 'expired',
    response: { kind: 'timeout' },
  });
});
