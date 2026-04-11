import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-sidefx-'));
  tempDirs.push(dir);
  return dir;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
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
