import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-tracking-',
});

const NOW = new Date('2026-10-01T08:00:00Z');

async function load() {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { getSessionById } = await import('../src/memory/sessions.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { getAllJobs } = await import('../src/memory/jobs.ts');
  const store = await import('../src/tracking/track-store.ts');
  const { runTrackToolAction } = await import(
    '../src/tracking/track-command.ts'
  );
  initDatabase({ quiet: true });

  const run = async (sessionId: string, args: string[], channelId = 'web') => {
    const result = await handleGatewayCommand({
      sessionId,
      guildId: null,
      channelId,
      args: ['track', ...args],
    });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(result.text);
    } catch {}
    return { kind: result.kind, text: result.text, json };
  };
  const session = async (sessionId: string, channelId = 'web') => {
    await run(sessionId, ['list'], channelId);
    const found = getSessionById(sessionId);
    if (!found) throw new Error(`no session ${sessionId}`);
    return found;
  };
  const allTasks = () => getAllJobs({ kind: 'scheduled_task' });
  return { run, session, store, runTrackToolAction, allTasks };
}

test('an app adds a goal with an outcome and steps, and checks it off', async () => {
  const { run } = await load();

  const added = await run('app-chat', [
    'add',
    '--json',
    '--kind',
    'goal',
    'Sleep',
    'through',
    'the',
    'night',
  ]);
  expect(added.json.item).toMatchObject({
    id: 1,
    kind: 'goal',
    title: 'Sleep through the night',
    outcome: null,
    status: null,
    steps: [],
    every: null,
    done: false,
    created_by: 'user',
  });

  await run('app-chat', ['outcome', '1', 'Eight', 'hours,', 'no', 'waking']);
  await run('app-chat', ['step', '1', 'add', 'No', 'coffee', 'after', '2']);
  await run('app-chat', ['step', '1', 'add', '--json', 'Bed', 'by', '23:00']);
  await run('app-chat', ['step', '#1', 'done', '1']);
  const noted = await run('app-chat', [
    'status',
    '1',
    '--json',
    'Week',
    'one',
    'went',
    'well',
  ]);
  expect(noted.json.item).toMatchObject({
    outcome: 'Eight hours, no waking',
    status: 'Week one went well',
    status_by: 'user',
    steps: [
      { id: 1, title: 'No coffee after 2', done: true },
      { id: 2, title: 'Bed by 23:00', done: false },
    ],
  });

  const done = await run('app-chat', ['done', '1', '--json']);
  expect(done.json.item).toMatchObject({ done: true, done_by: 'user' });

  const listed = await run('app-chat', ['list', '--json']);
  expect(listed.json).toMatchObject({ version: 1, items: [{ id: 1 }] });
  expect(listed.text).not.toContain('\n');
});

test.each([
  [['add'], 'needs a title'],
  [['add', '--kind', 'dream', 'Read'], '`goal` or `tracking`'],
  [['add', '--every', 'sometimes', 'Read'], 'Check-ins are'],
  [['add', '--at', '7pm', 'Read'], 'HH:MM'],
  [['add', '--tz', 'Mars/Olympus', 'Read'], 'not a time zone'],
  [['done', '9'], 'not found'],
  [['status', '9', 'x'], 'not found'],
  [['step', '1', 'explode', '1'], 'Usage'],
  [['frobnicate'], 'Usage'],
])('`/track %j` is refused', async (args, message) => {
  const { run } = await load();
  await run('app-chat', ['add', 'Existing']);
  const answer = await run('app-chat', args);
  expect(answer.kind).toBe('error');
  expect(answer.text).toContain(message);
});

