import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.ts';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

const makeTempHome = useTempDir('hybridclaw-scheduler-');

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function writeRuntimeConfig(
  homeDir: string,
  mutator: (config: RuntimeConfig) => void,
): void {
  const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
  config.ops.dbPath = path.join(
    homeDir,
    '.hybridclaw',
    'data',
    'hybridclaw.db',
  );
  config.scheduler.jobs = [];
  mutator(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

function writeSchedulerState(homeDir: string, state: unknown): void {
  const statePath = path.join(
    homeDir,
    '.hybridclaw',
    'data',
    'scheduler-jobs-state.json',
  );
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

useCleanMocks({
  restoreAllMocks: true,
  cleanup: async () => {
    vi.useRealTimers();
    restoreEnvVar('HOME', ORIGINAL_HOME);
    restoreEnvVar(
      'HYBRIDCLAW_DISABLE_CONFIG_WATCHER',
      ORIGINAL_DISABLE_CONFIG_WATCHER,
    );
  },
  resetModules: true,
});

test('legacy backlog-assigned one-shot config jobs move to review after the default retry budget', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-27T08:00:00.000Z'));

  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';

  writeRuntimeConfig(homeDir, (config) => {
    config.scheduler.jobs = [
      {
        id: 'backlog-retry',
        name: 'Backlog retry',
        agentId: 'main',
        boardStatus: 'backlog',
        enabled: true,
        schedule: {
          kind: 'at',
          at: '2026-03-27T08:00:00.000Z',
          everyMs: null,
          expr: null,
          tz: 'UTC',
        },
        action: {
          kind: 'agent_turn',
          message: 'Fail on purpose.',
        },
        delivery: {
          kind: 'channel',
          channel: '',
          to: 'web',
          webhookUrl: '',
        },
      },
    ];
  });

  vi.resetModules();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { getConfigJobState, startScheduler, stopScheduler } = await import(
    '../src/scheduler/scheduler.ts'
  );
  initDatabase({ quiet: true });

  const runner = vi.fn(async (request: { jobId?: string }) => {
    if (request.jobId === 'backlog-retry') {
      throw new Error('expected failure');
    }
  });

  startScheduler(runner);

  await vi.advanceTimersByTimeAsync(0);
  for (let attempt = 1; attempt < 5; attempt += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
  }

  stopScheduler();

  expect(runner).toHaveBeenCalledTimes(4);
  expect(
    getRuntimeConfig().scheduler.jobs.find((job) => job.id === 'backlog-retry'),
  ).toMatchObject({
    boardStatus: 'review',
  });
  expect(getConfigJobState('backlog-retry')).toMatchObject({
    lastStatus: 'error',
    consecutiveErrors: 4,
    disabled: false,
    nextRunAt: null,
  });
});

test('one-shot config jobs respect maxRetries before moving failed work into review', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-27T08:00:00.000Z'));

  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';

  writeRuntimeConfig(homeDir, (config) => {
    config.scheduler.jobs = [
      {
        id: 'release-brief',
        name: 'Release brief',
        agentId: 'main',
        boardStatus: 'backlog',
        enabled: true,
        maxRetries: 1,
        schedule: {
          kind: 'one_shot',
          at: null,
          everyMs: null,
          expr: null,
          tz: 'UTC',
        },
        action: {
          kind: 'agent_turn',
          message: 'Fail on purpose.',
        },
        delivery: {
          kind: 'channel',
          channel: '',
          to: 'web',
          webhookUrl: '',
        },
      },
    ];
  });

  vi.resetModules();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { getConfigJobState, startScheduler, stopScheduler } = await import(
    '../src/scheduler/scheduler.ts'
  );
  initDatabase({ quiet: true });

  const runner = vi.fn(async () => {
    throw new Error('expected failure');
  });

  startScheduler(runner);

  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.advanceTimersByTimeAsync(60_000);

  stopScheduler();

  expect(runner).toHaveBeenCalledTimes(2);
  expect(
    getRuntimeConfig().scheduler.jobs.find((job) => job.id === 'release-brief'),
  ).toMatchObject({
    boardStatus: 'review',
  });
  expect(getConfigJobState('release-brief')).toMatchObject({
    lastStatus: 'error',
    consecutiveErrors: 2,
    disabled: false,
    nextRunAt: null,
  });
});

test('backlog-assigned one-shot config jobs complete once and move to review', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-07T12:00:00.000Z'));

  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';

  writeRuntimeConfig(homeDir, (config) => {
    config.scheduler.jobs = [
      {
        id: 'release-notes',
        name: 'Release notes',
        agentId: 'main',
        boardStatus: 'backlog',
        enabled: true,
        schedule: {
          kind: 'at',
          at: '2026-04-07T12:00:00.000Z',
          everyMs: null,
          expr: null,
          tz: 'UTC',
        },
        action: {
          kind: 'agent_turn',
          message: 'Draft the release notes.',
        },
        delivery: {
          kind: 'channel',
          channel: '',
          to: 'web',
          webhookUrl: '',
        },
      },
    ];
  });

  vi.resetModules();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { getConfigJobState, startScheduler, stopScheduler } = await import(
    '../src/scheduler/scheduler.ts'
  );
  initDatabase({ quiet: true });

  const runner = vi.fn(async () => {});

  startScheduler(runner);

  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(5 * 60_000);

  stopScheduler();

  expect(runner).toHaveBeenCalledTimes(1);
  expect(
    getRuntimeConfig().scheduler.jobs.find((job) => job.id === 'release-notes'),
  ).toMatchObject({
    boardStatus: 'review',
  });
  expect(getConfigJobState('release-notes')).toMatchObject({
    lastStatus: 'success',
    consecutiveErrors: 0,
    disabled: false,
    nextRunAt: null,
  });
});

