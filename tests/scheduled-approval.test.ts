import { expect, test, vi } from 'vitest';
import type { ScheduledTask } from '../src/types/scheduler.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgent } = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('../src/agent/agent.js', () => ({ runAgent }));
vi.mock('../src/gateway/gateway-service.js', () => ({
  prepareSessionAutoReset: vi.fn(async () => undefined),
  resolveSessionAutoResetPolicy: () => ({ mode: 'none' }),
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-scheduled-approval-',
  cleanup: () => {
    runAgent.mockReset();
  },
});

const MAIN_CHAT = `main-${'cd'.repeat(16)}-main`;
const SIDE_CHAT = 'ios-5e2b9a10-side';
const OWNER = 'user_a';
const APPROVAL_ID = '1a2b3c4d';
const PROMPT = [
  'I need your approval before I run shell command `ls reports`.',
  `Approval ID: ${APPROVAL_ID}`,
  'Reply `yes` to approve once.',
].join('\n');
const pausedRun = () => ({
  status: 'success',
  result: PROMPT,
  toolsUsed: [],
  toolExecutions: [],
  pendingApproval: {
    approvalId: APPROVAL_ID,
    prompt: PROMPT,
    intent: 'run shell command `ls reports`',
    reason: 'this command lists files',
    toolName: 'bash',
    commandPreview: 'ls reports',
    allowSession: true,
    allowAgent: true,
    allowAll: true,
    expiresAt: Date.now() + 120_000,
  },
});

async function pauseScheduledRun(origin = SIDE_CHAT) {
  setupHome();
  const db = await import('../src/memory/db.ts');
  const jobs = await import('../src/memory/jobs.ts');
  const notices = await import('../src/gateway/web-notification-store.ts');
  const pending = await import('../src/gateway/pending-approvals.ts');
  const { runScheduledTask } = await import(
    '../src/gateway/gateway-scheduled-dispatch.ts'
  );
  const { withScheduledApprovalAnswers } = await import(
    '../src/gateway/scheduled-approval-answer.ts'
  );
  const { approvalSessionId } = await import(
    '../src/gateway/scheduled-approval.ts'
  );
  db.initDatabase({ quiet: true });
  db.getOrCreateSession(MAIN_CHAT, null, 'web', 'main');
  db.getOrCreateSession(SIDE_CHAT, null, 'web', 'main');
  notices.bindWebNotificationSession(MAIN_CHAT, 'operator-a');
  const taskId = jobs.createJob({
    kind: 'scheduled_task',
    sessionId: origin,
    channelId: 'web',
    cronExpr: '0 8 * * *',
    prompt: 'List the new reports.',
    ownerUserId: OWNER,
  });
  const task = jobs.getJob(taskId, {
    kind: 'scheduled_task',
  }) as ScheduledTask;
  runAgent.mockResolvedValueOnce(pausedRun());
  await runScheduledTask(
    {
      source: 'scheduled-task',
      taskOwner: { userId: OWNER, sessionId: origin },
      taskId,
      sessionId: origin,
      channelId: 'web',
      prompt: task.prompt,
      actionKind: 'agent_turn',
      delivery: { kind: 'channel', channelId: 'web' },
    },
    {
      deliverProactiveMessage: vi.fn(),
      deliverWebhookMessage: vi.fn(),
      resolveLastUsedDeliverableChannelId: () => null,
    },
  );
  const runSessionId: string = runAgent.mock.calls[0][0].sessionId;
  const latest = (sessionId: string) => {
    const id = db.getLatestAssistantMessageId(sessionId);
    return id ? db.getSessionAssistantMessage(sessionId, id) : null;
  };
  const next = vi.fn(async () => ({
    status: 'success' as const,
    result: 'chat turn',
    toolsUsed: [],
  }));
  const answer = (userId: string, decision: 'yes' | 'no' = 'yes') =>
    withScheduledApprovalAnswers(next)({
      sessionId: MAIN_CHAT,
      guildId: null,
      channelId: 'web',
      userId,
      username: 'web',
      content: `${decision} ${APPROVAL_ID}`,
      approval: { approvalId: APPROVAL_ID, decision },
    });
  return {
    taskId,
    runSessionId,
    latest,
    next,
    answer,
    pending,
    notices,
    approvalSessionId,
  };
}

test('a paused scheduled run shows its approval as a card in the main chat', async () => {
  const { taskId, runSessionId, latest, pending, notices } =
    await pauseScheduledRun();

  expect(runSessionId).not.toBe(MAIN_CHAT);
  expect(latest(runSessionId)?.approval?.approvalId).toBe(APPROVAL_ID);
  const copy = latest(MAIN_CHAT);
  expect(copy).toMatchObject({
    source: `schedule:${taskId}`,
    approval: { approvalId: APPROVAL_ID, toolName: 'bash' },
  });
  expect(latest(SIDE_CHAT)).toBeNull();
  // The run's own session holds the request; only the owner may answer it.
  expect(pending.getPendingApproval(runSessionId)).toMatchObject({
    approvalId: APPROVAL_ID,
    userId: OWNER,
    state: 'pending',
  });
  expect(pending.getPendingApproval(MAIN_CHAT)).toBeNull();
  expect(
    notices
      .readWebNotificationState('operator-a')
      .notifications.map((notice) => notice.kind),
  ).toEqual(['approval']);
});

test('answering in the main chat resumes the run in its own session', async () => {
  const { runSessionId, latest, next, answer, pending, approvalSessionId } =
    await pauseScheduledRun();
  expect(approvalSessionId(MAIN_CHAT, APPROVAL_ID)).toBe(runSessionId);
  runAgent.mockResolvedValueOnce({
    status: 'success',
    result: 'Two new reports: March and April.',
    toolsUsed: ['bash'],
    toolExecutions: [],
  });

  const result = await answer(OWNER);

  expect(next).not.toHaveBeenCalled();
  expect(runAgent).toHaveBeenCalledTimes(2);
  expect(runAgent.mock.calls[1][0]).toMatchObject({
    sessionId: runSessionId,
    approvalUserId: OWNER,
    approvalUserText: `yes ${APPROVAL_ID}`,
  });
  expect(pending.getStoredPendingApproval(runSessionId)?.state).toBe(
    'handed_off',
  );
  const reply = latest(MAIN_CHAT);
  expect(reply?.content).toBe('Two new reports: March and April.');
  expect(result).toMatchObject({
    status: 'success',
    result: 'Two new reports: March and April.',
    sessionId: MAIN_CHAT,
    assistantMessageId: reply?.id,
  });
  expect(result.pendingApproval).toBeUndefined();

  await expect(answer(OWNER)).rejects.toMatchObject({ statusCode: 409 });
  expect(runAgent).toHaveBeenCalledTimes(2);
});

test('only the task owner can answer, and other approvals take the chat path', async () => {
  const { runSessionId, next, answer, pending } = await pauseScheduledRun();

  await expect(answer('user_b')).rejects.toMatchObject({ statusCode: 403 });
  expect(runAgent).toHaveBeenCalledTimes(1);
  expect(pending.getPendingApproval(runSessionId)?.state).toBe('pending');

  const { withScheduledApprovalAnswers } = await import(
    '../src/gateway/scheduled-approval-answer.ts'
  );
  await withScheduledApprovalAnswers(next)({
    sessionId: MAIN_CHAT,
    guildId: null,
    channelId: 'web',
    userId: OWNER,
    username: 'web',
    content: 'yes 9f8e7d6c',
    approval: { approvalId: '9f8e7d6c', decision: 'yes' },
  });
  expect(next).toHaveBeenCalledOnce();
});

test('a run in the main chat itself leaves its approval to the chat turn', async () => {
  const { runSessionId, latest, next, answer, pending } =
    await pauseScheduledRun(MAIN_CHAT);

  expect(runSessionId).toBe(MAIN_CHAT);
  expect(latest(MAIN_CHAT)?.approval?.approvalId).toBe(APPROVAL_ID);
  expect(pending.getPendingApproval(MAIN_CHAT)?.userId).toBe(OWNER);

  await answer(OWNER);
  expect(next).toHaveBeenCalledOnce();
  expect(runAgent).toHaveBeenCalledTimes(1);
});
