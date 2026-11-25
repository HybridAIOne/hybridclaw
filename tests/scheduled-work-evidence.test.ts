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
    expect(db.getSessionById(input.sessionId)).toBeDefined();
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

test('proactive checks save a mail once across tasks and stay quiet without new evidence', async () => {
  setupHome();
  const db = await import('../src/memory/db.js');
  const jobs = await import('../src/memory/jobs.js');
  const { runIsolatedScheduledTask } = await import(
    '../src/scheduler/scheduled-task-runner.js'
  );
  const { runWorkTool } = await import('../src/work/work-tool.js');
  const { deliverWebScheduledMessage } = await import(
    '../src/gateway/web-scheduled-delivery.js'
  );
  const { memoryService } = await import('../src/memory/memory-service.js');
  const notifications = await import('../src/gateway/web-notifications.js');
  const { queueConnectorChange } = await import(
    '../src/scheduler/connector-events.js'
  );
  const notify = vi.spyOn(notifications, 'notifyWebSession');
  db.initDatabase({ quiet: true });
  const session = db.getOrCreateSession('app-owned', null, 'web', 'main');
  const otherSession = db.getOrCreateSession(
    'another-app-chat',
    null,
    'web',
    'main',
  );
  const add = (label: string, owner: string, sessionId = session.id) =>
    jobs.createJob({
      kind: 'scheduled_task',
      sessionId,
      channelId: 'web',
      cronExpr: '*/30 * * * *',
      prompt: `[${label}] [notice-evidence] Check for updates.`,
      ownerUserId: owner,
      replyOnly: true,
      alert: 'proactive',
    });
  const check = add('Mail check', 'alice');
  const watch = add('Mail watch', 'alice');
  const otherOwner = add('Mail check', 'bob', otherSession.id);
  const wake = queueConnectorChange(
    { userId: 'alice', taskId: check, source: 'gmail', eventId: 'change-1' },
    Date.UTC(2026, 10, 25, 12, 8),
  );
  expect(wake.status).toBe('queued');
  const firstMail = 'mail:gmail:account-1:message-1';

  async function run(
    taskId: number,
    owner: string,
    text: string,
    reference?: string,
  ) {
    const task = jobs.getJob(taskId, { kind: 'scheduled_task' })!;
    runAgent.mockImplementationOnce(async (input) => {
      expect(input.messages.at(-1).content).toContain(
        'mail:<provider>:<account-id>:<immutable-message-id>',
      );
      if (reference)
        expect(
          runWorkTool({
            sessionId: input.sessionId,
            action: 'record',
            rationale: 'A new event needs attention.',
            evidence: [
              { reference, summary: 'The source requests a decision.' },
            ],
          }).ok,
        ).toBe(true);
      return { status: 'success', result: text, toolExecutions: [] };
    });
    const onError = vi.fn();
    const onResult = vi.fn();
    await runIsolatedScheduledTask({
      taskId,
      prompt: task.prompt,
      agentId: 'main',
      channelId: 'web',
      chatbotId: 'test',
      model: 'gpt-4o-mini',
      originSessionId: task.session_id,
      taskOwner: { userId: owner, sessionId: task.session_id },
      onError,
      onResult,
    });
    expect(onError).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledOnce();
    const [result] = onResult.mock.calls[0];
    return () =>
      deliverWebScheduledMessage(
        task.session_id,
        result.text,
        `schedule:${taskId}`,
        result.artifacts,
        result.storedMessage,
        result.workId,
      );
  }

  const first = await run(
    check,
    'alice',
    'Pat replied with a proposed time.',
    firstMail,
  );
  const save = vi
    .spyOn(memoryService, 'storeMessage')
    .mockImplementationOnce(() => {
      throw new Error('Save failed');
    });
  expect(first).toThrow('Save failed');
  save.mockRestore();
  const delivered = first();
  expect(delivered.status).toBe('delivered');
  expect(first()).toEqual(delivered);
  expect(
    (
      await run(watch, 'alice', 'There is a proposed time from Pat.', firstMail)
    )().status,
  ).toBe('suppressed');
  expect(
    (await run(wake.taskId!, 'alice', 'Pat proposed a time.', firstMail))()
      .status,
  ).toBe('suppressed');
  expect((await run(check, 'alice', 'There is nothing new.'))().status).toBe(
    'suppressed',
  );
  expect(
    (
      await run(
        check,
        'alice',
        'This has only a thread reference.',
        'mail:gmail:account-1',
      )
    )().status,
  ).toBe('suppressed');
  expect(
    (
      await run(
        check,
        'alice',
        'Pat confirmed the time.',
        'mail:gmail:account-1:message-2',
      )
    )().status,
  ).toBe('delivered');
  expect(
    (
      await run(
        check,
        'alice',
        'The calendar invitation was updated.',
        'event:calendar:invitation-1',
      )
    )().status,
  ).toBe('delivered');
  expect(
    (
      await run(
        otherOwner,
        'bob',
        'This account has its own notice history.',
        firstMail,
      )
    )().status,
  ).toBe('delivered');
  expect(
    db.getRecentMessages(session.id).map((message) => message.content),
  ).toEqual([
    'Pat replied with a proposed time.',
    'Pat confirmed the time.',
    'The calendar invitation was updated.',
  ]);
  expect(
    db.getRecentMessages(otherSession.id).map((message) => message.content),
  ).toEqual(['This account has its own notice history.']);
  expect(notify).toHaveBeenCalledTimes(4);
});
