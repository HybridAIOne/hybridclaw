import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-schedule-reply-only-',
});

const MAIN_CHAT = 'main-chat';
const TOKEN = 'cd'.repeat(32);
const PROMPT = 'Look for anything that needs me. Write me a short message about it.';
const FIND =
  'Anna is still waiting for your answer about Thursday. Want me to draft a reply?';

async function load() {
  setupHome();
  vi.stubEnv('HYBRIDAI_API_KEY', 'hai-test-key');
  const relay = vi.fn(
    async (url: string) =>
      new Response(
        url.endsWith('/devices')
          ? '{"status":"registered"}'
          : '{"status":"sent"}',
      ),
  );
  vi.stubGlobal('fetch', relay);
  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const store = await import('../src/gateway/web-notification-store.ts');
  const { deliverWebScheduledMessage } = await import(
    '../src/gateway/web-scheduled-delivery.ts'
  );
  const { runIsolatedScheduledTask } = await import(
    '../src/scheduler/scheduled-task-runner.ts'
  );
  initDatabase({ quiet: true });
  memoryService.getOrCreateSession(MAIN_CHAT, null, 'web', 'main');
  // What /api/chat does for a web chat before its commands run.
  store.bindWebNotificationSession(
    MAIN_CHAT,
    store.notificationOperatorId('local-operator'),
  );
  const run = async (args: string[]) =>
    JSON.parse(
      (
        await handleGatewayCommand({
          sessionId: MAIN_CHAT,
          guildId: null,
          channelId: 'web',
          args,
        })
      ).text,
    );
  await run(['push', 'register', TOKEN, 'production', 'proactive']);
  const added = await run([
    'schedule', 'add', '--json', '--reply-only', '--alert', 'proactive',
    '"*/30 * * * *"', PROMPT,
  ]);
  // A run as the scheduler starts one for this task: apart from the chat,
  // under the task's own key, its reply delivered to the chat.
  const fire = async (reply: string) => {
    runAgentMock.mockResolvedValueOnce({
      status: 'success',
      result: reply,
      toolExecutions: [],
      artifacts: [],
    });
    await runIsolatedScheduledTask({
      taskId: added.task.id,
      prompt: PROMPT,
      channelId: 'web',
      chatbotId: 'test-chatbot',
      model: 'gpt-4o-mini',
      agentId: 'main',
      sessionKey: `cron:${added.task.id}`,
      onResult: (result) => {
        deliverWebScheduledMessage(
          MAIN_CHAT,
          result.text,
          `schedule:${added.task.id}`,
          result.artifacts,
          result.storedMessage,
        );
      },
      onError: (error) => {
        throw error;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const alerts = () =>
    relay.mock.calls
      .filter(([url]) => String(url).endsWith('/v1/push'))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)).payload);
  return { run, added, fire, alerts, memoryService };
}

test('a --reply-only run posts only its reply to the chat and rings with it', async () => {
  const { run, added, fire, alerts, memoryService } = await load();
  expect(added.task).toMatchObject({ reply_only: true, alert: 'proactive' });

  await fire(FIND);
  const chat = memoryService.getRecentMessages(MAIN_CHAT);
  expect(chat).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: FIND,
      source: `schedule:${added.task.id}`,
    }),
  ]);
  const [payload] = alerts();
  expect(payload).toMatchObject({
    aps: { alert: { title: 'Hy', body: FIND }, 'thread-id': MAIN_CHAT },
    kind: 'proactive',
    sessionId: MAIN_CHAT,
    messageId: chat[0].id,
    id: `${MAIN_CHAT}:reminder:${chat[0].id}`,
  });

  const results = await run([
    'schedule', 'results', String(added.task.id), '--json',
  ]);
  expect(results.results.map((reply: { text: string }) => reply.text)).toEqual(
    [FIND],
  );
});

test('a silent run posts nothing and rings nothing', async () => {
  const { added, fire, alerts, memoryService, run } = await load();
  await fire('__MESSAGE_SEND_HANDLED__');
  expect(memoryService.getRecentMessages(MAIN_CHAT)).toEqual([]);
  expect(alerts()).toEqual([]);
  const results = await run([
    'schedule', 'results', String(added.task.id), '--json',
  ]);
  expect(results.results).toEqual([]);
});

test('an edit keeps --reply-only, and a plain task does not have it', async () => {
  const { added, run } = await load();
  const jobs = await import('../src/memory/jobs.ts');
  jobs.updateScheduledTask(added.task.id, {
    channelId: 'web',
    cronExpr: '0 * * * *',
    prompt: 'Changed',
  });
  expect(jobs.getJob(added.task.id, { kind: 'scheduled_task' })).toMatchObject(
    { reply_only: true, alert: 'proactive' },
  );
  const plain = await run(['schedule', 'add', '--json', '"0 9 * * *"', 'x']);
  expect(plain.task.reply_only).toBe(false);
});
