import { beforeEach, expect, test, vi } from 'vitest';

const durable = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/config/runtime-config-revisions.js', () => ({
  listRuntimeAssetRevisionStates: () => [...durable].map(([assetPath, content]) => ({ assetPath, content })),
  syncRuntimeAssetRevisionState: (_kind: string, assetPath: string, _actor: unknown, state: { content: string | null }) => {
    if (state.content === null) durable.delete(assetPath);
    else durable.set(assetPath, state.content);
  },
}));
beforeEach(() => { durable.clear(); vi.resetModules(); });
function prompt(approvalId: string) {
  return { approvalId, prompt: 'Review this action.', createdAt: Date.now(), expiresAt: Date.now() + 60_000, userId: 'user-a' };
}

test('replacement is durable before cleanup, and slow cleanup cannot overwrite a newer prompt', async () => {
  const store = await import('../src/gateway/pending-approvals.js');
  let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  await store.setPendingApproval('session-a', { ...prompt('old'), disableButtons: () => cleanup });
  const replacement = store.setPendingApproval('session-a', prompt('replacement'));
  const visibleDuringCleanup = store.getPendingApproval('session-a')?.approvalId;
  const durableDuringCleanup = JSON.parse([...durable.values()][0] || '{}').approvalId;
  await store.setPendingApproval('session-a', prompt('newest'));
  release();
  await replacement;
  expect(visibleDuringCleanup).toBe('replacement');
  expect(durableDuringCleanup).toBe('replacement');
  expect(store.getPendingApproval('session-a')?.approvalId).toBe('newest');
});

test('simultaneous channel responses have one claim winner', async () => {
  const store = await import('../src/gateway/pending-approvals.js');
  await store.setPendingApproval('session-a', prompt('approval-a'));
  const results = await Promise.all(['discord', 'slack'].map(async () => store.claimPendingApprovalByApprovalId({ approvalId: 'approval-a', userId: 'user-a' })));
  expect(results.map(result => result.status).sort()).toEqual(['already_handled', 'claimed']);
});

test('old expiry and rollback cannot affect a replacement, even with the same approval ID', async () => {
  vi.useFakeTimers();
  try {
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const store = await import('../src/gateway/pending-approvals.js');
    await store.rememberPendingApproval({ sessionId: 'session-a', approvalId: 'same', prompt: 'Review.', userId: 'user-a', expiresAt: Date.now() + 60_000 });
    const oldExpiry = timeout.mock.calls.at(-1)![0] as () => void;
    const first = store.claimPendingApprovalByApprovalId({ sessionId: 'session-a', approvalId: 'same', userId: 'user-a' });
    if (first.status !== 'claimed') throw new Error('missing claim');
    await store.setPendingApproval('session-a', prompt('same'));
    const replacement = store.getPendingApproval('session-a');
    vi.advanceTimersByTime(60_001);
    oldExpiry();
    expect(store.rollbackPendingApprovalClaim(first.claim)).toBe(false);
    expect(store.handoffPendingApprovalClaim(first.claim)).toBe(false);
    await store.clearPendingApproval('session-a', first.claim);
    expect(store.getPendingApproval('session-a')).toBe(replacement);
  } finally { vi.useRealTimers(); }
});

test('rollback rotates identity and cannot roll back a later claim', async () => {
  const store = await import('../src/gateway/pending-approvals.js');
  await store.setPendingApproval('session-a', prompt('approval-a'));
  const first = store.claimPendingApprovalByApprovalId({ approvalId: 'approval-a', userId: 'user-a' });
  if (first.status !== 'claimed') throw new Error('missing claim');
  expect(store.rollbackPendingApprovalClaim(first.claim)).toBe(true);
  const second = store.claimPendingApprovalByApprovalId({ approvalId: 'approval-a', userId: 'user-a' });
  if (second.status !== 'claimed') throw new Error('missing claim');
  expect(store.rollbackPendingApprovalClaim(first.claim)).toBe(false);
  expect(store.handoffPendingApprovalClaim(second.claim)).toBe(true);
  expect(store.rollbackPendingApprovalClaim(second.claim)).toBe(false);
  expect(JSON.parse([...durable.values()][0]).state).toBe('handed_off');
  expect(store.listPendingApprovals()).toEqual([]);
});

