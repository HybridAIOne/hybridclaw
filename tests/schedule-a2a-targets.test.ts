import { afterEach, expect, test, vi } from 'vitest';
import { useTempDir } from './test-utils.js';

const makeHome = useTempDir('hy-schedule-a2a-');
let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  close = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});
vi.mock('../src/scheduler/scheduler.js', () => ({
  rearmScheduler: vi.fn(),
  dbTaskLabel: (id: number) => `task:${id}`,
  cronPromptHead: () => '[scheduled]',
}));

test('schedule commands and triggers reject A2A targets before creating a task', async () => {
  vi.stubEnv('HOME', makeHome());
  const db = await import('../src/memory/db.js');
  const jobs = await import('../src/memory/jobs.js');
  const { handleScheduleCommand } = await import(
    '../src/gateway/schedule-command.js'
  );
  db.initDatabase({ quiet: true });
  close = db.closeDatabase;
  const session = db.getOrCreateSession('a2a-thread', null, 'a2a', 'main');

  for (const args of [
    ['add', '"0 9 * * *"', 'Send daily report'],
    ['add', '--on', 'webhook', 'Summarize payload'],
  ]) {
    const result = handleScheduleCommand(
      {
        sessionId: session.id,
        guildId: null,
        channelId: 'a2a',
        args: ['schedule', ...args],
      },
      session,
    );
    expect(result.kind).toBe('error');
    expect(result.text).toContain('A2A targets do not support');
  }
  expect(jobs.getAllJobs({ kind: 'scheduled_task' })).toEqual([]);
});
