import { beforeEach, expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/gateway/gateway-chat-service.js', () => ({ handleGatewayMessage: mocks.run }));
const { setupHome } = setupGatewayTest({ tempHomePrefix: 'goal-continuation-lifecycle-' });
beforeEach(() => { mocks.run.mockReset(); });

async function fixture() {
  setupHome();
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  const session = db.getOrCreateSession('session-a', null, 'web', 'hy');
  const manager = await import('../src/goals/goal-manager.js');
  manager.setThreadGoal({ threadId: manager.resolveGoalThreadId(session), goalText: 'Prepare a report', maxTurns: 5 });
  const runtime = await import('../src/goals/goal-runtime.js');
  return { session, runtime };
}

test('late completion from a cleared goal run cannot publish or release its replacement', async () => {
  const { session, runtime } = await fixture();
  const { initializeGoalContinuationRunner } = await import('../src/gateway/goal-continuation-runner.js');
  const finish: Array<(value: { status: 'success'; result: string }) => void> = [];
  mocks.run.mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
  initializeGoalContinuationRunner();
  const deliver = vi.fn();
  const request = { session, context: { guildId: null, userId: 'user_a', username: null, onProactiveMessage: deliver } };
  runtime.scheduleGoalContinuation(request);
  runtime.clearScheduledGoalContinuation(session.id);
  runtime.scheduleGoalContinuation(request);
  expect(mocks.run).toHaveBeenCalledTimes(2);
  await mocks.run.mock.calls[0][0].onProactiveMessage({ text: 'Stale progress' });
  expect(deliver).not.toHaveBeenCalled();
  finish[0]({ status: 'success', result: 'Old reply' });
  await new Promise((resolve) => setImmediate(resolve));
  expect(deliver).not.toHaveBeenCalled();
  expect(runtime.isGoalContinuationRunning(session.id)).toBe(true);
  finish[1]({ status: 'success', result: 'Current reply' });
  await new Promise((resolve) => setImmediate(resolve));
  expect(deliver).toHaveBeenCalledOnce();
  expect(deliver.mock.calls[0][0].text).toBe('Current reply');
  expect(runtime.isGoalContinuationRunning(session.id)).toBe(false);
  runtime.clearScheduledGoalContinuation(session.id);
});

test('multiple requests during a goal run coalesce into one successor with its own lease', async () => {
  const { session, runtime } = await fixture();
  const tokens: symbol[] = [];
  const handler = vi.fn(async (id: string) => { tokens.push(runtime.beginGoalContinuationRun(id)!); });
  runtime.setGoalContinuationRunHandler(handler);
  const request = { session, context: { guildId: null, userId: 'user_a', username: null } };
  runtime.scheduleGoalContinuation(request);
  runtime.scheduleGoalContinuation(request);
  runtime.scheduleGoalContinuation(request);
  expect(handler).toHaveBeenCalledOnce();
  runtime.finishGoalContinuationRun(session.id, tokens[0]);
  expect(handler).toHaveBeenCalledTimes(2);
  runtime.finishGoalContinuationRun(session.id, tokens[0]);
  expect(runtime.isCurrentGoalContinuationRun(session.id, tokens[1])).toBe(true);
  runtime.finishGoalContinuationRun(session.id, tokens[1]);
  runtime.clearScheduledGoalContinuation(session.id);
});
