import { expect, test } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const cleanup: (() => void)[] = [];
const { setupHome } = setupGatewayTest({ tempHomePrefix: 'hy-follow-through-', cleanup: () => { for (const end of cleanup.splice(0)) end(); } });
const draft = { from: 'pat@example.com', to: ['alex@example.com'], subject: 'Friday', body: 'See you then.' };

async function setup() {
  setupHome();
  const db = await import('../src/memory/db.js');
  const { memoryService: messages } = await import('../src/memory/memory-service.js');
  const track = await import('../src/tracking/track-store.js');
  const follow = await import('../src/tracking/follow-through.js');
  const commands = await import('../src/tracking/track-command.js');
  const turn = await import('../src/session/turn-user.js');
  const notifications = await import('../src/gateway/web-notification-store.js');
  const email = await import('../src/gateway/email-draft.js');
  const work = await import('../src/work/work-store.js');
  const workTool = await import('../src/work/work-tool.js');
  const jobs = await import('../src/memory/jobs.js');
  db.initDatabase({ quiet: true });
  const session = (id: string, user = 'user-a', agent = 'hy') => {
    const value = db.getOrCreateSession(id, null, 'web', agent);
    notifications.bindWebNotificationSession(value.id, notifications.notificationOperatorId(user));
    cleanup.push(turn.beginTurnUser(value.id, user));
    return value;
  };
  const first = session('first');
  const second = session('second');
  const item = track.addTracked(first, { title: 'Arrange an appointment' }, 'agent');
  let requests = 0;
  const update = (body: Record<string, unknown>, actor: 'user' | 'agent' = 'user', caller = first) => follow.mutateFollowThrough(caller, item.id, {
    revision: follow.getTracked(caller, item.id).revision, request_id: `request-${++requests}`, ...body,
  }, actor);
  const detail = (caller = first) => follow.followThroughDetail(caller, follow.getTracked(caller, item.id));
  const storeDraft = (caller = first) => {
    const messageId = messages.storeMessage({ sessionId: caller.id, userId: 'assistant', role: 'assistant', content: 'Prepared a reply.', agentId: caller.agent_id });
    email.storeEmailDraft(caller.id, messageId, { ...draft, track_id: item.id, reply: 'Prepared a reply.' });
    return { kind: 'message' as const, session_id: caller.id, message_id: messageId };
  };
  return { db, messages, track, follow, commands, turn, notifications, email, work, workTool, jobs, session, first, second, item, update, detail, storeDraft };
}

test('draft edits, deferral and decisions survive another device and database reopen', async () => {
  const { db, detail, storeDraft, update, second } = await setup();
  const source = storeDraft();
  expect(detail(second)).toMatchObject({ phase: 'needs_you', reviews: [{ state: 'pending', revision: 1, draft }] });
  update({ action: 'review', source, review_revision: 1, decision: 'edit', draft: { ...draft, body: 'Friday at noon works.' } });
  expect(detail(second).reviews[0]).toMatchObject({ revision: 2, draft: { body: 'Friday at noon works.' } });
  update({ action: 'review', source, review_revision: 2, decision: 'defer', until: '2099-01-01T09:00:00Z' });
  db.closeDatabase(); db.initDatabase({ quiet: true });
  expect(detail(second).reviews[0]).toMatchObject({ state: 'deferred', revision: 3, deferred_until: '2099-01-01T09:00:00.000Z' });
  expect(() => update({ action: 'review', source, review_revision: 2, decision: 'approve' }, 'user', second)).toThrow('Review changed');
  update({ action: 'review', source, review_revision: 3, decision: 'approve' }, 'user', second);
  expect(detail().reviews[0]).toMatchObject({ state: 'approved', revision: 4 });
  expect(detail().phase).not.toBe('completed');
  expect(detail().evidence).toHaveLength(1);
});

