import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-schedule-alert-',
});

const APP_CHAT = 'app-feed';
const TOKEN = 'ab'.repeat(32);
const PROMPT = 'Check the connected accounts and answer with a JSON array.';

async function load() {
  setupHome();
  vi.stubEnv('HYBRIDAI_API_KEY', 'hai-test-key');
  const relay = vi.fn(async () => new Response('{"status":"sent"}'));
  vi.stubGlobal('fetch', relay);
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const store = await import('../src/gateway/web-notification-store.ts');
  const { deliverWebScheduledMessage } = await import(
    '../src/gateway/web-scheduled-delivery.ts'
  );
  const jobs = await import('../src/memory/jobs.ts');
  initDatabase({ quiet: true });
  // What /api/chat does for a web chat before its commands run.
  store.bindWebNotificationSession(
    APP_CHAT,
    store.notificationOperatorId('local-operator'),
  );
  const run = async (args: string[]) =>
    JSON.parse(
      (
        await handleGatewayCommand({
          sessionId: APP_CHAT,
          guildId: null,
          channelId: 'web',
          args,
        })
      ).text,
    );
  await run(['push', 'register', TOKEN, 'production', 'proactive']);
  const alerts = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return relay.mock.calls.map(
      ([, init]) => JSON.parse(String((init as RequestInit).body)).payload,
    );
  };
  return { run, relay, alerts, deliverWebScheduledMessage, jobs };
}

test('a task added with --alert rings the phone with the first item its run lists', async () => {
  const { run, alerts, deliverWebScheduledMessage } = await load();
  const added = await run([
    'schedule', 'add', '--json', '--alert', 'proactive', '"*/30 * * * *"', PROMPT,
  ]);
  expect(added.task.alert).toBe('proactive');
  const source = `schedule:${added.task.id}`;

  deliverWebScheduledMessage(
    APP_CHAT,
    'Here you go:\n[{"title":"Reply to Ben","detail":"d"},{"title":"Prepare the review"}]',
    source,
  );
  const [payload] = await alerts();
  expect(payload).toMatchObject({
    aps: {
      alert: { body: 'Reply to Ben (+1 more)' },
      'thread-id': APP_CHAT,
    },
    kind: 'proactive',
    sessionId: APP_CHAT,
    count: 2,
  });
  expect(typeof payload.aps.alert.title).toBe('string');

  // A run that lists nothing says nothing; neither does a task without --alert.
  deliverWebScheduledMessage(APP_CHAT, '[]', source);
  deliverWebScheduledMessage(APP_CHAT, 'Nothing new.', source);
  const plain = await run(['schedule', 'add', '--json', '"*/30 * * * *"', 'Other']);
  expect(plain.task.alert).toBeNull();
  deliverWebScheduledMessage(
    APP_CHAT,
    '[{"title":"Not for the phone"}]',
    `schedule:${plain.task.id}`,
  );
  expect(await alerts()).toHaveLength(1);
});

test('an edit keeps the alert, and a bad kind is refused', async () => {
  const { run, jobs } = await load();
  const added = await run([
    'schedule', 'add', '--json', '--alert', 'proactive', '"*/30 * * * *"', PROMPT,
  ]);
  jobs.updateScheduledTask(added.task.id, {
    channelId: 'web',
    cronExpr: '0 * * * *',
    prompt: 'Changed',
  });
  expect(jobs.getJob(added.task.id, { kind: 'scheduled_task' })?.alert).toBe(
    'proactive',
  );
  const refused = await (async () => {
    try {
      return await run(['schedule', 'add', '--alert', 'Bad Kind', '"* * * * *"', 'x']);
    } catch {
      return null;
    }
  })();
  expect(refused).toBeNull();
});
