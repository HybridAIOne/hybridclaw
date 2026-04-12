import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

test('findPendingApprovalByApprovalId returns stored approvals', async () => {
  const pendingApprovals = await import('../src/gateway/pending-approvals.js');

  await pendingApprovals.setPendingApproval('session-1', {
    approvalId: 'abc123',
    prompt: 'I need your approval before I proceed.',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    userId: 'user-1',
    resolvedAt: null,
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
    approvalId: 'dead999',
    prompt: 'expired approval',
    createdAt: Date.now() - 120_000,
    expiresAt: Date.now() - 1,
    userId: 'user-1',
    resolvedAt: null,
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
    approvalId: 'abc124',
    prompt: 'first approval',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    userId: 'user-1',
    resolvedAt: null,
    disableButtons: disableOriginal,
    disableTimeout: setTimeout(() => {
      originalTimerFired = true;
    }, 1_000),
  });

  await pendingApprovals.setPendingApproval('session-2', {
    approvalId: 'def456',
    prompt: 'second approval',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    userId: 'user-1',
    resolvedAt: null,
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
    approvalId: 'expire03',
    prompt: 'expired approval',
    createdAt: Date.now() - 120_000,
    expiresAt: Date.now() - 1,
    userId: 'user-1',
    resolvedAt: null,
    disableButtons,
    disableTimeout: setTimeout(() => {}, 60_000),
  });

  await pendingApprovals.cleanupExpiredPendingApprovals();

  expect(disableButtons).toHaveBeenCalledTimes(1);
  expect(pendingApprovals.getPendingApproval('session-3')).toBeNull();
});

test('claimPendingApprovalByApprovalId marks an approval handled after first claim', async () => {
  const pendingApprovals = await import('../src/gateway/pending-approvals.js');

  await pendingApprovals.setPendingApproval('session-4', {
    approvalId: 'claim44',
    prompt: 'claim me once',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    userId: 'user-1',
    resolvedAt: null,
  });

  expect(
    pendingApprovals.claimPendingApprovalByApprovalId({
      approvalId: 'claim44',
      userId: 'user-1',
    }),
  ).toMatchObject({
    status: 'claimed',
    sessionId: 'session-4',
  });

  expect(
    pendingApprovals.claimPendingApprovalByApprovalId({
      approvalId: 'claim44',
      userId: 'user-1',
    }),
  ).toMatchObject({
    status: 'already_handled',
    sessionId: 'session-4',
  });

  await pendingApprovals.clearPendingApproval('session-4');
});

test('claimPendingApprovalByApprovalId leaves approvals unresolved for wrong users', async () => {
  const pendingApprovals = await import('../src/gateway/pending-approvals.js');

  await pendingApprovals.setPendingApproval('session-5', {
    approvalId: 'claim55',
    prompt: 'claim me correctly',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    userId: 'owner-1',
    resolvedAt: null,
  });

  expect(
    pendingApprovals.claimPendingApprovalByApprovalId({
      approvalId: 'claim55',
      userId: 'other-user',
    }),
  ).toMatchObject({
    status: 'unauthorized',
    sessionId: 'session-5',
  });

  expect(
    pendingApprovals.claimPendingApprovalByApprovalId({
      approvalId: 'claim55',
      userId: 'owner-1',
    }),
  ).toMatchObject({
    status: 'claimed',
    sessionId: 'session-5',
  });

  await pendingApprovals.clearPendingApproval('session-5');
});

test('rollbackPendingApprovalClaim reopens a claimed approval for retry', async () => {
  const pendingApprovals = await import('../src/gateway/pending-approvals.js');

  await pendingApprovals.setPendingApproval('session-6', {
    approvalId: 'claim66',
    prompt: 'claim me then retry',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    userId: 'user-1',
    resolvedAt: null,
  });

  expect(
    pendingApprovals.claimPendingApprovalByApprovalId({
      approvalId: 'claim66',
      userId: 'user-1',
    }),
  ).toMatchObject({
    status: 'claimed',
    sessionId: 'session-6',
  });

  expect(
    pendingApprovals.rollbackPendingApprovalClaim({
      sessionId: 'session-6',
      approvalId: 'claim66',
    }),
  ).toBe(true);

  expect(
    pendingApprovals.claimPendingApprovalByApprovalId({
      approvalId: 'claim66',
      userId: 'user-1',
    }),
  ).toMatchObject({
    status: 'claimed',
    sessionId: 'session-6',
  });

  await pendingApprovals.clearPendingApproval('session-6');
});