test('an ambiguous approval retry never repeats the decision or silently approves newer content', async () => {
  const { first, item, follow, detail, storeDraft, update } = await setup();
  const source = storeDraft();
  const body = { action: 'review', source, revision: detail().revision, request_id: 'approval-once', review_revision: 1, decision: 'approve' };
  expect(follow.mutateFollowThrough(first, item.id, body, 'user').applied).toBe(true);
  expect(follow.mutateFollowThrough(first, item.id, body, 'user').applied).toBe(false);
  expect(() => follow.mutateFollowThrough(first, item.id, { ...body, decision: 'decline' }, 'user')).toThrow('different change');
  expect(() => update({ action: 'review', source, review_revision: 2, decision: 'approve' })).toThrow('Already approved');
  expect(() => update({ action: 'review', source, review_revision: 2, decision: 'reopen' })).toThrow('Already approved');
});

test('review choices are user-only and a stale item revision cannot overwrite a newer update', async () => {
  const { first, item, follow, track, detail, storeDraft, update, commands } = await setup();
  const source = storeDraft();
  const revision = detail().revision;
  update({ action: 'state', phase: 'waiting', reason: 'Waiting for a reply.' });
  expect(() => update({ action: 'state', phase: 'blocked', reason: 'Old phone state.', revision })).toThrow('Item changed');
  expect(() => update({ action: 'review', source, review_revision: 1, decision: 'approve' }, 'agent')).toThrow('Only the user');
  expect(() => commands.runTrackToolAction({ sessionId: first.id, action: 'review', id: item.id, actor: 'user' })).toThrow('Invalid');
  expect(() => track.markTracked(first, item.id, true, 'agent')).toThrow('not the outcome');
  expect(() => track.markTracked(first, item.id, true, 'user')).toThrow('pending reviews');
  expect(() => follow.mutateFollowThrough(first, item.id, { action: 'state', revision: detail().revision, request_id: 'false-complete', phase: 'completed', reason: 'Done.' }, 'agent')).toThrow('Completion');
});

test('decline and reopen are durable; expired deferral becomes needs-you without sending', async () => {
  const { first, item, follow, detail, storeDraft, update } = await setup();
  const source = storeDraft();
  update({ action: 'review', source, review_revision: 1, decision: 'decline' });
  expect(detail().review_count).toBe(0);
  update({ action: 'review', source, review_revision: 2, decision: 'reopen' });
  expect(detail().phase).toBe('needs_you');
  update({ action: 'review', source, review_revision: 3, decision: 'defer', until: '2099-01-01T09:00:00Z' });
  expect(follow.followThroughSummary(first, follow.getTracked(first, item.id), new Date('2099-01-01T10:00:00Z')).phase).toBe('needs_you');
  expect(detail().reviews[0]).toMatchObject({ state: 'deferred' });
});

test('drafts have one review and inaccessible references never expose their content', async () => {
  const { first, item, session, messages, track, follow, detail, storeDraft, update, notifications } = await setup();
  const source = storeDraft();
  const otherItem = track.addTracked(first, { title: 'A different goal' }, 'user');
  expect(() => follow.mutateFollowThrough(first, otherItem.id, { action: 'link', reference: source, revision: 1, request_id: 'duplicate-review' }, 'agent')).toThrow('already belongs');
  for (const foreign of [session('foreign-owner', 'user-b'), session('foreign-agent', 'user-a', 'other-agent')]) {
    const id = messages.storeMessage({ sessionId: foreign.id, userId: 'assistant', role: 'assistant', content: 'Private result.', agentId: foreign.agent_id });
    expect(() => update({ action: 'link', reference: { kind: 'message', session_id: foreign.id, message_id: id } })).toThrow('not accessible');
    expect(track.listTracked(foreign)).toEqual([]);
    expect(() => track.noteTracked(foreign, item.id, 'Overwritten', 'agent')).toThrow();
  }
  expect(() => update({ action: 'link', reference: { ...source, message_id: 9999 } })).toThrow('not accessible');
  notifications.deleteWebNotificationSession(first.id);
  notifications.bindWebNotificationSession(first.id, notifications.notificationOperatorId('user-b'));
  expect(() => detail()).toThrow('another user');
});

