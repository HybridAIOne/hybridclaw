import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import type { SchedulerDispatchRequest } from '../src/scheduler/scheduler.js';
import { runScheduledTask } from '../src/gateway/gateway-scheduled-dispatch.js';
import { resetOutOfCreditNotices } from '../src/scheduler/out-of-credit.js';
import { useCleanMocks } from './test-utils.js';

const mocks = vi.hoisted(() => ({ run: vi.fn(), deliverWeb: vi.fn(), agentMainChat: vi.fn() }));
vi.mock('../src/gateway/gateway-scheduled-task-service.js', () => ({ runGatewayScheduledTask: mocks.run }));
vi.mock('../src/gateway/web-scheduled-delivery.js', () => ({ deliverWebScheduledMessage: mocks.deliverWeb, mainChatForWebTask: () => null, agentMainChatForWebTarget: mocks.agentMainChat }));
vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
useCleanMocks();
beforeEach(() => {
  vi.clearAllMocks();
  resetOutOfCreditNotices();
  mocks.deliverWeb.mockReturnValue({ status: 'delivered' });
  mocks.agentMainChat.mockImplementation((agentId: string) => ({ id: `main:${agentId}` }));
  mocks.run.mockImplementation(async (_session, _channel, _prompt, _task, onResult) => {
    await onResult({ workId: 'work-1', text: 'Reminder', artifacts: [], storedMessage: { sessionId: 'session-a', id: 42 } });
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
  expect(mocks.deliverWeb).toHaveBeenCalledWith('session-a', 'Reminder', 'schedule:1', [], { sessionId: 'session-a', id: 42 }, 'work-1');
  expect(deps.deliverProactiveMessage).not.toHaveBeenCalled();
});

test('a reply-only task runs apart from the chat it delivers to', async () => {
  await runScheduledTask({ ...request(), replyOnly: true }, dependencies());
  expect(mocks.run.mock.calls[0][8]).toBe(true);
  await runScheduledTask(request(), dependencies());
  expect(mocks.run.mock.calls[1][8]).toBe(false);
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
  expect(mocks.deliverWeb).toHaveBeenCalledWith('session-a', 'Reminder', 'schedule:1', [], { sessionId: 'session-a', id: 42 }, 'work-1');
  expect(mocks.run.mock.calls[0][3]).toBe(9);
  expect(mocks.run.mock.calls[0][9]).toEqual(taskOwner);
});

test('a failed run tells its delivery target in one line and still fails', async () => {
  mocks.run.mockImplementation(async (_session, _channel, _prompt, _task, _onResult, onError) => {
    onError(new Error('Provider API error 429: Rate limit exceeded.\nstack'));
  });
  const deps = dependencies();
  const job = { ...request(), source: 'scheduler-job' as const, jobId: 'daily-report', delivery: { kind: 'channel' as const, channelId: 'discord_webhook:default' } };
  await expect(runScheduledTask(job, deps)).rejects.toThrow('Rate limit exceeded');
  expect(deps.deliverProactiveMessage).toHaveBeenCalledWith('discord_webhook:default', '⚠️ Scheduled run daily-report failed: Provider API error 429: Rate limit exceeded.', 'schedule-job:daily-report:failure');
});

test('runs refused for lack of credit tell each chat once, with the way to add credit', async () => {
  // A notice lasts until the reset; a reset already past would notify every run.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-27T12:00:00Z') });
  onTestFinished(() => vi.useRealTimers());
  mocks.run.mockImplementation(async (_session, _channel, _prompt, _task, _onResult, onError) => {
    onError(new Error('Provider API error 429: Free usage limit reached; add credits or try again after 2026-11-28 05:00 UTC.'));
  });
  const job = { ...request(), source: 'scheduler-job' as const, taskId: undefined, jobId: 'daily', agentId: 'a' };
  await expect(runScheduledTask(job, dependencies())).rejects.toThrow('Free usage limit');
  await expect(runScheduledTask({ ...job, jobId: 'weekly' }, dependencies())).rejects.toThrow('Free usage limit');
  expect(mocks.deliverWeb).toHaveBeenCalledTimes(1);
  expect(mocks.deliverWeb).toHaveBeenCalledWith(
    'main:a',
    "Hy's free use is used up until Sat, Nov 28, 05:00 UTC, so your routines wait until then. [Add credit](https://hybridai.one/app/admin/account) to keep them going now.",
    'schedule-job:daily:failure',
  );
  await expect(runScheduledTask({ ...job, agentId: 'b' }, dependencies())).rejects.toThrow('Free usage limit');
  expect(mocks.deliverWeb).toHaveBeenCalledTimes(2);
});

test('admin jobs deliver web output to their agent main chat and fail before running without one', async () => {
  const job: SchedulerDispatchRequest = { ...request(), source: 'scheduler-job', taskId: undefined, jobId: 'daily', agentId: 'writer', sessionId: 'scheduler:daily' };
  await runScheduledTask(job, dependencies());
  expect(mocks.agentMainChat).toHaveBeenCalledWith('writer');
  expect(mocks.run.mock.calls[0][8]).toBe(true);
  expect(mocks.deliverWeb).toHaveBeenCalledWith('main:writer', 'Reminder', 'schedule-job:daily', [], { sessionId: 'session-a', id: 42 }, 'work-1');
  await runScheduledTask({ ...job, actionKind: 'system_event' }, dependencies());
  expect(mocks.deliverWeb).toHaveBeenLastCalledWith('main:writer', 'Reminder', 'schedule-job:daily:system');

  mocks.run.mockClear();
  mocks.agentMainChat.mockImplementation(() => { throw new Error('Agent "writer" has no main web chat to deliver to.'); });
  await expect(runScheduledTask(job, dependencies())).rejects.toThrow('no main web chat');
  expect(mocks.run).not.toHaveBeenCalled();
});
