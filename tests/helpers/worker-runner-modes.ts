import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { expect, type Mock, vi } from 'vitest';
import type { Executor } from '../../src/agent/executor-types.js';
import { useCleanMocks, useTempDir } from '../test-utils.js';

export type FakeWorker = EventEmitter & {
  pid?: number;
  /** Container name from `docker run --name`; unset in host mode. */
  name?: string;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: Mock };
  kill: Mock;
  killed: boolean;
  exitCode: number | null;
};

export function makeFakeWorker(): FakeWorker {
  const proc = new EventEmitter() as FakeWorker;
  proc.stderr = new EventEmitter();
  proc.stdin = Object.assign(new EventEmitter(), { write: vi.fn() });
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  return proc;
}

export function testCredentials(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'hybridai' as const,
    apiKey: '',
    baseUrl: 'https://hybridai.one',
    chatbotId: 'bot-a',
    enableRag: false,
    requestHeaders: {},
    agentId: 'default',
    isLocal: false,
    contextWindow: 128_000,
    thinkingFormat: undefined,
    ...overrides,
  };
}

export const okOutput = () => ({
  status: 'success' as const,
  result: 'ok',
  toolsUsed: [],
  artifacts: [],
});

type SpawnCall = [string, string[], SpawnOptions | undefined];

export interface RunnerMode {
  mode: 'container' | 'host';
  loadRunner(): Promise<Executor>;
  isWorkerSpawn(command: string, args: string[]): boolean;
  /** The workspace a worker spawn mounts (container) or runs in (host). */
  workerWorkspace(call: SpawnCall): string;
  /** How many times the runner asked a worker to stop. */
  stopCount(run: StartedRunner): number;
  wasStopped(worker: FakeWorker, run: StartedRunner): boolean;
  runtimeLabel: string;
  repairHint: string;
  claimedWarm: { message: string; fields: Record<string, unknown> };
  /** Expected behaviour where the two modes still differ. */
  expected: {
    busyError: RegExp;
    fullPoolWaits: boolean;
    activeSessionsAfterAbort: number;
  };
}

const dockerArg = (args: string[], flag: string) =>
  args[args.indexOf(flag) + 1];

export const RUNNER_MODES: RunnerMode[] = [
  {
    mode: 'container',
    loadRunner: async () =>
      (await import('../../src/infra/container-runner.js')).containerRunner,
    isWorkerSpawn: (command, args) => command === 'docker' && args[0] === 'run',
    workerWorkspace: ([, args]) =>
      args.find((arg) => arg.endsWith(':/workspace:rw'))?.split(':')[0] || '',
    stopCount: (run) =>
      run.spawn.mock.calls.filter(([, args]) => args?.[0] === 'stop').length,
    wasStopped: (worker, run) =>
      run.spawn.mock.calls.some(
        ([, args]) => args?.[0] === 'stop' && args[1] === worker.name,
      ),
    runtimeLabel: 'Container runtime',
    repairHint: 'npm run build:container',
    claimedWarm: {
      message: 'Claimed warm container',
      fields: { containerName: expect.stringContaining('warm-') },
    },
    expected: {
      busyError: /^Too many active containers \(5\/5\)\. Try again later\.$/,
      fullPoolWaits: false,
      activeSessionsAfterAbort: 0,
    },
  },
  {
    mode: 'host',
    loadRunner: async () => {
      vi.doMock('../../src/infra/host-runtime-setup.js', () => ({
        ensureHostRuntimeReady: () => ({
          command: process.execPath,
          args: ['/tmp/container/dist/index.js'],
        }),
      }));
      return (await import('../../src/infra/host-runner.js')).hostRunner;
    },
    isWorkerSpawn: () => true,
    workerWorkspace: ([, , options]) => String(options?.cwd || ''),
    stopCount: (run) =>
      run.workers.reduce((sum, worker) => sum + worker.kill.mock.calls.length, 0),
    wasStopped: (worker) =>
      worker.kill.mock.calls.some(([signal]) => signal === 'SIGTERM'),
    runtimeLabel: 'Host agent process',
    repairHint: 'postinstall-container.mjs',
    claimedWarm: { message: 'Claimed warm host agent process', fields: {} },
    expected: {
      busyError:
        /^Too many active host agent processes \(5\/5\) after waiting 15000ms\. Try again later\.$/,
      fullPoolWaits: true,
      activeSessionsAfterAbort: 1,
    },
  },
];