test('stale successful one-shot jobs reconcile to review without rerunning', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-07T12:02:00.000Z'));

  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';

  writeRuntimeConfig(homeDir, (config) => {
    config.scheduler.jobs = [
      {
        id: 'release-notes',
        name: 'Release notes',
        agentId: 'main',
        boardStatus: 'in_progress',
        enabled: true,
        schedule: {
          kind: 'at',
          at: '2026-04-07T12:00:00.000Z',
          everyMs: null,
          expr: null,
          tz: 'UTC',
        },
        action: {
          kind: 'agent_turn',
          message: 'Draft the release notes.',
        },
        delivery: {
          kind: 'channel',
          channel: '',
          to: 'web',
          webhookUrl: '',
        },
      },
    ];
  });
  writeSchedulerState(homeDir, {
    version: 1,
    updatedAt: '2026-04-07T12:01:00.000Z',
    configJobs: {
      'release-notes': {
        lastRun: '2026-04-07T12:00:00.000Z',
        lastStatus: 'success',
        nextRunAt: '2026-04-07T12:01:00.000Z',
        consecutiveErrors: 0,
        disabled: false,
        oneShotCompleted: false,
      },
    },
  });

  vi.resetModules();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { getConfigJobState, startScheduler, stopScheduler } = await import(
    '../src/scheduler/scheduler.ts'
  );
  initDatabase({ quiet: true });

  const runner = vi.fn(async () => {});

  startScheduler(runner);

  await vi.advanceTimersByTimeAsync(5 * 60_000);

  stopScheduler();

  expect(runner).not.toHaveBeenCalled();
  expect(
    getRuntimeConfig().scheduler.jobs.find((job) => job.id === 'release-notes'),
  ).toMatchObject({
    boardStatus: 'review',
  });
  expect(getConfigJobState('release-notes')).toMatchObject({
    lastStatus: 'success',
    disabled: false,
    nextRunAt: null,
  });
});

test('stale successful one-shot jobs already in review do not rerun', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-07T12:02:00.000Z'));

  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';

  writeRuntimeConfig(homeDir, (config) => {
    config.scheduler.jobs = [
      {
        id: 'release-notes',
        name: 'Release notes',
        agentId: 'main',
        boardStatus: 'review',
        enabled: true,
        schedule: {
          kind: 'at',
          at: '2026-04-07T12:00:00.000Z',
          everyMs: null,
          expr: null,
          tz: 'UTC',
        },
        action: {
          kind: 'agent_turn',
          message: 'Draft the release notes.',
        },
        delivery: {
          kind: 'channel',
          channel: '',
          to: 'web',
          webhookUrl: '',
        },
      },
    ];
  });
  writeSchedulerState(homeDir, {
    version: 1,
    updatedAt: '2026-04-07T12:01:00.000Z',
    configJobs: {
      'release-notes': {
        lastRun: '2026-04-07T12:00:00.000Z',
        lastStatus: 'success',
        nextRunAt: '2026-04-07T12:01:00.000Z',
        consecutiveErrors: 0,
        disabled: false,
        oneShotCompleted: false,
      },
    },
  });

  vi.resetModules();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { getConfigJobState, startScheduler, stopScheduler } = await import(
    '../src/scheduler/scheduler.ts'
  );
  initDatabase({ quiet: true });

  const runner = vi.fn(async () => {});

  startScheduler(runner);

  await vi.advanceTimersByTimeAsync(5 * 60_000);

  stopScheduler();

  expect(runner).not.toHaveBeenCalled();
  expect(
    getRuntimeConfig().scheduler.jobs.find((job) => job.id === 'release-notes'),
  ).toMatchObject({
    boardStatus: 'review',
  });
  expect(getConfigJobState('release-notes')).toMatchObject({
    lastStatus: 'success',
    disabled: false,
    nextRunAt: null,
  });
});

test('getConfigJobState reconciles stale successful one-shot jobs directly', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-07T12:02:00.000Z'));

  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';

  writeRuntimeConfig(homeDir, (config) => {
    config.scheduler.jobs = [
      {
        id: 'release-notes',
        name: 'Release notes',
        agentId: 'main',
        boardStatus: 'in_progress',
        enabled: true,
        schedule: {
          kind: 'at',
          at: '2026-04-07T12:00:00.000Z',
          everyMs: null,
          expr: null,
          tz: 'UTC',
        },
        action: {
          kind: 'agent_turn',
          message: 'Draft the release notes.',
        },
        delivery: {
          kind: 'channel',
          channel: '',
          to: 'web',
          webhookUrl: '',
        },
      },
    ];
  });
  writeSchedulerState(homeDir, {
    version: 1,
    updatedAt: '2026-04-07T12:01:00.000Z',
    configJobs: {
      'release-notes': {
        lastRun: '2026-04-07T12:00:00.000Z',
        lastStatus: 'success',
        nextRunAt: '2026-04-07T12:01:00.000Z',
        consecutiveErrors: 0,
        disabled: false,
        oneShotCompleted: false,
      },
    },
  });

  vi.resetModules();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { getConfigJobState } = await import('../src/scheduler/scheduler.ts');
  initDatabase({ quiet: true });

  expect(getConfigJobState('release-notes')).toMatchObject({
    lastStatus: 'success',
    disabled: false,
    nextRunAt: null,
  });
  expect(
    getRuntimeConfig().scheduler.jobs.find((job) => job.id === 'release-notes'),
  ).toMatchObject({
    boardStatus: 'review',
  });
});
