import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgent } = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('../src/agent/agent.js', () => ({ runAgent }));
const { setupHome } = setupGatewayTest({ tempHomePrefix: 'hy-follow-delivery-', cleanup: () => runAgent.mockReset() });

test('a scheduled preparation attaches one review and run through delivery retry and restart', async () => {
  setupHome();
  const db = await import('../src/memory/db.js');
  const track = await import('../src/tracking/track-store.js');
  const follow = await import('../src/tracking/follow-through.js');
  const jobs = await import('../src/memory/jobs.js');
  const runner = await import('../src/scheduler/scheduled-task-runner.js');
  const delivery = await import('../src/gateway/web-scheduled-delivery.js');
  const notifications = await import('../src/gateway/web-notification-store.js');
  const { beginTurnUser } = await import('../src/session/turn-user.js');
  db.initDatabase({ quiet: true });
  const session = db.getOrCreateSession('main-phone', null, 'web', 'hy');
  notifications.bindWebNotificationSession(session.id, notifications.notificationOperatorId('local-operator'));
  const end = beginTurnUser(session.id, 'user-a', undefined, notifications.notificationOperatorId('local-operator'));
  try {
    const item = track.addTracked(session, { title: 'Arrange an appointment', every: [1], at: '09:00', tz: 'UTC' }, 'user');
    const task = jobs.getJob(item.checkTaskId!, { kind: 'scheduled_task' })!;
    const draft = { from: 'pat@example.com', to: ['alex@example.com'], subject: 'Friday', body: 'Friday at noon works.', track_id: item.id };
    runAgent.mockResolvedValue({ status: 'success', result: 'Prepared a reply.', toolExecutions: [{ name: 'draft_email', arguments: JSON.stringify(draft), result: 'Prepared', durationMs: 1 }] });
    const onError = vi.fn();
    await runner.runIsolatedScheduledTask({ taskId: task.id, prompt: task.prompt, agentId: 'hy', channelId: 'web', chatbotId: 'test', model: 'gpt-4o-mini', originSessionId: session.id,
      taskOwner: { userId: 'user-a', sessionId: session.id }, onError,
      onResult: async (result) => {
        for (let retry = 0; retry < 2; retry++) delivery.deliverWebScheduledMessage(session.id, result.text, `schedule:${task.id}`, result.artifacts, result.storedMessage, result.workId);
      },
    });
    expect(onError).not.toHaveBeenCalled();
    const detail = () => follow.followThroughDetail(session, follow.getTracked(session, item.id));
    expect(detail()).toMatchObject({ phase: 'needs_you', done: false, reviews: [{ revision: 1, state: 'pending', draft }], runs: [{ completedAt: expect.any(String), active: false }] });
    expect(detail().reviews).toHaveLength(1);
    db.closeDatabase(); db.initDatabase({ quiet: true });
    expect(detail().reviews).toHaveLength(1);
    expect(detail().runs).toHaveLength(1);
  } finally { end(); }
});