export interface StartOptions {
  readOutput?: (...args: never[]) => unknown;
  credentials?: (...args: never[]) => unknown;
  warmPool?: boolean;
  config?: Record<string, unknown>;
  makeWorker?: () => FakeWorker;
  /** Runs with the fresh HOME before any runner module loads. */
  beforeLoad?: (homeDir: string) => void;
}

export interface StartedRunner {
  runner: Executor;
  homeDir: string;
  /** Worker children in spawn order, without `docker stop` / `docker stats`. */
  workers: FakeWorker[];
  workerCalls: SpawnCall[];
  spawn: Mock<(...args: SpawnCall) => FakeWorker>;
  readOutput: Mock;
  logger: Record<'debug' | 'info' | 'warn' | 'error', Mock>;
}

/**
 * Registers per-test cleanup and returns a starter that mocks the worker
 * child, IPC reader, model credentials and logger, then loads the real runner.
 */
export function useRunnerModes(prefix: string) {
  const makeTempDir = useTempDir(prefix);
  useCleanMocks({
    restoreAllMocks: true,
    resetModules: true,
    unstubAllEnvs: true,
    unmock: [
      'node:child_process',
      '../src/config/config.js',
      '../src/infra/host-runtime-setup.js',
      '../src/infra/ipc.js',
      '../src/logger.js',
      '../src/providers/factory.js',
    ],
  });

  return async function startRunner(
    mode: RunnerMode,
    options: StartOptions = {},
  ): Promise<StartedRunner> {
    const homeDir = makeTempDir();
    vi.stubEnv('HOME', homeDir);
    vi.resetModules();
    options.beforeLoad?.(homeDir);

    const workers: FakeWorker[] = [];
    const workerCalls: SpawnCall[] = [];
    const spawn = vi.fn((command: string, args: string[], spawnOptions) => {
      const isWorker = mode.isWorkerSpawn(command, args);
      const proc = isWorker
        ? (options.makeWorker ?? makeFakeWorker)()
        : makeFakeWorker();
      if (isWorker) {
        if (mode.mode === 'container') proc.name = dockerArg(args, '--name');
        workers.push(proc);
        workerCalls.push([command, args, spawnOptions]);
      }
      return proc;
    }) as StartedRunner['spawn'];
    const readOutput = vi.fn(options.readOutput ?? (async () => okOutput()));
    const credentials = vi.fn(
      options.credentials ?? (async () => testCredentials()),
    );
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      spawn,
    }));
    vi.doMock('../../src/infra/ipc.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/infra/ipc.js')>()),
      readOutput,
    }));
    vi.doMock('../../src/providers/factory.js', async (importOriginal) => ({
      ...(await importOriginal<
        typeof import('../../src/providers/factory.js')
      >()),
      resolveModelRuntimeCredentials: credentials,
    }));
    vi.doMock('../../src/config/config.js', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../../src/config/config.js')>();
      return {
        ...actual,
        CONTAINER_WARM_POOL: {
          ...actual.CONTAINER_WARM_POOL,
          enabled: options.warmPool ?? false,
        },
        ...options.config,
      };
    });
    vi.doMock('../../src/logger.js', () => ({ logger }));

    const runner = await mode.loadRunner();
    return { runner, homeDir, workers, workerCalls, spawn, readOutput, logger };
  };
}

export const baseRequest = {
  messages: [{ role: 'user' as const, content: 'hello' }],
  chatbotId: 'bot-a',
  enableRag: false,
  model: 'gpt-5',
  agentId: 'default',
  channelId: 'tui',
};

export function firstInput(worker: FakeWorker | undefined) {
  return JSON.parse(
    String(worker?.stdin.write.mock.calls[0]?.[0] || '').trim(),
  ) as Record<string, unknown>;
}
