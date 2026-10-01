import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-todos-',
});

// 10:00 in Berlin on a Wednesday.
const WEDNESDAY = new Date('2026-09-30T08:00:00Z');
const later = (days: number, hours = 0) =>
  new Date(WEDNESDAY.getTime() + (days * 24 + hours) * 60 * 60 * 1000);

async function load() {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { getSessionById } = await import('../src/memory/sessions.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { getAllJobs, getJob } = await import('../src/memory/jobs.ts');
  const store = await import('../src/todos/todo-store.ts');
  const { runTodoToolAction } = await import('../src/todos/todo-command.ts');
  initDatabase({ quiet: true });

  const run = async (sessionId: string, args: string[], channelId = 'web') => {
    const result = await handleGatewayCommand({
      sessionId,
      guildId: null,
      channelId,
      args: ['todo', ...args],
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
  const reminderOf = (id: number, chat: Awaited<ReturnType<typeof session>>) => {
    const todo = store.listTodos(chat).find((candidate) => candidate.id === id);
    return todo?.reminderTaskId
      ? getJob(todo.reminderTaskId, { kind: 'scheduled_task' })
      : null;
  };
  const allTasks = () => getAllJobs({ kind: 'scheduled_task' });
  return { run, session, getJob, store, runTodoToolAction, reminderOf, allTasks };
}

test('an app adds a daily todo with a reminder and checks it off', async () => {
  const { run, session, reminderOf } = await load();

  const added = await run('app-chat', [
    'add',
    '--json',
    '--repeat',
    'daily',
    '--remind',
    '19:00',
    '--tz',
    'Europe/Berlin',
    'Chinese',
    '·',
    '30',
    'min',
  ]);
  expect(added.json.todo).toMatchObject({
    id: 1,
    title: 'Chinese · 30 min',
    repeat: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
    remind: '19:00',
    tz: 'Europe/Berlin',
    due_today: true,
    done: false,
    done_by: null,
    streak: 0,
  });
  expect(reminderOf(1, await session('app-chat'))).toMatchObject({
    cron_expr: '0 19 * * *',
    tz: 'Europe/Berlin',
    session_id: 'app-chat',
  });

  const done = await run('app-chat', ['done', '#1', '--json']);
  expect(done.json.todo).toMatchObject({
    done: true,
    done_by: 'user',
    streak: 1,
  });

  const listed = await run('app-chat', ['list', '--json']);
  expect(listed.json).toMatchObject({ version: 1, todos: [{ id: 1 }] });
  expect(listed.text).not.toContain('\n');
});

test.each([
  [['add'], 'needs a title'],
  [['add', '--repeat', 'sometimes', 'Read'], 'Repeat is'],
  [['add', '--remind', '7pm', 'Read'], 'HH:MM'],
  [['add', '--due', '2026-02-30', 'Read'], 'YYYY-MM-DD'],
  [['add', '--tz', 'Mars/Olympus', 'Read'], 'not a time zone'],
  [['done', '9'], 'not found'],
  [['frobnicate'], 'Usage'],
])('`/todo %j` is refused', async (args, message) => {
  const { run } = await load();
  const answer = await run('app-chat', args);
  expect(answer.kind).toBe('error');
  expect(answer.text).toContain(message);
});

test('a repeating todo opens again each day and counts its streak', async () => {
  const { session, store } = await load();
  const chat = await session('app-chat');
  const todo = store.addTodo(
    chat,
    { title: 'Walk', repeat: [1, 3, 5], tz: 'Europe/Berlin' },
    WEDNESDAY,
  );

  store.markTodo(chat, todo.id, true, 'user', '2026-09-28', WEDNESDAY);
  store.markTodo(chat, todo.id, true, 'agent', null, WEDNESDAY);
  const view = (now: Date) =>
    store.todoView(
      store.listTodos(chat, now).find((each) => each.id === todo.id)!,
      now,
    );
  expect(view(WEDNESDAY)).toMatchObject({
    done: true,
    done_by: 'agent',
    streak: 2,
    recent: ['2026-09-28', '2026-09-30'],
  });

  // Thursday is not a walking day; the streak holds.
  expect(view(later(1))).toMatchObject({
    due_today: false,
    done: false,
    streak: 2,
  });
  // Friday is open until it ends; Saturday sees it missed.
  expect(view(later(2))).toMatchObject({ due_today: true, streak: 2 });
  expect(view(later(3))).toMatchObject({ streak: 0 });
});

test('check-offs are limited to the past week, and one-offs to today', async () => {
  const { session, store } = await load();
  const chat = await session('app-chat');
  const habit = store.addTodo(
    chat,
    { title: 'Stretch', repeat: [0, 1, 2, 3, 4, 5, 6], tz: 'UTC' },
    WEDNESDAY,
  );
  const once = store.addTodo(chat, { title: 'Call Anna', tz: 'UTC' }, WEDNESDAY);

  expect(() =>
    store.markTodo(chat, habit.id, true, 'user', '2026-09-23', WEDNESDAY),
  ).toThrow(store.TodoError);
  expect(() =>
    store.markTodo(chat, habit.id, true, 'user', '2026-10-01', WEDNESDAY),
  ).toThrow(store.TodoError);
  expect(() =>
    store.markTodo(chat, once.id, true, 'user', '2026-09-29', WEDNESDAY),
  ).toThrow(store.TodoError);
});

test('a one-off stays listed on the day it was done, then goes with its reminder', async () => {
  const { session, store, getJob } = await load();
  const chat = await session('app-chat');
  const once = store.addTodo(
    chat,
    { title: 'Call Anna', remind: '18:00', tz: 'Europe/Berlin' },
    WEDNESDAY,
  );
  const taskId = once.reminderTaskId ?? 0;
  expect(getJob(taskId, { kind: 'scheduled_task' })?.run_at).toBe(
    '2026-09-30T16:00:00.000Z',
  );

  store.markTodo(chat, once.id, true, 'user', null, WEDNESDAY);
  expect(store.isTodoReminderSettled(taskId, WEDNESDAY)).toBe(true);
  expect(store.listTodos(chat, WEDNESDAY)).toHaveLength(1);

  store.addTodo(chat, { title: 'Next', tz: 'Europe/Berlin' }, later(1));
  expect(store.listTodos(chat, later(1)).map((todo) => todo.title)).toEqual([
    'Next',
  ]);
  expect(getJob(taskId, { kind: 'scheduled_task' })).toBeNull();
});

test('a one-off reminder for a time already past is not scheduled', async () => {
  const { session, store } = await load();
  const chat = await session('app-chat');
  const once = store.addTodo(
    chat,
    { title: 'Coffee', remind: '07:00', tz: 'Europe/Berlin' },
    WEDNESDAY,
  );
  expect(once.reminderTaskId).toBeNull();
});

test('a reminder is settled only while its todo is done for the day', async () => {
  const { session, store } = await load();
  const chat = await session('app-chat');
  const habit = store.addTodo(
    chat,
    { title: 'Read', repeat: [0, 1, 2, 3, 4, 5, 6], remind: '21:00', tz: 'UTC' },
    WEDNESDAY,
  );
  const taskId = habit.reminderTaskId ?? 0;
  expect(store.isTodoReminderSettled(taskId, WEDNESDAY)).toBe(false);
  store.markTodo(chat, habit.id, true, 'user', null, WEDNESDAY);
  expect(store.isTodoReminderSettled(taskId, WEDNESDAY)).toBe(true);
  expect(store.isTodoReminderSettled(taskId, later(1))).toBe(false);
});

test('editing replaces the reminder, removing deletes it', async () => {
  const { run, allTasks } = await load();
  await run('app-chat', ['add', '--repeat', 'daily', '--remind', '19:00', 'Read']);
  expect(allTasks().map((task) => task.cron_expr)).toEqual(['0 19 * * *']);

  await run('app-chat', ['edit', '1', '--repeat', 'weekdays', '--remind', '20:30']);
  expect(allTasks().map((task) => task.cron_expr)).toEqual([
    '30 20 * * 1,2,3,4,5',
  ]);

  await run('app-chat', ['edit', '1', '--remind', 'off']);
  expect(allTasks()).toEqual([]);

  await run('app-chat', ['edit', '1', '--remind', '07:15']);
  expect(allTasks()).toHaveLength(1);
  const removed = await run('app-chat', ['remove', '1', '--json']);
  expect(removed.json).toEqual({ version: 1, removed: 1 });
  expect(allTasks()).toEqual([]);
});

test('a reminder removed with /schedule does not take a later task with it', async () => {
  const { run, allTasks, session, store } = await load();
  await run('app-chat', ['add', '--repeat', 'daily', '--remind', '19:00', 'Read']);
  const [reminder] = allTasks();
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
  await schedule(['remove', String(reminder.id)]);
  await schedule(['add', '"0 8 * * *"', 'Morning briefing']);
  const [briefing] = allTasks();
  expect(briefing.id).toBe(reminder.id);

  const chat = await session('app-chat');
  store.markTodo(chat, 1, true, 'user');
  expect(store.isTodoReminderSettled(briefing.id)).toBe(false);
  await run('app-chat', ['remove', '1']);
  expect(allTasks().map((task) => task.prompt)).toEqual(['Morning briefing']);
});

test('web chats of one agent share a list; other chats keep their own', async () => {
  const { run } = await load();
  await run('app-chat', ['add', 'Chinese']);

  const otherWebChat = await run('other-web-chat', ['list', '--json']);
  expect(otherWebChat.json.todos).toMatchObject([{ title: 'Chinese' }]);

  const discord = await run('discord-chat', ['list', '--json'], '12345');
  expect(discord.json.todos).toEqual([]);
});

test('the agent checks a todo off through its tool, recorded as its own', async () => {
  const { run, runTodoToolAction } = await load();
  await run('app-chat', ['add', '--repeat', 'daily', 'Chinese']);

  const result = runTodoToolAction({
    sessionId: 'app-chat',
    action: 'done',
    id: 1,
  });
  expect(result.ok).toBe(true);
  expect(result.result).toContain('#1');

  const listed = await run('app-chat', ['list', '--json']);
  expect(listed.json.todos).toMatchObject([{ done: true, done_by: 'agent' }]);

  const added = runTodoToolAction({
    sessionId: 'app-chat',
    action: 'add',
    title: 'Pay rent',
    due: '2026-10-01',
  });
  expect(added.result).toContain('Pay rent');
});

test.each([
  [{ sessionId: 'app-chat', action: 'explode' }, 400],
  [{ sessionId: 'app-chat', action: 'done' }, 400],
  [{ sessionId: 'app-chat', action: 'done', id: 42 }, 400],
  [{ sessionId: 'nobody', action: 'list' }, 404],
  ['not an object', 400],
])('the tool service refuses %j', async (body, status) => {
  const { session, runTodoToolAction } = await load();
  await session('app-chat');
  expect(() => runTodoToolAction(body)).toThrow(
    expect.objectContaining({ statusCode: status }),
  );
});

test('open todos for today reach the per-turn context, done ones do not', async () => {
  const { session, store } = await load();
  const chat = await session('app-chat');
  expect(store.renderOpenTodosContext('app-chat', WEDNESDAY)).toBe('');

  const open = store.addTodo(
    chat,
    { title: 'Chinese', repeat: [0, 1, 2, 3, 4, 5, 6], tz: 'UTC' },
    WEDNESDAY,
  );
  const done = store.addTodo(chat, { title: 'Stretch', tz: 'UTC' }, WEDNESDAY);
  store.addTodo(
    chat,
    { title: 'Taxes', due: '2026-10-15', tz: 'UTC' },
    WEDNESDAY,
  );
  store.markTodo(chat, done.id, true, 'user', null, WEDNESDAY);

  const context = store.renderOpenTodosContext('app-chat', WEDNESDAY);
  expect(context).toContain(`#${open.id} "Chinese"`);
  expect(context).not.toContain('Stretch');
  expect(context).not.toContain('Taxes');
  expect(store.renderOpenTodosContext('unknown', WEDNESDAY)).toBe('');
});

test('a turn sees open todos unless the todo tool is blocked', async () => {
  const { run } = await load();
  await run('app-chat', ['add', '--repeat', 'daily', 'Chinese']);
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
  expect(lastMessage()).toContain('"Chinese"');
  expect(lastMessage(['todo'])).not.toContain('"Chinese"');
});
