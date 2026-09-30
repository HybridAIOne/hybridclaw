import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-schedule-',
});

const APP_CHAT = 'app-feed';
const PROMPT = 'Check the connected accounts and answer with a JSON array.';

async function load() {
  setupHome();
  const { initDatabase, createFreshSessionInstance, getSessionById } =
    await import('../src/memory/sessions.ts').then(async (sessions) => ({
      ...sessions,
      initDatabase: (await import('../src/memory/db.ts')).initDatabase,
    }));
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { chatSafeJson } = await import('../src/gateway/schedule-command.ts');
  initDatabase({ quiet: true });

  const run = async (
    sessionId: string,
    args: string[],
    channelId = 'web',
  ): Promise<{
    kind: string;
    title: string;
    text: string;
    json: Record<string, unknown>;
  }> => {
    const result = await handleGatewayCommand({
      sessionId,
      guildId: null,
      channelId,
      args: ['schedule', ...args],
    });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(result.text);
    } catch {}
    return { kind: result.kind, title: result.title ?? '', text: result.text, json };
  };

  /** A run of task `prompt` as the scheduler stores it: its prompt, then its reply. */
  const storeRun = (sessionId: string, prompt: string, reply: string) =>
    memoryService.storeTurn({
      sessionId,
      user: { userId: 'scheduler', username: 'scheduler', content: prompt },
      assistant: {
        userId: 'assistant',
        username: null,
        agentId: 'main',
        content: reply,
      },
    });

  return {
    run,
    storeRun,
    memoryService,
    createFreshSessionInstance,
    getSessionById,
    chatSafeJson,
  };
}

async function created(
  run: Awaited<ReturnType<typeof load>>['run'],
  sessionId = APP_CHAT,
  channelId = 'web',
): Promise<number> {
  const answer = await run(
    sessionId,
    ['add', '--json', '--tz', 'Europe/Berlin', '"*/30 8-21 * * *"', PROMPT],
    channelId,
  );
  const task = answer.json.task as { id: number };
  expect(task.id).toBeGreaterThan(0);
  return task.id;
}

test('an app can add a task and read it back as JSON', async () => {
  const { run } = await load();

  const added = await run(APP_CHAT, [
    'add',
    '--json',
    '--tz',
    'Europe/Berlin',
    '"*/30 8-21 * * *"',
    PROMPT,
  ]);

  expect(added.json).toMatchObject({
    version: 1,
    task: {
      enabled: true,
      cron: '*/30 8-21 * * *',
      tz: 'Europe/Berlin',
      prompt: PROMPT,
      last_status: null,
    },
  });
  const listed = await run(APP_CHAT, ['list', '--json']);
  expect(listed.json).toMatchObject({
    version: 1,
    tasks: [{ id: (added.json.task as { id: number }).id }],
    hidden: 0,
  });

  // The words of a prompt are never read as flags.
  const literal = await run(APP_CHAT, [
    'add',
    '"0 9 * * *"',
    'Summarize',
    '--json',
    'output',
  ]);
  expect(literal.text).toContain('Summarize --json output');
});

