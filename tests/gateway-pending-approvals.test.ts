import { afterEach, expect, test, vi } from 'vitest';

function makePrompt(approvalId: string): string {
  return [
    'I need your approval before I proceed.',
    `Approval ID: ${approvalId}`,
    'Reply `yes` to approve once.',
    'Approval expires in 60s.',
  ].join('\n');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

test('findPendingApprovalByApprovalId returns stored approvals', async () => {
  const pendingApprovals = await import('../src/gateway/pending-approvals.js');

  await pendingApprovals.setPendingApproval('session-1', {
    prompt: makePrompt('abc123'),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    userId: 'user-1',
  });

  expect(
    pendingApprovals.findPendingApprovalByApprovalId('abc123'),
  ).toMatchObject({
    sessionId: 'session-1',
    entry: {
      userId: 'user-1',
    },
  });

  await pendingApprovals.clearPendingApproval('session-1');
});

test('findPendingApprovalByApprovalId removes expired approvals during lookup', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-10T10:00:00Z'));

  const pendingApprovals = await import('../src/gateway/pending-approvals.js');
  const disableButtons = vi.fn().mockResolvedValue(undefined);

  await pendingApprovals.setPendingApproval('session-expired', {
    prompt: makePrompt('dead999'),
    createdAt: Date.now() - 120_000,
    expiresAt: Date.now() - 1,
    userId: 'user-1',
    disableButtons,
    disableTimeout: setTimeout(() => {}, 60_000),
  });

  expect(
    pendingApprovals.findPendingApprovalByApprovalId('dead999'),
  ).toBeNull();
  await Promise.resolve();

  expect(disableButtons).toHaveBeenCalledTimes(1);
  expect(pendingApprovals.getPendingApproval('session-expired')).toBeNull();
});

test('setPendingApproval disables and clears overwritten approval entries', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-10T10:00:00Z'));

  const pendingApprovals = await import('../src/gateway/pending-approvals.js');
  let originalTimerFired = false;
  const disableOriginal = vi.fn().mockResolvedValue(undefined);

  await pendingApprovals.setPendingApproval('session-2', {
    prompt: makePrompt('abc124'),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    userId: 'user-1',
    disableButtons: disableOriginal,
    disableTimeout: setTimeout(() => {
      originalTimerFired = true;
    }, 1_000),
  });

  await pendingApprovals.setPendingApproval('session-2', {
    prompt: makePrompt('def456'),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    userId: 'user-1',
  });

  vi.advanceTimersByTime(1_000);

  expect(disableOriginal).toHaveBeenCalledTimes(1);
  expect(originalTimerFired).toBe(false);
  expect(pendingApprovals.findPendingApprovalByApprovalId('abc124')).toBeNull();
  expect(
    pendingApprovals.findPendingApprovalByApprovalId('def456'),
  ).toMatchObject({
    sessionId: 'session-2',
  });

  await pendingApprovals.clearPendingApproval('session-2');
});

test('cleanupExpiredPendingApprovals removes expired entries and disables buttons', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-10T10:00:00Z'));

  const pendingApprovals = await import('../src/gateway/pending-approvals.js');
  const disableButtons = vi.fn().mockResolvedValue(undefined);

  await pendingApprovals.setPendingApproval('session-3', {
    prompt: makePrompt('expire03'),
    createdAt: Date.now() - 120_000,
    expiresAt: Date.now() - 1,
    userId: 'user-1',
    disableButtons,
    disableTimeout: setTimeout(() => {}, 60_000),
  });

  await pendingApprovals.cleanupExpiredPendingApprovals();

  expect(disableButtons).toHaveBeenCalledTimes(1);
  expect(pendingApprovals.getPendingApproval('session-3')).toBeNull();
});
