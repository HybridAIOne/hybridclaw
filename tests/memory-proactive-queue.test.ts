import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;

const makeTempHome = useTempDir('hybridclaw-proactive-queue-');

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

useCleanMocks({
  cleanup: () => {
    restoreEnvVar('HOME', ORIGINAL_HOME);
  },
  resetModules: true,
});

test('failed proactive messages leave the queue but stay visible until pruned', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, withMemoryDatabase } = await import(
    '../src/memory/db.ts'
  );
  const {
    claimQueuedProactiveMessages,
    enqueueProactiveMessage,
    getFailedProactiveMessageCount,
    getQueuedProactiveMessageCount,
    listFailedProactiveMessages,
    listQueuedProactiveMessages,
    markQueuedProactiveMessageFailed,
    pruneFailedProactiveMessages,
  } = await import('../src/memory/proactive-queue.ts');

  initDatabase({ quiet: true });

  enqueueProactiveMessage('web', 'Morning briefing', 'schedule:1', 10);
  enqueueProactiveMessage('tui', 'Standup notes', 'schedule:2', 10);
  const [webItem] = listQueuedProactiveMessages();
  expect(webItem).toMatchObject({ channel_id: 'web', failed_at: null });

  markQueuedProactiveMessageFailed(
    webItem.id,
    'No proactive delivery path for channel "web"',
  );

  expect(getQueuedProactiveMessageCount()).toBe(1);
  expect(getFailedProactiveMessageCount()).toBe(1);
  expect(listQueuedProactiveMessages().map((item) => item.channel_id)).toEqual(
    ['tui'],
  );
  expect(listFailedProactiveMessages()).toHaveLength(1);
  expect(listFailedProactiveMessages()[0]).toMatchObject({
    id: webItem.id,
    failure_reason: 'No proactive delivery path for channel "web"',
  });
  expect(listFailedProactiveMessages()[0].failed_at).toBeTruthy();
  expect(claimQueuedProactiveMessages('web')).toEqual([]);

  expect(pruneFailedProactiveMessages()).toBe(0);
  withMemoryDatabase((db) => {
    db.prepare(
      "UPDATE proactive_message_queue SET failed_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(webItem.id);
  });
  expect(pruneFailedProactiveMessages()).toBe(1);
  expect(getFailedProactiveMessageCount()).toBe(0);
  expect(getQueuedProactiveMessageCount()).toBe(1);
});

test('queue size limits only count messages that are still deliverable', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const {
    enqueueProactiveMessage,
    getFailedProactiveMessageCount,
    listQueuedProactiveMessages,
    markQueuedProactiveMessageFailed,
  } = await import('../src/memory/proactive-queue.ts');

  initDatabase({ quiet: true });

  enqueueProactiveMessage('web', 'first', 'schedule:1', 2);
  const [failed] = listQueuedProactiveMessages();
  markQueuedProactiveMessageFailed(failed.id, 'undeliverable');
  enqueueProactiveMessage('tui', 'second', 'schedule:2', 2);
  const result = enqueueProactiveMessage('tui', 'third', 'schedule:3', 2);

  expect(result).toEqual({ queued: 2, dropped: 0 });
  expect(getFailedProactiveMessageCount()).toBe(1);
  expect(listQueuedProactiveMessages().map((item) => item.text)).toEqual([
    'second',
    'third',
  ]);
});
