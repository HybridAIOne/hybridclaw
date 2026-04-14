import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.ts';

const { runResourceHygieneMaintenanceMock } = vi.hoisted(() => ({
  runResourceHygieneMaintenanceMock: vi.fn(async () => ({
    generatedAt: '2026-04-14T00:00:00.000Z',
    results: [],
    summary: {
      ok: 0,
      warn: 0,
      error: 0,
      exitCode: 0,
    },
    fixes: [],
    approvalRequired: [],
  })),
}));

vi.mock('../src/doctor/resource-hygiene.js', () => ({
  runResourceHygieneMaintenance: runResourceHygieneMaintenanceMock,
}));

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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  runResourceHygieneMaintenanceMock.mockReset();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar(
    'HYBRIDCLAW_DISABLE_CONFIG_WATCHER',
    ORIGINAL_DISABLE_CONFIG_WATCHER,
  );
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler runs the built-in resource hygiene system event without delegating to the task runner', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-14T08:00:00.000Z'));

  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';

  writeRuntimeConfig(homeDir, (config) => {
    config.scheduler.jobs = [
      {
        id: 'resource-hygiene',
        name: 'Resource Hygiene',
        enabled: true,
        schedule: {
          kind: 'at',
          at: '2026-04-14T08:00:00.000Z',
          everyMs: null,
          expr: null,
          tz: 'UTC',
        },
        action: {
          kind: 'system_event',
          message: 'resource_hygiene_maintenance',
        },
        delivery: {
          kind: 'last-channel',
          channel: '',
          to: '',
          webhookUrl: '',
        },
      },
    ];
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  const { startScheduler, stopScheduler } = await import(
    '../src/scheduler/scheduler.ts'
  );
  initDatabase({ quiet: true });

  const runner = vi.fn(async () => {});
  startScheduler(runner);
  await vi.advanceTimersByTimeAsync(0);
  stopScheduler();

  expect(runResourceHygieneMaintenanceMock).toHaveBeenCalledWith({
    trigger: 'scheduler',
  });
  expect(runner).not.toHaveBeenCalled();
});
