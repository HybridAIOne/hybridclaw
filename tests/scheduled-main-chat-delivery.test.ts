import { expect, test, vi } from 'vitest';
import type { ScheduledTask } from '../src/types/scheduler.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/scheduler/scheduled-task-runner.js', () => ({
  runIsolatedScheduledTask: mocks.run,
}));
vi.mock('../src/gateway/gateway-service.js', () => ({
  prepareSessionAutoReset: vi.fn(async () => undefined),
  resolveSessionAutoResetPolicy: () => ({ mode: 'none' }),
  resolveGatewayChatbotId: vi.fn(async () => ({
    chatbotId: 'test-chatbot',
    source: 'session',
  })),
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-scheduled-main-chat-',
});

// The ids the HybridAI apps send: one main chat per agent, side chats apart.
const MAIN_CHAT = `main-${'ab'.repeat(16)}-main`;
const SIDE_CHAT = 'ios-6f1c2a40-side';
const REPLY = 'Your parcel from dm arrives today.';

async function load() {
  setupHome();
  const db = await import('../src/memory/db.ts');
  const jobs = await import('../src/memory/jobs.ts');
  const { withMemoryDatabase } = await import('../src/memory/database.ts');
  const { runScheduledTask } = await import(
    '../src/gateway/gateway-scheduled-dispatch.ts'
  );
  const { mainChatForWebTask } = await import(
    '../src/gateway/web-scheduled-delivery.ts'
  );
  const { handleScheduleCommand } = await import(
    '../src/gateway/schedule-command.ts'
  );
  db.initDatabase({ quiet: true });
  mocks.run.mockReset();
  mocks.run.mockImplementation(async (params) => {
    await params.onResult({
      text: REPLY,
      artifacts: [],
      storedMessage: { sessionId: 'cron-run', id: 1 },
    });
  });

  const chat = (id: string, agentId = 'main') =>
    db.getOrCreateSession(id, null, 'web', agentId);
  const addTask = (sessionId: string) =>
    jobs.createJob({
      kind: 'scheduled_task',
      sessionId,
      channelId: 'web',
      cronExpr: '0 8 * * *',
      prompt: 'Check my mail for parcels.',
    });
  // What `dispatchDbTask` hands the gateway when the task fires.
  const fire = (taskId: number) => {
    const task = jobs.getJob(taskId, {
      kind: 'scheduled_task',
    }) as ScheduledTask;
    return runScheduledTask(
      {
        source: 'scheduled-task',
        taskId,
        sessionId: task.session_id,
        channelId: 'web',
        prompt: task.prompt,
        actionKind: 'agent_turn',
        delivery: { kind: 'channel', channelId: 'web' },
      },
      {
        deliverProactiveMessage: vi.fn(),
        deliverWebhookMessage: vi.fn(),
        resolveLastUsedDeliverableChannelId: () => null,
      },
    );
  };
  const messages = (sessionId: string) =>
    db.getRecentMessages(sessionId).map((message) => ({
      content: message.content,
      source: message.source,
    }));
  const results = (sessionId: string, taskId: number) => {
    const session = db.getSessionById(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    return handleScheduleCommand(
      {
        sessionId,
        guildId: null,
        channelId: 'web',
        args: ['schedule', 'results', String(taskId), '--json'],
      },
      session,
    );
  };
  const setLastActive = (sessionId: string, at: string) =>
    withMemoryDatabase((database) =>
      database
        .prepare('UPDATE sessions SET last_active = ? WHERE id = ?')
        .run(at, sessionId),
    );
  return {
    db,
    chat,
    addTask,
    fire,
    messages,
    results,
    setLastActive,
    mainChatForWebTask,
  };
}

test('a task from a side chat runs apart and replies in the main chat', async () => {
  const { chat, addTask, fire, messages, results } = await load();
  chat(MAIN_CHAT);
  chat(SIDE_CHAT);
  const taskId = addTask(SIDE_CHAT);

  await fire(taskId);

  expect(mocks.run.mock.calls[0][0]).toMatchObject({
    sessionId: undefined,
    sessionKey: `cron:${taskId}`,
  });
  expect(messages(MAIN_CHAT)).toEqual([
    { content: REPLY, source: `schedule:${taskId}` },
  ]);
  expect(messages(SIDE_CHAT)).toEqual([]);

  for (const reader of [MAIN_CHAT, SIDE_CHAT]) {
    const answer = JSON.parse(results(reader, taskId).text);
    expect(
      answer.results.map((reply: { text: string }) => reply.text),
    ).toEqual([REPLY]);
  }
  const otherChat = 'ios-other';
  chat(otherChat);
  expect(results(otherChat, taskId).kind).toBe('error');
});

test('a task from the main chat, or an agent without one, stays in its chat', async () => {
  const { chat, addTask, fire, messages } = await load();
  chat(MAIN_CHAT);
  const fromMain = addTask(MAIN_CHAT);
  await fire(fromMain);
  expect(mocks.run.mock.calls[0][0]).toMatchObject({ sessionId: MAIN_CHAT });
  expect(messages(MAIN_CHAT)).toEqual([
    { content: REPLY, source: `schedule:${fromMain}` },
  ]);

  chat('console-chat', 'writer');
  const elsewhere = addTask('console-chat');
  await fire(elsewhere);
  expect(mocks.run.mock.calls[1][0]).toMatchObject({
    sessionId: 'console-chat',
  });
  expect(messages('console-chat')).toEqual([
    { content: REPLY, source: `schedule:${elsewhere}` },
  ]);
});

test('the main chat is the current, most recently active main- chat of the agent', async () => {
  const { db, chat, setLastActive, mainChatForWebTask } = await load();
  chat(SIDE_CHAT);
  expect(mainChatForWebTask(SIDE_CHAT)).toBeNull();

  chat(MAIN_CHAT, 'writer');
  expect(mainChatForWebTask(SIDE_CHAT)).toBeNull();

  const older = `main-${'cd'.repeat(16)}-main`;
  chat(MAIN_CHAT);
  chat(older);
  setLastActive(MAIN_CHAT, '2026-10-08 09:00:00');
  setLastActive(older, '2026-10-01 09:00:00');
  expect(mainChatForWebTask(SIDE_CHAT)?.id).toBe(MAIN_CHAT);
  expect(mainChatForWebTask(MAIN_CHAT)).toBeNull();
  expect(mainChatForWebTask(older)?.id).toBe(MAIN_CHAT);

  // A reset gives the main chat a new instance id under the same key.
  const fresh = db.createFreshSessionInstance(MAIN_CHAT).session;
  expect(mainChatForWebTask(SIDE_CHAT)?.id).toBe(fresh.id);
  expect(mainChatForWebTask(fresh.id)).toBeNull();

  db.getOrCreateSession('discord-dm', null, '123456789012345678', 'main');
  expect(mainChatForWebTask('discord-dm')).toBeNull();
});
