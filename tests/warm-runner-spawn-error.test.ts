import { expect, test, vi } from 'vitest';

import {
  makeStdiolessChildProcess,
  settleCatchingUncaught,
} from './helpers/spawn-fd-exhaustion.ts';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-spawn-error-');
useCleanMocks({
  resetModules: true,
  unstubAllEnvs: true,
  unmock: [
    'node:child_process',
    '../src/infra/host-runtime-setup.js',
    '../src/logger.js',
    '../src/providers/factory.js',
  ],
});

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
  '$runner fails a cold spawn without crashing when file descriptors run out',
  async ({ createExecutor }) => {
    vi.stubEnv('HOME', makeTempDir());
    const spawn = vi.fn((command: string, args: string[]) =>
      makeStdiolessChildProcess(command, args),
    );
    const error = vi.fn();
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      spawn,
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
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error },
    }));
    const executor = await createExecutor();

    const { outcome, uncaught } = await settleCatchingUncaught(() =>
      executor.exec({
        sessionId: 'session-emfile',
        messages: [{ role: 'user', content: 'hello' }],
        chatbotId: 'bot-a',
        enableRag: false,
        model: 'gpt-5',
        agentId: 'main',
        channelId: 'tui',
      }),
    );

    expect(uncaught).toEqual([]);
    expect(spawn).toHaveBeenCalledOnce();
    expect(outcome).toEqual({
      status: 'fulfilled',
      value: {
        status: 'error',
        result: null,
        toolsUsed: [],
        error: expect.stringMatching(/spawn error/i),
      },
    });
    // The runner's own listener took the error, errno intact for the log.
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'EMFILE' }),
      }),
      expect.any(String),
    );
  },
);
