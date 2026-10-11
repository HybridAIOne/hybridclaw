import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import type { ContainerOutput } from '../src/types/container.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-worker-release-');
useCleanMocks({
  restoreAllMocks: true,
  unstubAllEnvs: true,
  resetModules: true,
  unmock: [
    'node:child_process',
    '../src/infra/ipc.js',
    '../src/providers/factory.js',
    '../src/logger.js',
  ],
});

function makeFakeChildProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    exitCode: number | null;
  };
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn() };
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  return proc;
}

const SUCCESS: ContainerOutput = {
  status: 'success',
  result: 'Done.',
  toolsUsed: [],
};

async function loadRuntime(readOutput: () => Promise<ContainerOutput>) {
  vi.stubEnv('HOME', makeTempDir());
  vi.resetModules();
  const spawn = vi.fn(() => makeFakeChildProcess() as never);
  vi.doMock('node:child_process', async () => ({
    ...(await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    )),
    spawn,
  }));
  vi.doMock('../src/infra/ipc.js', async () => ({
    ...(await vi.importActual<typeof import('../src/infra/ipc.js')>(
      '../src/infra/ipc.js',
    )),
    readOutput: vi.fn(readOutput),
  }));
  vi.doMock('../src/providers/factory.js', async () => ({
    ...(await vi.importActual<typeof import('../src/providers/factory.js')>(
      '../src/providers/factory.js',
    )),
    resolveModelRuntimeCredentials: vi.fn(async () => ({
      provider: 'hybridai' as const,
      apiKey: '',
      baseUrl: 'https://example.com',
      chatbotId: 'bot-a',
      enableRag: false,
      requestHeaders: {},
      agentId: 'default',
      isLocal: false,
      contextWindow: 128_000,
      thinkingFormat: undefined,
    })),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  const { MAX_CONCURRENT_CONTAINERS } = await import('../src/config/config.js');
  const { getExecutor, stopAllExecutions } = await import(
    '../src/agent/executor.js'
  );
  const { gatewaySessionQueue, releaseSessionWorker } = await import(
    '../src/gateway/session-worker-release.js'
  );
  const runTurn = (sessionId: string) =>
    gatewaySessionQueue.run(sessionId, () =>
      getExecutor('container').exec({
        sessionId,
        messages: [{ role: 'user', content: 'hello' }],
        chatbotId: 'bot-a',
        enableRag: false,
        model: 'gpt-5',
        agentId: 'default',
        channelId: `voice:${sessionId}`,
      }),
    );
  const dockerStops = () =>
    spawn.mock.calls.filter(
      (call) => (call as unknown[])[1]?.[0] === 'stop',
    ).length;
  return {
    capacity: MAX_CONCURRENT_CONTAINERS,
    runTurn,
    releaseSessionWorker,
    stopAllExecutions,
    dockerStops,
  };
}

test.each([
  ['released at hangup', true, 0],
  ['left to the idle timeout', false, 2],
])(
  'calls in a row past the container cap with workers %s',
  async (_label, releaseAtHangup, expectedBusy) => {
    const runtime = await loadRuntime(async () => SUCCESS);
    const outputs: ContainerOutput[] = [];
    for (let call = 0; call < runtime.capacity + 2; call += 1) {
      const sessionId = `voice-call-${call}`;
      outputs.push(await runtime.runTurn(sessionId));
      if (releaseAtHangup) await runtime.releaseSessionWorker(sessionId);
    }
    runtime.stopAllExecutions();

    expect(outputs.filter((output) => output.errorCode === 'busy')).toHaveLength(
      expectedBusy,
    );
  },
);

test('hanging up mid-turn lets the turn finish before the worker stops', async () => {
  let finishTurn: (output: ContainerOutput) => void = () => {};
  const runtime = await loadRuntime(
    () =>
      new Promise<ContainerOutput>((resolve) => {
        finishTurn = resolve;
      }),
  );

  const turn = runtime.runTurn('voice-call-0');
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  const release = runtime.releaseSessionWorker('voice-call-0');
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  expect(runtime.dockerStops()).toBe(0);

  finishTurn({ ...SUCCESS, result: 'Late answer.' });
  await expect(turn).resolves.toMatchObject({ result: 'Late answer.' });
  await expect(release).resolves.toBe(true);
  expect(runtime.dockerStops()).toBe(1);
  runtime.stopAllExecutions();
});