test('real schedule ownership controls the next check, including pause, deletion and id reuse', async () => {
  const { first, item, track, detail, jobs } = await setup();
  expect(detail().next_check).toBeNull();
  const scheduled = track.editTracked(first, item.id, { every: [1, 2, 3, 4, 5], at: '09:00', tz: 'Europe/Berlin' });
  expect(detail().next_check).toMatchObject({ task_id: scheduled.checkTaskId, at: expect.any(String) });
  jobs.setJobEnabled(scheduled.checkTaskId!, false);
  expect(detail().next_check).toBeNull();
  jobs.deleteJob(scheduled.checkTaskId!);
  jobs.createJob({ kind: 'scheduled_task', sessionId: first.id, channelId: 'web', prompt: 'Another task.', cronExpr: '0 9 * * *' });
  expect(detail().next_check).toBeNull();
});

test('recorded runs and confirmed actions do not complete the goal or claim a live worker after restart', async () => {
  const { first, item, work, workTool, detail, track } = await setup();
  work.startWork({ id: 'attempt-1', agentId: 'hy', owner: 'user-a', sessionId: first.id, runSessionId: 'worker', taskId: 1, trackedItem: { scope: 'web:hy', id: item.id } });
  const end = workTool.beginWork('worker', 'attempt-1');
  try { expect(detail().runs[0]).toMatchObject({ active: true }); } finally { end(); }
  expect(detail().runs[0]).toMatchObject({ active: false, completedAt: null });
  work.updateWork('attempt-1', (run) => { run.completedAt = new Date().toISOString(); run.actions = [{ toolCallId: 'attempt-1:tool:0', tool: 'example__send_mail', ok: true }]; });
  expect(detail().phase).toBe('in_progress');
  track.markTracked(first, item.id, true, 'user');
  expect(detail()).toMatchObject({ phase: 'completed', done: true, completed_by: 'user' });
});

test('command JSON and tool share the lifecycle contract; new fields preserve the existing goal list', async () => {
  const { first, item, commands, detail } = await setup();
  const run = (args: string[]) => commands.handleTrackCommand({ sessionId: first.id, userId: 'user-a', guildId: null, channelId: 'web', args: ['track', ...args] }, first);
  const list = JSON.parse(run(['list', '--json']).text);
  expect(list).toMatchObject({ version: 1, follow_through: { version: 1, reviews: true }, items: [{ id: item.id, done: false }] });
  expect(JSON.parse(run(['overview', '--json']).text).items[0]).toMatchObject({ phase: 'in_progress', revision: 1 });
  const body = { action: 'state', phase: 'blocked', reason: 'A date is missing.', revision: 1, request_id: 'phone-update' };
  const result = run(['update', String(item.id), Buffer.from(JSON.stringify(body)).toString('base64url'), '--json']);
  expect(JSON.parse(result.text)).toMatchObject({ applied: true, item: { phase: 'blocked', status: body.reason } });
  expect(JSON.parse(commands.runTrackToolAction({ sessionId: first.id, id: item.id, action: 'get' }).result).phase).toBe('blocked');
  expect(run(['update', String(item.id), 'not-json']).kind).toBe('error');
  expect(detail().revision).toBe(2);
});

