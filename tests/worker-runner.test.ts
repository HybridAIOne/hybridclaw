import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { ContainerInput, ContainerOutput } from '../src/types/container.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

type WorkerStrategy = import('../src/infra/worker-runner.js').WorkerStrategy;
type ReadOutput = typeof import('../src/infra/ipc.js').readOutput;

const makeTempDir = useTempDir('hybridclaw-worker-runner-');
useCleanMocks({
  resetModules: true,
  unstubAllEnvs: true,
  unmock: [
    '../src/config/config.js',
    '../src/infra/ipc.js',
    '../src/logger.js',
    '../src/providers/factory.js',
  ],
});

function makeFakeChildProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn> };
    killed: boolean;
    exitCode: number | null;
    pid: number;
  };
  proc.stderr = new EventEmitter();
  proc.stdin = Object.assign(new EventEmitter(), { write: vi.fn() });
  proc.killed = false;
  proc.exitCode = null;
  proc.pid = 4242;
  return proc;
}
type FakeChild = ReturnType<typeof makeFakeChildProcess>;

const success: ContainerOutput = {
  status: 'success',
  result: 'done',
  toolsUsed: [],
};

function onAbortOutput(): ReadOutput {
  return (_session, _request, _timeout, options) =>
    new Promise((resolve) =>
      options?.signal?.addEventListener('abort', () =>
        resolve({
          status: 'error',
          result: null,
          toolsUsed: [],
          error: 'Interrupted by user.',
        }),
      ),
    );
}

async function loadRunner(params: {
  strategy?: Partial<WorkerStrategy>;
  readOutput?: ReadOutput;
  maxConcurrent?: number;
}) {
  vi.stubEnv('HOME', makeTempDir());
  const readOutput = vi.fn(params.readOutput ?? (async () => success));
  vi.doMock('../src/config/config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/config/config.js')>()),
    MAX_CONCURRENT_CONTAINERS: params.maxConcurrent ?? 5,
    CONTAINER_WARM_POOL: { enabled: false },
  }));
  vi.doMock('../src/infra/ipc.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/infra/ipc.js')>()),
    readOutput,
  }));
  vi.doMock('../src/providers/factory.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/providers/factory.js')>()),
    resolveModelRuntimeCredentials: async () => ({
      provider: 'hybridai' as const,
      apiKey: 'test-key',
      baseUrl: 'http://localhost:4000/v1',
      chatbotId: 'bot-a',
      enableRag: false,
      requestHeaders: {},
      agentId: 'main',
      isLocal: false,
      contextWindow: 128_000,
    }),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  const children: FakeChild[] = [];
  const strategy: WorkerStrategy = {
    mode: 'host',
    noun: { one: 'test worker', many: 'test workers' },
    runtimeLabel: 'Test worker',
    spawnErrorLabel: 'Test spawn error',
    spawn: vi.fn(() => {
      const child = makeFakeChildProcess();
      children.push(child);
      return { process: child as never, name: `worker-${children.length}` };
    }),
    stop: vi.fn(),
    guardsStdinErrors: false,
    memoryKey: (entry) => entry.name ?? null,
    readMemoryBytes: async () => 0,
    logFields: (entry) => ({ workerName: entry.name }),
    mapHostUrl: (url) => url.replace('localhost', 'gateway.example.com'),
    stateRoot: (_request, workspacePath) => workspacePath,
    sendsRuntimeEnv: false,
    ...params.strategy,
  };
  const { createWorkerRunner } = await import('../src/infra/worker-runner.js');
  return {
    runner: createWorkerRunner(strategy),
    strategy,
    children,
    readOutput,
  };
}

