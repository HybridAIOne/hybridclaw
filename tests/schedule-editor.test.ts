import { afterEach, expect, test, vi } from 'vitest';
import { useTempDir } from './test-utils.js';

const makeHome = useTempDir('hy-schedule-editor-');
let close: (() => void) | undefined;
afterEach(() => { close?.(); close = undefined; vi.unstubAllEnvs(); vi.resetModules(); });
vi.mock('../src/agents/agent-registry.js', () => ({ resolveAgentForRequest: () => ({ model: 'hybridai/qwen/qwen3.8-27b', agentId: 'main', chatbotId: 'test' }) }));
vi.mock('../src/providers/model-catalog.js', () => ({ getAvailableModelList: () => ['hybridai/qwen/qwen3.8-27b', 'openai/gpt-4o'] }));
vi.mock('../src/scheduler/scheduler.js', () => ({ rearmScheduler: vi.fn(), dbTaskLabel: (id: number) => `task:${id}`, cronPromptHead: () => '[scheduled]' }));

async function setup() {
  vi.stubEnv('HOME', makeHome());
  const db = await import('../src/memory/db.js');
  const jobs = await import('../src/memory/jobs.js');
  const { handleScheduleCommand } = await import('../src/gateway/schedule-command.js');
  db.initDatabase({ quiet: true }); close = db.closeDatabase;
  const session = db.getOrCreateSession('chat-a', null, 'web', 'main');
  const id = jobs.createJob({kind: 'scheduled_task', sessionId: session.id, channelId: 'web', cronExpr: '0 * * * *', tz: 'Europe/Berlin', prompt: 'Original', replyOnly: true, alert: 'reminder', ownerUserId: 'user_a'});
  const run = (args: string[], requester = session) => handleScheduleCommand({sessionId: requester.id, guildId: null, channelId: requester.channel_id!, userId: 'user_a', args: ['schedule', ...args]}, requester);
  const value = {title: 'Availability', prompt: 'Check live\n  --json "quoted" \\n 😀', cron: '0 * * * *', tz: 'Europe/Berlin', run_at: null, every_ms: null, model: 'hybridai/qwen/qwen3.8-27b', effort: 'medium', fresh_session: true, enabled: false};
  const update = (data: unknown, requester = session) => run(['update', '--json', String(id), Buffer.from(JSON.stringify({...data as object, revision: JSON.parse(run(['list', '--json']).text).tasks[0].revision})).toString('base64url')], requester);
  return {db, jobs, session, id, run, value, update};
}

test('editing preserves identity, ownership, delivery, options and unchanged schedule history', async () => {
  const {jobs, id, run, value, update} = await setup();
  const before = jobs.getJob(id, {kind: 'scheduled_task'})!;
  const result = update(value);
  expect(result.kind).toBe('plain');
  const task = jobs.getJob(id, {kind: 'scheduled_task'})!;
  expect(task).toMatchObject({id, prompt: value.prompt, title: value.title, model: value.model, effort: 'medium', fresh_session: true, enabled: 0, owner_user_id: 'user_a', reply_only: true, alert: 'reminder', session_id: before.session_id, channel_id: 'web', last_run: before.last_run});
  expect(jobs.getAllJobs({kind: 'scheduled_task'})).toHaveLength(1);
  expect(JSON.parse(run(['list', '--json']).text).editor).toMatchObject({version: 1, models: [{id: 'hybridai/qwen/qwen3.8-27b', efforts: ['none', 'low', 'medium', 'xhigh']}, {id: 'openai/gpt-4o', efforts: []}]});
  expect(update({...value, model: null, effort: null, fresh_session: false}).kind).toBe('plain');
  expect(jobs.getJob(id, {kind: 'scheduled_task'})).toMatchObject({model: undefined, effort: undefined, fresh_session: false});
});

test('invalid edits do not mutate any task fields', async () => {
  const {jobs, id, value, update, run} = await setup();
  const before = jobs.getJob(id, {kind: 'scheduled_task'});
  for (const patch of [
    {prompt: ''}, {cron: 'nonsense'}, {tz: 'Unknown/Zone'}, {run_at: '2000-01-01T00:00:00Z'},
    {cron: null, every_ms: 1}, {model: 'missing'}, {model: 'openai/gpt-4o', effort: 'medium'},
    {effort: 'invalid'}, {enabled: 'false'}, {owner_user_id: 'other'}, {channelId: 'other'}, {fresh_session: 'true'},
  ]) {
    expect(update({...value, ...patch}).kind).toBe('error');
    expect(jobs.getJob(id, {kind: 'scheduled_task'})).toEqual(before);
  }
  expect(run(['update', '--json', String(id), 'invalid+json']).kind).toBe('error');
  expect(jobs.getJob(id, {kind: 'scheduled_task'})).toEqual(before);
});

test('another agent or messaging peer cannot edit a task; same-agent web chats can', async () => {
  const {db, jobs, id, value, update} = await setup();
  const stranger = db.getOrCreateSession('chat-b', null, 'web', 'other');
  const peer = db.getOrCreateSession('peer', null, 'discord', 'main');
  const before = jobs.getJob(id, {kind: 'scheduled_task'});
  for (const requester of [stranger, peer]) {
    expect(update(value, requester).kind).toBe('error');
    expect(jobs.getJob(id, {kind: 'scheduled_task'})).toEqual(before);
  }
  const sibling = db.getOrCreateSession('chat-c', null, 'web', 'main');
  expect(update(value, sibling).kind).toBe('plain');
});

test('switching schedule kinds clears competing fields and does not create a duplicate', async () => {
  const {jobs, id, value, update} = await setup();
  expect(update({...value, cron: null, every_ms: 60000}).kind).toBe('plain');
  expect(jobs.getJob(id, {kind: 'scheduled_task'})).toMatchObject({cron_expr: '', every_ms: 60000, run_at: null, last_run: null});
  const future = new Date(Date.now() + 3600000).toISOString();
  expect(update({...value, cron: null, run_at: future}).kind).toBe('plain');
  expect(jobs.getJob(id, {kind: 'scheduled_task'})).toMatchObject({cron_expr: '', every_ms: null, run_at: future});
});

test('a stale editor cannot overwrite a newer task edit', async () => {
  const {jobs, id, value, run, update} = await setup();
  const revision = JSON.parse(run(['list', '--json']).text).tasks[0].revision;
  expect(update(value).kind).toBe('plain');
  const before = jobs.getJob(id, {kind: 'scheduled_task'});
  const payload = Buffer.from(JSON.stringify({...value, revision, prompt: 'Stale'})).toString('base64url');
  expect(run(['update', '--json', String(id), payload]).kind).toBe('error');
  expect(jobs.getJob(id, {kind: 'scheduled_task'})).toEqual(before);
});

test('separate-session results remain available after the instructions change', async () => {
  const {db, session, id, value, run, update} = await setup();
  expect(update(value).kind).toBe('plain');
  const {memoryService} = await import('../src/memory/memory-service.js');
  memoryService.storeMessage({sessionId: session.id, userId: 'scheduler', username: null, role: 'assistant', content: 'Previous result', source: `schedule:${id}`});
  expect(update({...value, prompt: 'Changed instructions'}).kind).toBe('plain');
  expect(JSON.parse(run(['results', String(id), '--json']).text).results).toEqual([expect.objectContaining({text: 'Previous result'})]);
  expect(db.getSessionById(session.id)).not.toBeNull();
});
