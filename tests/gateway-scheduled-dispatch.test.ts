import { beforeEach, expect, test, vi } from 'vitest';
import type { SchedulerDispatchRequest } from '../src/scheduler/scheduler.js';
import { runScheduledTask } from '../src/gateway/gateway-scheduled-dispatch.js';
import { useCleanMocks } from './test-utils.js';

const mocks = vi.hoisted(() => ({ run: vi.fn(), deliverWeb: vi.fn() }));
vi.mock('../src/gateway/gateway-scheduled-task-service.js', () => ({ runGatewayScheduledTask: mocks.run }));
vi.mock('../src/gateway/web-scheduled-delivery.js', () => ({ deliverWebScheduledMessage: mocks.deliverWeb }));
vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
useCleanMocks();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.deliverWeb.mockReturnValue({ status: 'delivered' });
  mocks.run.mockImplementation(async (_session, _channel, _prompt, _task, onResult) => {
    await onResult({ text: 'Reminder', artifacts: [], storedMessage: { sessionId: 'session-a', id: 42 } });
  });
});

function request(): SchedulerDispatchRequest {
  return { source: 'scheduled-task', sessionId: 'session-a', channelId: 'web', prompt: 'Reminder', taskId: 1, actionKind: 'agent_turn', delivery: { kind: 'channel', channelId: 'web' } };
}
function dependencies() {
  return { deliverProactiveMessage: vi.fn(async () => ({ status: 'delivered' as const })), deliverWebhookMessage: vi.fn(), resolveLastUsedDeliverableChannelId: vi.fn(() => null) };
}

test('web scheduled turns reuse the persisted message instead of entering the undeliverable queue', async () => {
  const deps = dependencies();
  await runScheduledTask(request(), deps);
  expect(mocks.deliverWeb).toHaveBeenCalledWith('session-a', 'Reminder', 'schedule:1', [], { sessionId: 'session-a', id: 42 });
  expect(deps.deliverProactiveMessage).not.toHaveBeenCalled();
});

test('a reply-only task runs apart from the chat it delivers to', async () => {
  await runScheduledTask({ ...request(), replyOnly: true }, dependencies());
  expect(mocks.run.mock.calls[0][8]).toBe(true);
  await runScheduledTask(request(), dependencies());
  expect(mocks.run.mock.calls[1][8]).toBeUndefined();
});

test('web system events persist without running an agent', async () => {
  await runScheduledTask({ ...request(), actionKind: 'system_event' }, dependencies());
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.deliverWeb).toHaveBeenCalledWith('session-a', 'Reminder', 'schedule:1:system');
});

test('other transports retain their delivery policy and missing destinations fail', async () => {
  const deps = dependencies();
  await runScheduledTask({ ...request(), delivery: { kind: 'channel', channelId: 'tui' } }, deps);
  expect(deps.deliverProactiveMessage).toHaveBeenCalledWith('tui', 'Reminder', 'schedule:1', []);
  expect(mocks.deliverWeb).not.toHaveBeenCalled();
  await expect(runScheduledTask({ ...request(), delivery: { kind: 'last-channel' } }, deps)).rejects.toThrow('No delivery channel');
});

test('connector checks retain their parent policy in chat and push attribution', async () => {
  const taskOwner = { userId: 'alice', sessionId: 'session-a' };
  await runScheduledTask({ ...request(), taskId: 9, resultSourceTaskId: 1, replyOnly: true, taskOwner }, dependencies());
  expect(mocks.deliverWeb).toHaveBeenCalledWith('session-a', 'Reminder', 'schedule:1', [], { sessionId: 'session-a', id: 42 });
  expect(mocks.run.mock.calls[0][3]).toBe(9);
  expect(mocks.run.mock.calls[0][9]).toEqual(taskOwner);
});