test('restart between claim and handoff neither reopens nor dispatches an approval', async () => {
  const store = await import('../src/gateway/pending-approvals.js');
  await store.setPendingApproval('session-a', prompt('approval-a'));
  store.claimPendingApprovalByApprovalId({ approvalId: 'approval-a', userId: 'user-a' });
  vi.resetModules();
  const restarted = await import('../src/gateway/pending-approvals.js');
  expect(restarted.getPendingApproval('session-a')?.state).toBe('claimed');
  expect(restarted.listPendingApprovals()).toEqual([]);
  const { coordinateGatewayApproval } = await import('../src/gateway/approval-coordination.js');
  const execute = vi.fn();
  await expect(coordinateGatewayApproval(execute)({ sessionId: 'session-a', channelId: 'web', guildId: null, username: 'user-a', userId: 'user-a', content: 'yes', approval: { approvalId: 'approval-a', decision: 'yes' } })).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});

test.each([{ sessionId: 'wrong-session', userId: 'user-a', status: 'not_found' }, { sessionId: 'session-a', userId: 'wrong-user', status: 'unauthorized' }])('rejects a mismatched reply: $status', async ({ sessionId, userId, status }) => {
  const store = await import('../src/gateway/pending-approvals.js');
  await store.setPendingApproval('session-a', prompt('approval-a'));
  expect(store.claimPendingApprovalByApprovalId({ sessionId, userId, approvalId: 'approval-a' }).status).toBe(status);
  expect(store.getPendingApproval('session-a')?.state).toBe('pending');
});

test('handoff persists before processing, and a processing failure cannot reopen the claim', async () => {
  const store = await import('../src/gateway/pending-approvals.js');
  const { coordinateGatewayApproval } = await import('../src/gateway/approval-coordination.js');
  await store.setPendingApproval('session-a', prompt('approval-a'));
  const first = store.claimPendingApprovalByApprovalId({ approvalId: 'approval-a', userId: 'user-a' });
  if (first.status !== 'claimed') throw new Error('missing claim');
  const execute = vi.fn(async (_request, accept) => {
    accept();
    expect(JSON.parse([...durable.values()][0]).state).toBe('handed_off');
    throw new Error('worker unavailable');
  });
  await expect(coordinateGatewayApproval(execute)({ sessionId: 'session-a', channelId: 'web', guildId: null, username: 'user-a', userId: 'user-a', content: 'yes', approval: { approvalId: 'approval-a', decision: 'yes' }, approvalClaim: first.claim })).rejects.toThrow('worker unavailable');
  expect(store.rollbackPendingApprovalClaim(first.claim)).toBe(false);
});

test('a failed durable replacement leaves the old prompt and its buttons intact', async () => {
  const store = await import('../src/gateway/pending-approvals.js');
  const persistence = await import('../src/config/runtime-config-revisions.js');
  const disableButtons = vi.fn(async () => {});
  await store.setPendingApproval('session-a', { ...prompt('old'), disableButtons });
  const write = vi.spyOn(persistence, 'syncRuntimeAssetRevisionState').mockImplementationOnce(() => { throw new Error('write failed'); });
  try {
    await expect(store.setPendingApproval('session-a', prompt('replacement'))).rejects.toThrow('write failed');
    expect(store.getPendingApproval('session-a')?.approvalId).toBe('old');
    expect(disableButtons).not.toHaveBeenCalled();
    expect(JSON.parse([...durable.values()][0]).approvalId).toBe('old');
  } finally { write.mockRestore(); }
});
