import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-budget-hard-stop-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

async function loadContext(budgetCostUsd: number, source: string) {
  setupHome();
  const db = await import('../src/memory/db.ts');
  const runtimeConfig = await import('../src/config/runtime-config.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const goals = await import('../src/goals/goal-manager.ts');
  const { classifyGatewayError } = await import(
    '../src/gateway/gateway-error-utils.ts'
  );
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  db.initDatabase({ quiet: true });
  runtimeConfig.updateRuntimeConfig((draft) => {
    draft.agents.list = [
      { id: 'main', budget: { cap: 10, currency: 'USD', unit: 'USD' } },
    ];
  });
  db.recordUsageEvent({
    sessionId: 'earlier-session',
    agentId: 'main',
    model: 'test-model',
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    costUsd: budgetCostUsd,
  });
  const session = memoryService.getOrCreateSession(
    'session-budget',
    null,
    'web',
    'main',
  );
  goals.setThreadGoal({
    threadId: goals.resolveGoalThreadId(session),
    goalText: 'ship the patch',
    maxTurns: 5,
    setterActor: { type: 'user', id: 'user_a' },
    targetAgentId: 'main',
  });
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'Working on it.',
    toolsUsed: [],
    toolExecutions: [],
  });
  const result = await handleGatewayMessage({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    content: 'keep going',
    agentId: 'main',
    model: 'test-model',
    chatbotId: 'test-bot',
    source,
  });
  return {
    db,
    result,
    goal: goals.getThreadGoal(goals.resolveGoalThreadId(session)),
    sessionId: session.id,
    classifyGatewayError,
  };
}

test('refuses the turn and pauses the goal once the agent reaches its cap', async () => {
  const { db, result, goal, sessionId, classifyGatewayError } =
    await loadContext(10, 'goal-continuation');

  expect(result.status).toBe('error');
  expect(result.error).toContain('10.00 USD used of 10.00 USD');
  expect(classifyGatewayError(result.error || '')).toBe('permanent');
  expect(runAgentMock).not.toHaveBeenCalled();
  expect(goal?.status).toBe('paused');
  expect(goal?.pausedReason).toBe('agent budget hard-stop');
  const hardStop = db
    .getRecentStructuredAuditForSession(sessionId, 20)
    .find((row) => row.event_type === 'budget.hard_stop');
  expect(JSON.parse(hardStop?.payload || '{}')).toMatchObject({
    targetAgentId: 'main',
    source: 'goal-continuation',
    used: 10,
    cap: 10,
    unit: 'USD',
  });
});

test('runs the turn while the agent is under its cap', async () => {
  // A user-sourced turn, so the goal is preempted rather than continued and
  // the test does not schedule a follow-up continuation.
  const { result } = await loadContext(9.99, 'gateway.chat');

  expect(result.status).toBe('success');
  expect(runAgentMock).toHaveBeenCalledOnce();
});