test('results are the replies of this task only, newest last', async () => {
  const { run, storeRun, memoryService } = await load();
  const taskId = await created(run);
  const other = await created(run);
  const otherPrompt = `${PROMPT} (other)`;
  await run(APP_CHAT, ['remove', String(other)]);

  storeRun(APP_CHAT, PROMPT, '[]');
  storeRun(APP_CHAT, otherPrompt, 'not this task');
  memoryService.storeMessage({
    sessionId: APP_CHAT,
    userId: 'user_a',
    username: 'web',
    role: 'user',
    content: PROMPT,
  });
  memoryService.storeMessage({
    sessionId: APP_CHAT,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: 'a reply to the user, not to the scheduler',
  });
  storeRun(APP_CHAT, PROMPT, '[{"title":"Answer Ben"}]\nsecond line');

  const all = await run(APP_CHAT, ['results', String(taskId), '--json']);
  const results = all.json.results as Array<{ text: string; created_at: string }>;
  expect(results.map((entry) => entry.text)).toEqual([
    '[]',
    '[{"title":"Answer Ben"}]\nsecond line',
  ]);
  expect(results[1].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  // One line, whatever the replies hold.
  expect(all.text).not.toContain('\n');

  const last = await run(APP_CHAT, [
    'results',
    String(taskId),
    '--limit',
    '1',
    '--json',
  ]);
  expect((last.json.results as unknown[]).length).toBe(1);

  const readable = await run(APP_CHAT, ['results', String(taskId)]);
  expect(readable.kind).toBe('info');
  expect(readable.text).toContain('Answer Ben');
});

test('a task stays with its chat when the chat gets a new session', async () => {
  const { run, storeRun, createFreshSessionInstance, getSessionById } =
    await load();
  const taskId = await created(run);
  storeRun(APP_CHAT, PROMPT, '[]');

  // What an idle or daily reset does.
  const fresh = createFreshSessionInstance(APP_CHAT).session;
  expect(fresh.id).not.toBe(APP_CHAT);
  expect(getSessionById(fresh.id)?.session_key).toBe(
    getSessionById(APP_CHAT)?.session_key,
  );

  // The reset moved the task on; its next run is stored in the new session.
  storeRun(fresh.id, PROMPT, '[{"title":"After the reset"}]');

  for (const sessionId of [APP_CHAT, fresh.id]) {
    const listed = await run(sessionId, ['list', '--json']);
    expect((listed.json.tasks as Array<{ id: number }>).map((t) => t.id)).toEqual(
      [taskId],
    );
    const results = await run(sessionId, ['results', String(taskId), '--json']);
    expect(
      (results.json.results as Array<{ text: string }>).map((r) => r.text),
    ).toEqual(['[]', '[{"title":"After the reset"}]']);
  }

  const removed = await run(fresh.id, ['remove', String(taskId), '--json']);
  expect(removed.json).toEqual({ version: 1, removed: taskId });
});

test.each([
  ['a Discord channel', 'discord-channel', '123456789012345678'],
  ['another web chat', 'other-web-chat', 'web'],
])('%s cannot read the results', async (_label, sessionId, channelId) => {
  const { run, storeRun } = await load();
  const taskId = await created(run);
  storeRun(APP_CHAT, PROMPT, '[{"title":"Private"}]');

  const results = await run(sessionId, ['results', String(taskId)], channelId);

  expect(results.kind).toBe('error');
  expect(results.text).not.toContain('Private');
});

test('a messaging chat cannot remove or toggle a task it does not own', async () => {
  const { run } = await load();
  const taskId = await created(run);

  for (const args of [
    ['remove', String(taskId)],
    ['toggle', String(taskId)],
  ]) {
    const answer = await run('discord-channel', args, '123456789012345678');
    expect(answer.kind).toBe('error');
  }
  const listed = await run(APP_CHAT, ['list', '--json']);
  expect(listed.json.tasks).toEqual([
    expect.objectContaining({ id: taskId, enabled: true }),
  ]);
  const elsewhere = await run(
    'discord-channel',
    ['list', '--json'],
    '123456789012345678',
  );
  expect(elsewhere.json.tasks).toEqual([]);
});

test('a web chat of the same agent may manage the task', async () => {
  const { run } = await load();
  const taskId = await created(run);

  const toggled = await run('other-web-chat', ['toggle', String(taskId), '--json']);

  expect(toggled.json).toMatchObject({ task: { id: taskId, enabled: false } });
});

test.each([
  [['add', '--tz', 'Mars/Olympus', '"0 9 * * *"', PROMPT], 'Invalid Time Zone'],
  [['add', '--tz', 'UTC', 'every', '60000', PROMPT], 'Usage'],
  [['add', '"not cron"', PROMPT], 'Invalid Cron'],
  [['add', '--tz'], 'Usage'],
  [['results', '1', '--limit', '0'], 'Not Found'],
  [['frobnicate'], 'Usage'],
])('%j is refused (%s)', async (args, title) => {
  const { run } = await load();

  const answer = await run(APP_CHAT, args);

  expect(answer.kind).toBe('error');
  expect(answer.title).toBe(title);
});

test('an invalid limit is refused for a task the chat owns', async () => {
  const { run } = await load();
  const taskId = await created(run);

  const answer = await run(APP_CHAT, ['results', String(taskId), '--limit', '500']);

  expect(answer.title).toBe('Invalid Limit');
});

test('chat-safe JSON survives a relay that unescapes line breaks', async () => {
  const { chatSafeJson } = await load();
  const value = { text: 'Line one\nLine two\r', path: 'C:\\new\\report' };

  const sent = chatSafeJson(value);
  const received = sent.replaceAll('\\n', '\n').replaceAll('\\r', '\r');

  expect(sent).not.toMatch(/\\[nr\\]/);
  expect(JSON.parse(received)).toEqual(value);
});
