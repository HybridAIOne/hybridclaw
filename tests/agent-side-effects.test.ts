import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;

const makeTempHome = useTempDir('hybridclaw-sidefx-');

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

test('processSideEffects persists explicit schedule delivery channels', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const rearmScheduler = vi.fn();
  vi.doMock('../src/scheduler/scheduler.js', () => ({
    rearmScheduler,
  }));

  const { initDatabase, getTasksForSession } = await import(
    '../src/memory/db.ts'
  );
  const { processSideEffects } = await import('../src/agent/side-effects.ts');

  initDatabase({ quiet: true });

  processSideEffects(
    {
      status: 'success',
      result: 'ok',
      toolsUsed: [],
      sideEffects: {
        schedules: [
          {
            action: 'add',
            everyMs: 1_800_000,
            channelId: 'ops@example.com',
            prompt: 'Write a short operational update email.',
          },
        ],
      },
    },
    'session-1',
    'tui',
  );

  const tasks = getTasksForSession('session-1');
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    session_id: 'session-1',
    channel_id: 'ops@example.com',
    every_ms: 1_800_000,
    prompt: 'Write a short operational update email.',
  });
  expect(rearmScheduler).toHaveBeenCalledTimes(1);
});
