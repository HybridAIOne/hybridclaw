import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

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

// Refill spawns run under a `warm_<agent>_…` IPC session: the container runner
// bind-mounts that dir, the host runner passes it in the child env.
const WARM_IPC_DIR = `${path.sep}sessions${path.sep}warm_`;

function isWarmSpawn(args: string[] = [], options?: SpawnOptions): boolean {
  const ipcRefs = [...args, options?.env?.HYBRIDCLAW_AGENT_IPC_DIR ?? ''];
  return ipcRefs.some((ref) => ref.includes(WARM_IPC_DIR));
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
    const spawn = vi.fn(
      (_command: string, args?: string[], options?: SpawnOptions) => {
        if (!isWarmSpawn(args, options)) return makeFakeChildProcess();
        warmSpawnAttempts += 1;
        throw refillError;
      },
    );
    const warn = vi.fn();
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      spawn,
    }));
    vi.doMock('../src/infra/ipc.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/infra/ipc.js')>()),
      readOutput: async () => structuredClone(turnOutput),
    }));
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
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    }));

    const executor = await createExecutor();
    const output = await executor.exec({
      sessionId: 'session-refill',
      messages: [{ role: 'user', content: 'delegate the follow-up' }],
      chatbotId: 'bot-a',
      enableRag: false,
      model: 'gpt-5',
      agentId: 'main',
      channelId: 'tui',
    });

    expect(output).toEqual(turnOutput);
    // The failed refill is abandoned for this turn, not retried in a loop.
    expect(warmSpawnAttempts).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      { agentId: 'main', err: refillError },
      expect.any(String),
    );
  },
);
