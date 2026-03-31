import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-gateway-scheduler-'),
  );
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
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('admin scheduler includes db-backed tasks and can pause, resume, and delete them', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase, createTask } = await import('../src/memory/db.ts');
  const {
    getGatewayAdminScheduler,
    moveGatewayAdminSchedulerJob,
    removeGatewayAdminSchedulerJob,
    setGatewayAdminSchedulerJobPaused,
    upsertGatewayAdminSchedulerJob,
  } = await import('../src/gateway/gateway-scheduled-task-service.ts');
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );

  initDatabase({ quiet: true });

  const runAt = new Date(Date.now() + 6 * 60_000).toISOString();
  const taskId = createTask(
    'dm:439508376087560193',
    '1475079601968648386',
    '',
    'Reply exactly with: Drink water',
    runAt,
  );

  const beforePause = getGatewayAdminScheduler().jobs.find(
    (job) => job.id === `task:${taskId}`,
  );
  expect(beforePause).toMatchObject({
    id: `task:${taskId}`,
    source: 'task',
    taskId,
    sessionId: 'dm:439508376087560193',
    channelId: '1475079601968648386',
    enabled: true,
    disabled: false,
    schedule: {
      kind: 'at',
      at: runAt,
    },
    action: {
      kind: 'agent_turn',
      message: 'Reply exactly with: Drink water',
    },
  });
  expect(beforePause?.nextRunAt).not.toBeNull();

  setGatewayAdminSchedulerJobPaused({
    jobId: String(taskId),
    paused: true,
    source: 'task',
  });
  expect(
    getGatewayAdminScheduler().jobs.find((job) => job.id === `task:${taskId}`),
  ).toMatchObject({
    enabled: false,
    disabled: true,
    nextRunAt: null,
  });

  setGatewayAdminSchedulerJobPaused({
    jobId: String(taskId),
    paused: false,
    source: 'task',
  });
  expect(
    getGatewayAdminScheduler().jobs.find((job) => job.id === `task:${taskId}`),
  ).toMatchObject({
    enabled: true,
    disabled: false,
  });

  removeGatewayAdminSchedulerJob(String(taskId), 'task');
  expect(
    getGatewayAdminScheduler().jobs.find((job) => job.id === `task:${taskId}`),
  ).toBeUndefined();

  expect(() =>
    upsertGatewayAdminSchedulerJob({
      job: {
        id: 'invalid-board-status',
        schedule: {
          kind: 'at',
          at: runAt,
          everyMs: null,
          expr: null,
          tz: 'UTC',
        },
        action: {
          kind: 'agent_turn',
          message: 'Reply exactly with: Drink water',
        },
        delivery: {
          kind: 'channel',
          channel: '1475079601968648386',
          to: '',
          webhookUrl: '',
        },
        enabled: true,
        boardStatus: 'bogus',
      },
    }),
  ).toThrow(
    'Scheduler board status must be `backlog`, `in_progress`, `review`, `done`, or `cancelled`.',
  );

  updateRuntimeConfig((draft) => {
    draft.scheduler.jobs.push({
      id: 'board-status-job',
      schedule: {
        kind: 'every',
        everyMs: 60_000,
        at: null,
        expr: null,
        tz: 'UTC',
      },
      action: {
        kind: 'agent_turn',
        message: 'Ping',
      },
      delivery: {
        kind: 'channel',
        channel: '1475079601968648386',
        to: '1475079601968648386',
        webhookUrl: '',
      },
      enabled: true,
      boardStatus: 'review',
    });
  });

  moveGatewayAdminSchedulerJob({
    jobId: 'board-status-job',
    beforeJobId: null,
  });
  expect(
    getGatewayAdminScheduler().jobs.find(
      (job) => job.id === 'board-status-job',
    ),
  ).toMatchObject({
    boardStatus: 'review',
  });

  moveGatewayAdminSchedulerJob({
    jobId: 'board-status-job',
    beforeJobId: null,
    boardStatus: null,
  });
  expect(
    getGatewayAdminScheduler().jobs.find(
      (job) => job.id === 'board-status-job',
    ),
  ).toMatchObject({
    boardStatus: null,
  });
});
