import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { encodeFileWriteGuardContext } from '../container/shared/file-write-guard.js';
import { readWarmWorkerFrame } from '../container/shared/warm-worker-frame.js';
import type { ContainerInput } from '../src/types/container.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-warm-refill-');
useCleanMocks({
  resetModules: true,
  unstubAllEnvs: true,
  unmock: [
    'node:child_process',
    '../src/infra/host-runtime-setup.js',
    '../src/infra/ipc.js',
    '../src/logger.js',
    '../src/providers/factory.js',
  ],
});

// Track the runner's assigned IPC paths; directory names no longer expose IDs.
const warmIpcPaths = new Set<string>();

function findWarmIpcPath(args: string[] = [], options?: SpawnOptions): string | undefined {
  const ipcRefs = [...args, options?.env?.HYBRIDCLAW_AGENT_IPC_DIR ?? ''];
  return [...warmIpcPaths].find((ipcPath) =>
    ipcRefs.includes(ipcPath) || ipcRefs.includes(`${ipcPath}:/ipc:rw`),
  );
}

function makeFakeChildProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    exitCode: number | null;
  };
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

function mockRunnerDeps(params: {
  spawn: (...args: never[]) => unknown;
  readOutput?: () => Promise<unknown>;
  warn?: (...args: unknown[]) => void;
}): void {
  vi.doMock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawn: params.spawn,
  }));
  warmIpcPaths.clear();
  vi.doMock('../src/infra/ipc.js', async (importOriginal) => {
    const ipc = await importOriginal<typeof import('../src/infra/ipc.js')>();
    return {
      ...ipc,
      getSessionPaths: (sessionId: string, agentId: string) => {
        const paths = ipc.getSessionPaths(sessionId, agentId);
        if (sessionId.startsWith('warm_')) warmIpcPaths.add(paths.ipcPath);
        return paths;
      },
      readOutput:
        params.readOutput ??
        (async () => ({
          status: 'success' as const,
          result: 'done',
          toolsUsed: [],
        })),
    };
  });
  vi.doMock('../src/providers/factory.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/providers/factory.js')>()),
    resolveModelRuntimeCredentials: async () => ({
      provider: 'hybridai',
      apiKey: '',
      baseUrl: 'https://hybridai.one',
      chatbotId: 'bot-a',
      enableRag: false,
      requestHeaders: {},
      agentId: 'main',
      isLocal: false,
      contextWindow: 128_000,
    }),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: params.warn ?? vi.fn(),
      error: vi.fn(),
    },
  }));
}

/** Spawns fake workers, collecting the warm ones. */
function spawnCollectingWarm(
  warmProcesses: ReturnType<typeof makeFakeChildProcess>[],
) {
  return vi.fn((_command: string, args?: string[], options?: SpawnOptions) => {
    const proc = makeFakeChildProcess();
    if (findWarmIpcPath(args, options)) warmProcesses.push(proc);
    return proc;
  });
}

// The host runner signals the child; the container runner `docker stop`s it.
function isWarmStopped(
  spawn: ReturnType<typeof vi.fn>,
  proc: ReturnType<typeof makeFakeChildProcess> | undefined,
): boolean {
  return (
    Boolean(proc?.kill.mock.calls.length) ||
    spawn.mock.calls.some(
      ([command, args]) => command === 'docker' && args?.[0] === 'stop',
    )
  );
}

