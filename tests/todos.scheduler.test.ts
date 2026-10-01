import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempHome = useTempDir('hybridclaw-todo-reminders-');

useCleanMocks({
  restoreAllMocks: true,
  unstubAllEnvs: true,
  cleanup: () => vi.useRealTimers(),
  resetModules: true,
});

test('the scheduler skips the reminder of a todo already done today', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T12:00:00.000Z'));
  vi.stubEnv('HOME', makeTempHome());
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  const { initDatabase } = await import('../src/memory/db.ts');
  const jobs = await import('../src/memory/jobs.ts');
  const scheduler = await import('../src/scheduler/scheduler.ts');
  const store = await import('../src/todos/todo-store.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  initDatabase({ quiet: true });
  jobs.replaceJobs([]);

  const chat = memoryService.getOrCreateSession('app-chat', null, 'web');
  const today = { remind: '12:30' };
  const done = store.addTodo(chat, {
    ...today,
    title: 'Chinese',
    tz: 'UTC',
  });
  store.addTodo(chat, { ...today, title: 'Stretch', tz: 'UTC' });
  store.markTodo(chat, done.id, true, 'user');

  const runner = vi.fn(async () => {});
  scheduler.startScheduler(runner);
  await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
  scheduler.stopScheduler();

  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner.mock.calls[0][0]).toMatchObject({
    sessionId: 'app-chat',
    prompt: expect.stringContaining('"Stretch"'),
  });
});
