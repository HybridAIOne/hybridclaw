import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgent } = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('../src/agent/agent.js', () => ({ runAgent }));
const { setupHome } = setupGatewayTest({ tempHomePrefix: 'hy-scheduled-work-', cleanup: () => { runAgent.mockReset(); } });

test.each([false, true])('a run links evidence, actions, files and chat even if delivery fails: %s', async failDelivery => {
  setupHome();
  const db = await import('../src/memory/db.js');
  const jobs = await import('../src/memory/jobs.js');
  const runner = await import('../src/scheduler/scheduled-task-runner.js');
  const store = await import('../src/work/work-store.js');
  const tool = await import('../src/work/work-tool.js');
  const delivery = await import('../src/gateway/web-scheduled-delivery.js');
  const receipts = await import('../src/gateway/receipts-command.js');
  db.initDatabase({ quiet: true });
  const session = db.getOrCreateSession('app-owned', null, 'web', 'main');
  const taskId = jobs.createJob({ kind: 'scheduled_task', sessionId: session.id,
    channelId: 'web', cronExpr: '*/30 * * * *', prompt: 'Prepare a brief', ownerUserId: 'alice' });
  let workId = '';
  runAgent.mockImplementation(async input => {
    const answer = tool.runWorkTool({ sessionId: input.sessionId, action: 'record', rationale: 'The invitation asks for a decision.',
      evidence: [{ reference: 'calendar:event-42', summary: 'Launch review needs a decision.' }] });
    expect(answer.ok).toBe(true);
    workId = JSON.parse(answer.result!).id;
    expect(store.readWork(workId)?.completedAt).toBeNull();
    return { status: 'success', result: 'Your brief is ready.', artifacts: [{ path: 'brief.md', filename: 'brief.md' }],
      toolExecutions: [{ name: 'write', arguments: '{"path":"brief.md"}', result: 'saved', durationMs: 1, approvalTier: 'red', approvalDecision: 'approved_once' }] };
  });
  const onError = vi.fn();
  await runner.runIsolatedScheduledTask({ taskId, prompt: 'Prepare a brief', agentId: 'main',
    channelId: 'web', chatbotId: 'test', model: 'gpt-4o-mini', originSessionId: session.id,
    taskOwner: { userId: 'alice', sessionId: session.id }, onError,
    onResult: async result => {
      expect(store.readWork(workId)?.completedAt).not.toBeNull();
      expect(result.workId).toBe(workId);
      if (failDelivery) throw new Error('delivery failed');
      delivery.deliverWebScheduledMessage(session.id, result.text, `schedule:${taskId}`, result.artifacts, result.storedMessage, result.workId);
    },
  });
  await (await import('../src/audit/audit-trail.js')).flushAuditTrail();
  const work = store.readWork(workId)!;
  expect(work.rationale).toBe('The invitation asks for a decision.');
  expect(work.artifacts).toEqual(['brief.md']);
  expect(work.actions).toEqual([{ toolCallId: `${workId}:tool:1`, tool: 'write', ok: true }]);
  expect(work.completedAt).not.toBeNull();
  expect(work.failedAt).toBeNull();
  expect(work.seenAt).toBeNull();
  if (failDelivery) { expect(work.savedAt).toBeNull(); expect(onError).toHaveBeenCalledOnce(); }
  else {
    expect(work.savedAt).not.toBeNull();
    expect(store.workForMessage(session.id, work.messageId!)?.id).toBe(workId);
    expect(receipts.listReceipts(session, 10).find(receipt => receipt.id === `${workId}:tool:1`)?.workId).toBe(workId);
  }
  expect(tool.runWorkTool({ sessionId: work.runSessionId, action: 'get', id: workId }).ok).toBe(false);
});

test('a run without a verified owner is not told to record its work', async () => {
  setupHome();
  const db = await import('../src/memory/db.js');
  const jobs = await import('../src/memory/jobs.js');
  const runner = await import('../src/scheduler/scheduled-task-runner.js');
  db.initDatabase({ quiet: true });
  const session = db.getOrCreateSession('tui-chat', null, 'tui', 'main');
  const taskId = jobs.createJob({ kind: 'scheduled_task', sessionId: session.id,
    channelId: 'tui', cronExpr: '0 9 * * *', prompt: 'Check the weather' });
  runAgent.mockResolvedValue({ status: 'success', result: 'Sunny.', toolExecutions: [] });
  await runner.runIsolatedScheduledTask({ taskId, prompt: 'Check the weather', agentId: 'main',
    channelId: 'tui', chatbotId: 'test', model: 'gpt-4o-mini', originSessionId: session.id,
    onError: vi.fn(), onResult: vi.fn() });
  const prompt = runAgent.mock.calls[0][0].messages.at(-1).content;
  expect(prompt).toContain('Check the weather');
  expect(prompt).not.toContain('work(record)');
});