function turn(sessionId: string, client?: 'mobile') {
  return {
    sessionId,
    messages: [{ role: 'user' as const, content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'main',
    channelId: 'tui',
    client,
  };
}

const RUNNERS = [
  {
    runner: 'ContainerExecutor',
    createExecutor: async () => {
      const { ContainerExecutor } = await import(
        '../src/infra/container-runner.js'
      );
      return new ContainerExecutor();
    },
  },
  {
    runner: 'HostExecutor',
    createExecutor: async () => {
      vi.doMock('../src/infra/host-runtime-setup.js', () => ({
        ensureHostRuntimeReady: () => ({
          command: process.execPath,
          args: ['/tmp/container/dist/index.js'],
        }),
      }));
      const { HostExecutor } = await import('../src/infra/host-runner.js');
      return new HostExecutor();
    },
  },
];

test.each(RUNNERS)(
  '$runner returns the finished turn when the warm-pool refill throws',
  async ({ createExecutor }) => {
    vi.stubEnv('HOME', makeTempDir());
    const userPrompt = 'delegate the follow-up';
    const turnOutput = {
      status: 'success' as const,
      result: 'Delegated the follow-up.',
      toolsUsed: ['delegate'],
      toolExecutions: [
        { name: 'delegate', arguments: '{}', result: 'queued', durationMs: 5 },
      ],
      sideEffects: {
        delegations: [{ action: 'delegate' as const, prompt: 'follow up' }],
      },
    };
    // ENOMEM is one of the spawn failures Node throws synchronously.
    const refillError = Object.assign(new Error('spawn ENOMEM'), {
      code: 'ENOMEM',
    });
    let warmSpawnAttempts = 0;
    let foreground: ReturnType<typeof makeFakeChildProcess> | undefined;
    const spawn = vi.fn(
      (_command: string, args?: string[], options?: SpawnOptions) => {
        if (!findWarmIpcPath(args, options)) {
          foreground = makeFakeChildProcess();
          return foreground;
        }
        warmSpawnAttempts += 1;
        throw refillError;
      },
    );
    const warn = vi.fn();
    mockRunnerDeps({
      spawn,
      readOutput: async () => {
        if (!foreground) throw new Error('Fixture worker was not spawned.');
        const input = JSON.parse(
          String(foreground.stdin.write.mock.calls[0]?.[0]),
        ) as ContainerInput & { ipcAuthSecret: string };
        return {
          ...structuredClone(turnOutput),
          fileWriteGuardProof: encodeFileWriteGuardContext(
            input.ipcAuthSecret, input, userPrompt,
          ),
        };
      },
      warn,
    });

    const executor = await createExecutor();
    const output = await executor.exec({
      sessionId: 'session-refill',
      messages: [{ role: 'user', content: userPrompt }],
      chatbotId: 'bot-a',
      enableRag: false,
      model: 'gpt-5',
      agentId: 'main',
      channelId: 'tui',
    });

    expect(output).toEqual({
      ...turnOutput,
      fileWriteGuardSessionId: 'session-refill',
      fileWriteGuardUserPrompt: userPrompt,
    });
    // The failed refill is abandoned for this turn, not retried in a loop.
    expect(warmSpawnAttempts).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      { agentId: 'main', err: refillError },
      expect.any(String),
    );
  },
);

test.each(RUNNERS)(
  '$runner stops the warm refill once the agent leaves the traffic window',
  async ({ createExecutor }) => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'Date'],
      shouldAdvanceTime: true,
    });
    try {
      vi.stubEnv('HOME', makeTempDir());
      const warmProcesses: ReturnType<typeof makeFakeChildProcess>[] = [];
      let warmSessionDir = '';
      const spawn = vi.fn(
        (_command: string, args?: string[], options?: SpawnOptions) => {
          const proc = makeFakeChildProcess();
          const ipcPath = findWarmIpcPath(args, options);
          if (ipcPath) {
            warmProcesses.push(proc);
            warmSessionDir = path.dirname(ipcPath);
          }
          return proc;
        },
      );
      mockRunnerDeps({ spawn });

      const executor = await createExecutor();
      await executor.exec(turn('session-sweep'));

      const warmStopped = () => isWarmStopped(spawn, warmProcesses[0]);
      expect(warmProcesses).toHaveLength(1);
      vi.advanceTimersByTime(30 * 60_000);
      expect(warmStopped()).toBe(false);
      vi.advanceTimersByTime(31 * 60_000);
      expect(warmStopped()).toBe(true);

      expect(fs.existsSync(warmSessionDir)).toBe(true);
      warmProcesses[0]?.emit('close', null, 'SIGTERM');
      expect(fs.existsSync(warmSessionDir)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  },
);

test.each(RUNNERS)(
  '$runner keeps a phone agent\'s spare past the traffic window',
  async ({ createExecutor }) => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'Date'],
      shouldAdvanceTime: true,
    });
    try {
      vi.stubEnv('HOME', makeTempDir());
      const warmProcesses: ReturnType<typeof makeFakeChildProcess>[] = [];
      const spawn = spawnCollectingWarm(warmProcesses);
      mockRunnerDeps({ spawn });

      const executor = await createExecutor();
      await executor.exec(turn('session-phone', 'mobile'));

      expect(warmProcesses).toHaveLength(1);
      vi.advanceTimersByTime(3 * 60 * 60_000);
      expect(isWarmStopped(spawn, warmProcesses[0])).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  },
);

test.each(RUNNERS)(
  '$runner hands a new spare its MCP servers ahead of its first request',
  async ({ createExecutor }) => {
    vi.stubEnv('HOME', makeTempDir());
    vi.stubEnv('HYBRIDAI_API_KEY', 'test-key');
    const warmProcesses: ReturnType<typeof makeFakeChildProcess>[] = [];
    mockRunnerDeps({ spawn: spawnCollectingWarm(warmProcesses) });

    const executor = await createExecutor();
    await executor.exec(turn('session-a'));
    const spare = warmProcesses[0];
    await vi.waitFor(() => expect(spare?.stdin.write).toHaveBeenCalledOnce());
    // The next new session claims the spare.
    await executor.exec(turn('session-b'));

    const [frame, request] = (spare?.stdin.write.mock.calls ?? []).map(
      ([line]) => JSON.parse(String(line)),
    );
    const servers = readWarmWorkerFrame(frame);
    expect(servers).toHaveProperty('hybridai');
    // Same map as the frame, so the worker has nothing left to connect.
    expect(request).toMatchObject({ sessionId: 'session-b', mcpServers: servers });
  },
);