function request(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId,
    messages: [{ role: 'user' as const, content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'main',
    channelId: 'tui',
    ...extra,
  };
}

function firstStdinInput(child: FakeChild): ContainerInput {
  return JSON.parse(String(child.stdin.write.mock.calls[0]?.[0]));
}

describe('createWorkerRunner strategy seam', () => {
  it.each([
    true,
    false,
  ])('sends stored runtime env only when the strategy asks (%s), and maps host URLs', async (sendsRuntimeEnv) => {
    const { runner, children } = await loadRunner({
      strategy: { sendsRuntimeEnv },
    });

    await expect(runner.exec(request('session-a'))).resolves.toMatchObject(
      success,
    );

    const input = firstStdinInput(children[0]);
    expect(input.baseUrl).toBe('http://gateway.example.com:4000/v1');
    expect(input.gatewayBaseUrl).not.toContain('localhost');
    expect('runtimeEnv' in input).toBe(sendsRuntimeEnv);
    expect(input).toHaveProperty('ipcAuthSecret');
  });

  it('reuses the session worker and sends follow-ups without stdin', async () => {
    const { runner, strategy, children } = await loadRunner({});

    await runner.exec(request('session-a'));
    await runner.exec(request('session-a'));

    expect(strategy.spawn).toHaveBeenCalledOnce();
    expect(children[0].stdin.write).toHaveBeenCalledOnce();
    expect(runner.getActiveSessionIds()).toEqual(['session-a']);
  });

  it('reports a throwing spawn as an error result and keeps no entry', async () => {
    const { runner } = await loadRunner({
      strategy: {
        spawn: () => {
          throw new Error('runtime unavailable');
        },
      },
    });

    await expect(runner.exec(request('session-a'))).resolves.toEqual({
      status: 'error',
      result: null,
      toolsUsed: [],
      error: 'Test spawn error: runtime unavailable',
    });
    expect(runner.getActiveSessionCount()).toBe(0);
  });

  it.each([
    {
      capacityWaitMs: undefined,
      error: 'Too many active test workers (1/1). Try again later.',
    },
    {
      capacityWaitMs: () => 30,
      error:
        'Too many active test workers (1/1) after waiting 30ms. Try again later.',
    },
  ])('refuses a run over capacity without spawning (wait $capacityWaitMs)', async ({
    capacityWaitMs,
    error,
  }) => {
    const { runner, strategy } = await loadRunner({
      maxConcurrent: 1,
      readOutput: onAbortOutput(),
      strategy: { capacityWaitMs },
    });
    const controller = new AbortController();
    const busy = runner.exec(
      request('session-a', { abortSignal: controller.signal }),
    );
    await vi.waitFor(() => expect(runner.getInFlightSessionCount()).toBe(1));

    await expect(runner.exec(request('session-b'))).resolves.toEqual({
      status: 'error',
      result: null,
      toolsUsed: [],
      error,
      errorCode: 'busy',
    });
    expect(strategy.spawn).toHaveBeenCalledOnce();

    controller.abort();
    await busy;
  });

  it('returns an interrupt, not busy, when aborted while waiting for capacity', async () => {
    const { runner, strategy } = await loadRunner({
      maxConcurrent: 1,
      readOutput: onAbortOutput(),
      strategy: { capacityWaitMs: () => 60_000 },
    });
    const holder = new AbortController();
    const busy = runner.exec(
      request('session-a', { abortSignal: holder.signal }),
    );
    await vi.waitFor(() => expect(runner.getInFlightSessionCount()).toBe(1));

    const waiter = new AbortController();
    const waiting = runner.exec(
      request('session-b', { abortSignal: waiter.signal }),
    );
    waiter.abort();

    await expect(waiting).resolves.toMatchObject({
      status: 'error',
      error: 'Interrupted by user.',
    });
    expect(strategy.spawn).toHaveBeenCalledOnce();
    holder.abort();
    await busy;
  });

  it('stops an aborted worker once and drops it at once', async () => {
    const { runner, strategy, children } = await loadRunner({
      readOutput: onAbortOutput(),
    });
    const controller = new AbortController();
    const run = runner.exec(
      request('session-a', { abortSignal: controller.signal }),
    );
    await vi.waitFor(() => expect(runner.getInFlightSessionCount()).toBe(1));

    controller.abort();
    await run;

    expect(runner.getActiveSessionCount()).toBe(0);
    expect(runner.stopSession('session-a')).toBe(false);
    children[0].emit('close', null, 'SIGTERM');
    expect(strategy.stop).toHaveBeenCalledOnce();
  });

  it.each([
    { guardsStdinErrors: true, error: 'Interrupted by user.' },
    { guardsStdinErrors: false, error: expect.stringContaining('write EPIPE') },
  ])('handles a stdin write to a dead worker per strategy (guards $guardsStdinErrors)', async ({
    guardsStdinErrors,
    error,
  }) => {
    const { runner, strategy, readOutput } = await loadRunner({
      strategy: {
        guardsStdinErrors,
        spawn: () => {
          const child = makeFakeChildProcess();
          child.stdin.write.mockImplementation(() => {
            child.exitCode = 1;
            throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
          });
          return { process: child as never };
        },
      },
    });

    await expect(runner.exec(request('session-a'))).resolves.toMatchObject({
      status: 'error',
      error,
    });
    expect(readOutput).not.toHaveBeenCalled();
    expect(strategy.stop).toHaveBeenCalledTimes(guardsStdinErrors ? 0 : 1);
  });

  it('routes a turn through the strategy relay and always stops it', async () => {
    const relayStop = vi.fn();
    const { runner, children } = await loadRunner({
      readOutput: async () => {
        throw new Error('ipc broke');
      },
      strategy: {
        startModelRelay: ({ input }) => {
          input.baseUrl = 'http://relay.invalid/v1';
          input.apiKey = '';
          return { stop: relayStop };
        },
      },
    });

    await expect(runner.exec(request('session-a'))).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('ipc broke'),
    });
    const input = firstStdinInput(children[0]);
    expect(input.baseUrl).toBe('http://relay.invalid/v1');
    expect(input.apiKey).toBe('');
    expect(relayStop).toHaveBeenCalledOnce();
  });

  it('labels terminal errors with the strategy runtime and repair hint', async () => {
    const { runner, children } = await loadRunner({
      readOutput: (_session, _request, _timeout, options) =>
        new Promise((resolve) => {
          const poll = setInterval(() => {
            const terminalError = options?.terminalError?.();
            if (!terminalError) return;
            clearInterval(poll);
            resolve({
              status: 'error',
              result: null,
              toolsUsed: [],
              error: terminalError,
            });
          }, 5);
        }),
      strategy: { repairHint: 'Rebuild the test image.' },
    });
    const run = runner.exec(request('session-a'));
    await vi.waitFor(() => expect(children).toHaveLength(1));

    children[0].stderr.emit(
      'data',
      Buffer.from("Cannot find package 'left-pad' imported from /app\n"),
    );
    children[0].exitCode = 1;
    children[0].emit('close', 1, null);

    const output = await run;
    expect(output.error).toContain('Test worker exited before producing output');
    expect(output.error).toContain('left-pad');
    expect(output.error).toContain('Rebuild the test image.');
    expect(runner.getActiveSessionCount()).toBe(0);
  });
});
