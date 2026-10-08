import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { judgeGoalCompletionMock, runAgentMock } = vi.hoisted(() => ({
  judgeGoalCompletionMock: vi.fn(),
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/goals/goal-judge.js', () => ({
  judgeGoalCompletion: judgeGoalCompletionMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-goal-continuation-',
  cleanup: () => {
    judgeGoalCompletionMock.mockReset();
    runAgentMock.mockReset();
  },
});

async function runTurnWithActiveGoal(source: string) {
  setupHome();
  const db = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const goals = await import('../src/goals/goal-manager.ts');
  const goalRuntime = await import('../src/goals/goal-runtime.ts');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  db.initDatabase({ quiet: true });
  const runContinuation = vi.fn(async () => undefined);
  goalRuntime.setGoalContinuationRunHandler(runContinuation);

  const session = memoryService.getOrCreateSession(
    'session-goal-continuation',
    null,
    'web',
    'main',
  );
  const threadId = goals.resolveGoalThreadId(session);
  goals.setThreadGoal({
    threadId,
    goalText: 'ship the patch',
    maxTurns: 5,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'main',
  });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Patch drafted.',
    toolsUsed: [],
    toolExecutions: [],
  });

  const result = await handleGatewayMessage({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    username: 'User A',
    content: 'keep going',
    agentId: 'main',
    model: 'test-model',
    chatbotId: 'test-bot',
    source,
  });
  goalRuntime.clearScheduledGoalContinuation(session.id);

  const { flushAuditTrail } = await import('../src/audit/audit-trail.ts');
  await flushAuditTrail();
  return {
    result,
    goal: goals.getThreadGoal(threadId),
    runContinuation,
    sessionId: session.id,
    auditTypes: db
      .getRecentStructuredAuditForSession(session.id, 50)
      .map((row) => row.event_type)
      .filter((type) => type.startsWith('goal.')),
  };
}

test.each([
  {
    verdict: { done: false, reason: 'tests still fail', parseFailure: false },
    status: 'active',
    continued: 1,
    auditType: 'goal.continued',
  },
  {
    verdict: { done: true, reason: 'patch shipped', parseFailure: false },
    status: 'done',
    continued: 0,
    auditType: 'goal.completed',
  },
])('judges a goal-continuation turn and records a $status goal', async ({
  verdict,
  status,
  continued,
  auditType,
}) => {
  judgeGoalCompletionMock.mockResolvedValue(verdict);

  const { result, goal, runContinuation, sessionId, auditTypes } =
    await runTurnWithActiveGoal('goal-continuation');

  expect(result.status).toBe('success');
  expect(judgeGoalCompletionMock).toHaveBeenCalledOnce();
  expect(judgeGoalCompletionMock).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId,
      agentId: 'main',
      goalText: 'ship the patch',
      assistantResponse: 'Patch drafted.',
    }),
  );
  expect(goal).toMatchObject({ status, turnsUsed: 1 });
  expect(runContinuation).toHaveBeenCalledTimes(continued);
  expect(auditTypes).toContain(auditType);
});

test('a user turn preempts the active goal without judging it', async () => {
  const { result, goal, runContinuation, auditTypes } =
    await runTurnWithActiveGoal('gateway.chat');

  expect(result.status).toBe('success');
  expect(judgeGoalCompletionMock).not.toHaveBeenCalled();
  expect(goal).toMatchObject({
    status: 'paused',
    pausedReason: 'user-message',
    turnsUsed: 0,
  });
  expect(runContinuation).not.toHaveBeenCalled();
  expect(auditTypes).toContain('goal.paused');
});

test('a failing goal check does not fail the turn', async () => {
  judgeGoalCompletionMock.mockRejectedValue(new Error('judge unavailable'));

  const { result, goal, runContinuation } =
    await runTurnWithActiveGoal('goal-continuation');

  expect(result.status).toBe('success');
  expect(result.result).toBe('Patch drafted.');
  expect(judgeGoalCompletionMock).toHaveBeenCalledOnce();
  expect(goal).toMatchObject({ status: 'active', turnsUsed: 0 });
  expect(runContinuation).not.toHaveBeenCalled();
});
