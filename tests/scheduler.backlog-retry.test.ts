import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.ts';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-scheduler-'));
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

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar(
    'HYBRIDCLAW_DISABLE_CONFIG_WATCHER',
    ORIGINAL_DISABLE_CONFIG_WATCHER,
  );
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('backlog-assigned config jobs use the same auto-disable failure cap as other config jobs', async () => {
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

  expect(runner).toHaveBeenCalledTimes(5);
  expect(
    getRuntimeConfig().scheduler.jobs.find((job) => job.id === 'backlog-retry'),
  ).toMatchObject({
    boardStatus: 'in_progress',
  });
  expect(getConfigJobState('backlog-retry')).toMatchObject({
    lastStatus: 'error',
    consecutiveErrors: 5,
    disabled: true,
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