test('foreground action receipts remain linked beyond the recent-receipts window and preserve failures', async () => {
  const { db, first, second, item, track, update, detail, storeDraft } = await setup();
  const { emitToolExecutionAuditEvents } = await import('../src/audit/audit-events.js');
  const { flushAuditTrail } = await import('../src/audit/audit-trail.js');
  const source = storeDraft();
  update({ action: 'review', source, review_revision: 1, decision: 'approve' });
  for (let index = 0; index < 105; index++) {
    emitToolExecutionAuditEvents({ sessionId: second.id, runId: `send-${index}`, toolExecutions: [{
      name: 'example__mail__send', arguments: JSON.stringify(draft), result: index === 0 ? 'Service unavailable' : 'Accepted',
      durationMs: 1, isError: index === 0, approvalTier: 'red', approvalDecision: 'approved_once',
    }] });
  }
  await flushAuditTrail();
  update({ action: 'link', reference: { kind: 'receipt', session_id: second.id, receipt_id: 'send-0:tool:1' } });
  expect(detail().evidence.at(-1)).toMatchObject({ receipt: { ok: false, proof: null } });
  update({ action: 'link', reference: { kind: 'receipt', session_id: second.id, receipt_id: 'send-1:tool:1' } });
  expect(detail().evidence.at(-1)).toMatchObject({ receipt: { ok: true, proof: { status: 'confirmed' } } });
  expect(detail().phase).not.toBe('completed');
  update({ action: 'state', phase: 'waiting', reason: 'Waiting for confirmation of the appointment.' });
  expect(detail()).toMatchObject({ phase: 'waiting', done: false });
  update({ action: 'complete', done: true });
  expect(detail()).toMatchObject({ phase: 'completed', completed_by: 'user' });
  expect(track.listTracked(first).find((entry) => entry.id === item.id)?.done?.by).toBe('user');
  db.closeDatabase(); db.initDatabase({ quiet: true });
  expect(detail(second)).toMatchObject({ phase: 'completed', completed_by: 'user', reviews: [{ state: 'approved' }] });
});

test('a removed source is unavailable without losing the recorded review or exposing its draft', async () => {
  const { second, messages, detail, storeDraft, notifications } = await setup();
  const source = storeDraft();
  // Revoke the source chat's binding while keeping access to the item on the second phone.
  notifications.deleteWebNotificationSession(source.session_id);
  notifications.bindWebNotificationSession(source.session_id, notifications.notificationOperatorId('user-b'));
  expect(detail(second).reviews).toEqual([{ source, unavailable: true }]);
  expect(JSON.stringify(detail(second))).not.toContain(draft.body);
  expect(messages.getSessionById(second.id)).not.toBeNull();
});

test('anonymous or conflicting turn identity cannot read or mutate a followed item', async () => {
  const { first, item, follow, turn, track } = await setup();
  const end = turn.beginTurnUser(first.id, undefined);
  try {
    expect(() => follow.getTracked(first, item.id)).toThrow('authenticated');
    expect(() => track.removeTracked(first, item.id)).toThrow('not found');
    expect(track.listTracked(first)).toEqual([]);
  } finally { end(); }
});

test('a draft finishing after user completion cannot reopen the outcome', async () => {
  const { first, item, track, detail, storeDraft } = await setup();
  track.markTracked(first, item.id, true, 'user');
  storeDraft();
  expect(detail()).toMatchObject({ phase: 'completed', reviews: [], completed_by: 'user' });
});

test('delivery cannot attach a different tracking scope’s identically numbered item', async () => {
  const { db, first, item, messages, work, follow, detail } = await setup();
  const origin = db.getOrCreateSession('separate-channel', null, 'discord', 'hy');
  work.startWork({ id: 'scoped-run', agentId: 'hy', owner: 'user-a', sessionId: origin.id, runSessionId: 'worker', taskId: 1 });
  const messageId = messages.storeMessage({ sessionId: first.id, userId: 'assistant', role: 'assistant', content: 'Prepared.', agentId: 'hy' });
  db.setMessageEmailDraft(messageId, { ...draft, track_id: item.id, reply: 'Prepared.' });
  work.updateWork('scoped-run', (run) => { run.sessionId = first.id; run.messageId = messageId; });
  follow.recordTrackedDraft(first.id, messageId, 'scoped-run');
  expect(detail().reviews).toEqual([]);
});