test('a check-in follows its item: moved on edit, gone once done or removed', async () => {
  const { run, allTasks } = await load();
  await run('app-chat', [
    'add',
    '--kind',
    'tracking',
    '--every',
    'daily',
    '--tz',
    'Europe/Berlin',
    'Airline',
    'refund',
  ]);
  expect(allTasks()).toMatchObject([
    {
      cron_expr: '0 9 * * *',
      tz: 'Europe/Berlin',
      session_id: 'app-chat',
      prompt: expect.stringContaining('#1 "Airline refund" (tracking)'),
    },
  ]);

  // A status line leaves the task alone, so its run history stays.
  const [first] = allTasks();
  await run('app-chat', ['status', '1', 'Claim', 'filed']);
  expect(allTasks().map((task) => task.id)).toEqual([first.id]);

  await run('app-chat', ['edit', '1', '--every', 'mon,thu', '--at', '18:30']);
  expect(allTasks().map((task) => task.cron_expr)).toEqual([
    '30 18 * * 1,4',
  ]);
  await run('app-chat', ['outcome', '1', 'Refund', 'posted']);
  expect(allTasks()[0].prompt).toContain('Desired outcome: Refund posted');

  await run('app-chat', ['done', '1']);
  expect(allTasks()).toEqual([]);
  await run('app-chat', ['undo', '1']);
  expect(allTasks()).toHaveLength(1);

  await run('app-chat', ['edit', '1', '--every', 'none']);
  expect(allTasks()).toEqual([]);
  await run('app-chat', ['edit', '1', '--every', 'weekdays']);
  const removed = await run('app-chat', ['remove', '1', '--json']);
  expect(removed.json).toEqual({ version: 1, removed: 1 });
  expect(allTasks()).toEqual([]);
});

test('a check-in removed with /schedule does not take a later task with it', async () => {
  const { run, allTasks } = await load();
  await run('app-chat', ['add', '--every', 'daily', 'Refund']);
  const [check] = allTasks();
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const schedule = (args: string[]) =>
    handleGatewayCommand({
      sessionId: 'app-chat',
      guildId: null,
      channelId: 'web',
      args: ['schedule', ...args],
    });
  await schedule(['remove', String(check.id)]);
  await schedule(['add', '"0 8 * * *"', 'Morning briefing']);
  expect(allTasks()[0].id).toBe(check.id);

  await run('app-chat', ['remove', '1']);
  expect(allTasks().map((task) => task.prompt)).toEqual(['Morning briefing']);
});

test('a goal check-in always writes to the user; a tracked item only on news', async () => {
  const { run, allTasks } = await load();
  await run('app-chat', ['add', '--every', 'daily', 'Half', 'marathon']);
  await run('app-chat', [
    'add',
    '--kind',
    'tracking',
    '--every',
    'daily',
    'Refund',
  ]);

  const prompts = allTasks().map((task) => task.prompt);
  const goal = prompts.find((prompt) => prompt.includes('#1 '));
  const watch = prompts.find((prompt) => prompt.includes('#2 '));
  expect(goal).toMatch(/^\[Goal check-in\] #1 "Half marathon"\./);
  expect(goal).toContain('check in with the user');
  expect(goal).not.toContain('__MESSAGE_SEND_HANDLED__');
  expect(watch).toMatch(/^\[Tracking check-in\] #2 "Refund" \(tracking\)\./);
  expect(watch).toContain(
    'Otherwise reply with exactly __MESSAGE_SEND_HANDLED__',
  );
});

test('a goal does not adopt a historical tracking-style check-in', async () => {
  const { run, allTasks } = await load();
  await run('app-chat', [
    'add', '--kind', 'tracking', '--every', 'daily', 'Half', 'marathon',
  ]);
  const historicalPrompt = allTasks()[0].prompt.replace('(tracking)', '(goal)');
  await run('app-chat', ['edit', '1', '--kind', 'goal']);
  const [check] = allTasks();
  const { updateScheduledTask } = await import('../src/memory/jobs.ts');
  updateScheduledTask(check.id, {
    cronExpr: check.cron_expr,
    tz: check.tz,
    channelId: check.channel_id,
    prompt: historicalPrompt,
  });

  await run('app-chat', ['status', '1', 'Ran', '12', 'km']);
  expect(allTasks()).toHaveLength(2);
  expect(allTasks().map((task) => task.prompt)).toEqual(
    expect.arrayContaining([
      historicalPrompt,
      expect.stringMatching(/^\[Goal check-in\] #1 "Half marathon"\./),
    ]),
  );
  await run('app-chat', ['remove', '1']);
  expect(allTasks().map((task) => task.prompt)).toEqual([
    historicalPrompt,
  ]);
});

test('status lines keep the newest twenty; completion preserves goal history', async () => {
  const { session, store } = await load();
  const chat = await session('app-chat');
  const item = store.addTracked(chat, { title: 'Marathon' }, 'user', NOW);
  for (let n = 1; n <= 25; n += 1) {
    store.noteTracked(chat, item.id, `Week ${n}`, 'agent', NOW);
  }
  const [listed] = store.listTracked(chat);
  expect(listed.notes).toHaveLength(20);
  expect(store.trackedView(listed)).toMatchObject({
    status: 'Week 25',
    status_by: 'agent',
  });

  store.markTracked(chat, item.id, true, 'user', NOW);
  const later = new Date(NOW.getTime() + 91 * 24 * 60 * 60 * 1000);
  store.addTracked(chat, { title: 'Next' }, 'user', later);
  expect(store.listTracked(chat).map((each) => each.title)).toEqual(['Marathon', 'Next']);
  expect(store.listTracked(chat)[0].notes).toEqual(listed.notes);
});

test('web chats of one agent share a list; other chats keep their own', async () => {
  const { run } = await load();
  await run('app-chat', ['add', 'Marathon']);

  const otherWebChat = await run('other-web-chat', ['list', '--json']);
  expect(otherWebChat.json.items).toMatchObject([{ title: 'Marathon' }]);

  const discord = await run('discord-chat', ['list', '--json'], '12345');
  expect(discord.json.items).toEqual([]);
});

test('the agent adds and updates items through its tool, recorded as its own', async () => {
  const { run, session, runTrackToolAction, allTasks } = await load();
  await session('app-chat');

  const added = runTrackToolAction({
    sessionId: 'app-chat',
    action: 'add',
    title: 'Ticket prices for Boston',
    kind: 'tracking',
    outcome: 'Two seats under $300',
    status: 'Cheapest is $410',
    every: 'daily',
    at: '07:30',
  });
  expect(added.result).toContain('#1 tracking "Ticket prices for Boston"');
  expect(allTasks().map((task) => task.cron_expr)).toEqual(['30 7 * * *']);

  runTrackToolAction({
    sessionId: 'app-chat',
    action: 'add_step',
    id: 1,
    step: 'Set a fare alert',
  });
  runTrackToolAction({
    sessionId: 'app-chat',
    action: 'step_done',
    id: 1,
    step_id: 1,
  });
  const noted = runTrackToolAction({
    sessionId: 'app-chat',
    action: 'status',
    id: 1,
    status: 'Dropped to $350',
  });
  expect(noted.result).toContain('status: "Dropped to $350" (you,');

  const listed = await run('app-chat', ['list', '--json']);
  expect(listed.json.items).toMatchObject([
    {
      created_by: 'agent',
      outcome: 'Two seats under $300',
      status: 'Dropped to $350',
      status_by: 'agent',
      notes: [{ text: 'Cheapest is $410' }, { text: 'Dropped to $350' }],
      steps: [{ title: 'Set a fare alert', done: true }],
      every: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
      at: '07:30',
    },
  ]);

  runTrackToolAction({ sessionId: 'app-chat', action: 'done', id: 1 });
  const done = await run('app-chat', ['list', '--json']);
  expect(done.json.items).toMatchObject([{ done: true, done_by: 'agent' }]);
  expect(allTasks()).toEqual([]);
});

test('the agent sets the zone of a check-in; a made-up zone gets a hint', async () => {
  const { session, runTrackToolAction, allTasks } = await load();
  await session('app-chat');

  const added = runTrackToolAction({
    sessionId: 'app-chat',
    action: 'add',
    title: 'Half marathon',
    every: 'daily',
    at: '07:15',
    tz: 'Europe/Berlin',
  });
  expect(added.result).toContain('you check in daily at 07:15 Europe/Berlin');
  expect(allTasks()).toMatchObject([
    { cron_expr: '15 7 * * *', tz: 'Europe/Berlin' },
  ]);
  expect(() =>
    runTrackToolAction({
      sessionId: 'app-chat',
      action: 'edit',
      id: 1,
      tz: 'Europe/Munich',
    }),
  ).toThrow('use an IANA name such as `Europe/Berlin`');
});

test.each([
  [{ sessionId: 'app-chat', action: 'explode' }, 400],
  [{ sessionId: 'app-chat', action: 'status' }, 400],
  [{ sessionId: 'app-chat', action: 'status', id: 42, status: 'x' }, 400],
  [{ sessionId: 'app-chat', action: 'status', id: 1 }, 400],
  [{ sessionId: 'app-chat', action: 'step_done', id: 1, step_id: 9 }, 400],
  [{ sessionId: 'nobody', action: 'list' }, 404],
  ['not an object', 400],
])('the tool service refuses %j', async (body, status) => {
  const { run, runTrackToolAction } = await load();
  await run('app-chat', ['add', 'Existing']);
  expect(() => runTrackToolAction(body)).toThrow(
    expect.objectContaining({ statusCode: status }),
  );
});

test('open items reach the per-turn context, done ones do not', async () => {
  const { session, store } = await load();
  const chat = await session('app-chat');
  expect(store.renderTrackedContext('app-chat')).toBe('');

  const open = store.addTracked(
    chat,
    { title: 'Refund', kind: 'tracking', every: [1], tz: 'UTC' },
    'user',
    NOW,
  );
  store.noteTracked(chat, open.id, 'Claim filed', 'user', NOW);
  const done = store.addTracked(chat, { title: 'Passport' }, 'user', NOW);
  store.markTracked(chat, done.id, true, 'agent', NOW);

  const context = store.renderTrackedContext('app-chat');
  expect(context).toContain(
    `#${open.id} tracking "Refund" — status: "Claim filed" (user, 2026-10-01) — you check in mon at 09:00 UTC`,
  );
  expect(context).not.toContain('Passport');
  expect(store.renderTrackedContext('unknown')).toBe('');
});

test('a turn sees open goals unless the track tool is blocked', async () => {
  const { run } = await load();
  await run('app-chat', ['add', 'Marathon']);
  const { buildConversationContext } = await import(
    '../src/agent/conversation.ts'
  );
  const { buildSessionContext } = await import(
    '../src/session/session-context.ts'
  );
  const sessionContext = buildSessionContext({
    source: {
      channelKind: 'web',
      chatId: 'web',
      chatType: 'dm',
      userId: 'user_a',
      userName: 'user_a',
      guildId: null,
    },
    agentId: 'main',
    sessionId: 'app-chat',
  });
  const lastMessage = (blockedTools?: string[]) => {
    const { messages } = buildConversationContext({
      agentId: 'main',
      history: [],
      runtimeInfo: { sessionContext },
      blockedTools,
    });
    return String(messages.at(-1)?.content);
  };
  expect(lastMessage()).toContain('"Marathon"');
  expect(lastMessage(['track'])).not.toContain('"Marathon"');
});

test('`/help` in a web chat lists `/track`, which apps probe for', async () => {
  const { session } = await load();
  await session('app-chat');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const help = await handleGatewayCommand({
    sessionId: 'app-chat',
    guildId: null,
    channelId: 'web',
    args: ['help'],
  });
  expect(help.text).toContain('`/track`');
  expect(help.text).toContain('`/todo`');
});


test('goal runs use current unfinished steps and status, while watches stay read-only', async () => {
  const { run, allTasks, store } = await load();
  await run('app-chat', ['add', '--every', 'daily', 'Prepare proposal']);
  await run('app-chat', ['step', '1', 'add', 'Research options']);
  await run('app-chat', ['step', '1', 'add', 'Draft proposal']);
  await run('app-chat', ['step', '1', 'done', '1']);
  await run('app-chat', ['status', '1', 'Research prepared']);
  const [task] = allTasks();
  const prompt = store.trackedTaskPrompt(task.id, task.prompt);
  expect(prompt).toContain('"nextStep":{"id":2,"title":"Draft proposal"}');
  expect(prompt).toContain('"status":"Research prepared"');
  expect(prompt).not.toContain('"title":"Research options"');
  await run('app-chat', ['add', '--kind', 'tracking', '--every', 'daily', 'Refund']);
  const watch = allTasks().find((item) => item.id !== task.id)!;
  expect(store.trackedTaskPrompt(watch.id, watch.prompt)).toBe(watch.prompt);
  await run('app-chat', ['done', '1']);
  expect(store.trackedTaskPrompt(task.id, 'unrelated replacement')).toBe('unrelated replacement');
});


test('prepared goal results survive reload, edits and completion with their actual file bytes', async () => {
  const { run, session, store, runTrackToolAction, allTasks } = await load();
  const chat = await session('app-chat');
  await run('app-chat', ['add', '--every', 'daily', 'Training plan']);
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const workspace = agentWorkspaceDir(chat.agent_id);
  fs.mkdirSync(path.join(workspace, 'goals'), { recursive: true });
  const file = path.join(workspace, 'goals/plan.md');
  fs.writeFileSync(file, 'Week one: three short runs.');
  const reply = runTrackToolAction({ sessionId: chat.id, action: 'result', id: 1,
    title: 'Week one plan', summary: 'Three short runs with recovery days.', path: 'goals/plan.md' });
  const goal = store.listTracked(chat)[0];
  const result = goal.results![0];
  expect(reply.result).toContain(result.path);
  expect(result).toMatchObject({ title: 'Week one plan', summary: 'Three short runs with recovery days.' });
  expect(Date.parse(result.at)).not.toBeNaN();
  fs.writeFileSync(file, 'Revised original');
  expect(fs.readFileSync(result.path, 'utf8')).toBe('Week one: three short runs.');
  const listed = await run(chat.id, ['list', '--json']);
  expect(listed.json.items).toMatchObject([{ results: [result], status: null }]);
  expect(runTrackToolAction({ sessionId: chat.id, action: 'list' }).result).toContain(result.path);
  const task = allTasks()[0];
  expect(store.trackedTaskPrompt(task.id, task.prompt)).toContain(result.id);
  expect(store.trackedTaskPrompt(task.id, task.prompt)).toContain('action "result"');
  store.markTracked(chat, 1, true, 'user', NOW);
  store.addTracked(chat, { title: 'Another goal' }, 'user', new Date('2027-10-01T08:00:00Z'));
  expect(store.listTracked(chat).find((item) => item.id === 1)?.results).toEqual([result]);
  store.markTracked(chat, 1, false, 'user');
  expect(store.listTracked(chat)[0].results).toEqual([result]);
  store.removeTracked(chat, 1);
  expect(store.listTracked(chat).some((item) => item.id === 1)).toBe(false);
});

test('goal results reject missing, escaping, directory and oversized files without recording work', async () => {
  const { run, session, store, runTrackToolAction } = await load();
  const chat = await session('app-chat');
  await run(chat.id, ['add', 'Prepare proposal']);
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const workspace = agentWorkspaceDir(chat.agent_id);
  fs.mkdirSync(path.join(workspace, 'goals'), { recursive: true });
  const outside = path.join(workspace, '../outside.md');
  fs.writeFileSync(outside, 'Private outside file');
  fs.symlinkSync(outside, path.join(workspace, 'goals/escape.md'));
  const huge = path.join(workspace, 'goals/huge.pdf');
  fs.writeFileSync(huge, '');
  fs.truncateSync(huge, 25 * 1024 * 1024 + 1);
  for (const file of ['goals/missing.md', '../outside.md', outside, 'goals', 'goals/escape.md', 'goals/huge.pdf']) {
    expect(() => runTrackToolAction({ sessionId: chat.id, action: 'result', id: 1,
      title: 'Proposal', summary: 'Draft prepared', path: file })).toThrow(expect.objectContaining({ statusCode: 400 }));
  }
  expect(store.listTracked(chat)[0].results).toEqual([]);
  expect(fs.readdirSync(workspace).some((file) => file.startsWith('.goal-result-'))).toBe(false);
  fs.writeFileSync(path.join(workspace, 'goals/proposal.md'), 'Actual draft');
  expect(() => runTrackToolAction({ sessionId: chat.id, action: 'result', id: 1,
    title: 'Proposal', path: 'goals/proposal.md' })).toThrow('needs a title and summary');
  // An unrelated chat cannot attach work to this web owner's goal.
  const other = await session('other-chat', 'discord');
  expect(() => store.resultTracked(other, 1, { title: 'Proposal', summary: 'Draft', path: 'goals/proposal.md' })).toThrow('not found');
  expect(store.listTracked(chat)[0].results).toEqual([]);
});
