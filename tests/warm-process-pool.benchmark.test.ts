import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hc-warm-pool-bench-'));
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function makeFakeChildProcess(
  pid: number,
  requestStartDelayMs: number,
  advanceClock: (durationMs: number) => void,
) {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    stderr: EventEmitter;
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    exitCode: number | null;
  };
  proc.pid = pid;
  proc.stderr = new EventEmitter();
  proc.stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(() => {
      queueMicrotask(() => {
        advanceClock(requestStartDelayMs);
        proc.stderr.emit(
          'data',
          Buffer.from('[hybridclaw-agent] agent request start\n'),
        );
      });
      return true;
    }),
  });
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  queueMicrotask(() => {
    proc.stderr.emit(
      'data',
      Buffer.from('[hybridclaw-agent] ready for input\n'),
    );
  });
  return proc;
}

async function runSyntheticHostWorkload(requestStartDelayMs: number): Promise<{
  coldStartP95Ms: number | null;
  coldStartsRecorded: number;
  withinBudget: boolean;
  warmClaims: number;
}> {
  process.env.HOME = makeTempHome();
  vi.resetModules();

  let now = 1_700_000_000_000;
  let coldStartsRecorded = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);

  let nextPid = 10_000;
  const spawn = vi.fn(() => {
    nextPid += 1;
    return makeFakeChildProcess(nextPid, requestStartDelayMs, (durationMs) => {
      coldStartsRecorded += 1;
      now += durationMs;
    }) as never;
  });
  const loggerInfo = vi.fn();
  const readOutput = vi.fn(async () => ({
    status: 'success' as const,
    result: 'ok',
    toolsUsed: [],
    artifacts: [],
  }));
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
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
  }));

  vi.doMock('node:child_process', async () => {
    const actual =
      await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    return {
      ...actual,
      spawn,
    };
  });
  vi.doMock('../src/infra/host-runtime-setup.js', () => ({
    ensureHostRuntimeReady: () => ({
      command: process.execPath,
      args: ['/tmp/container/dist/index.js'],
    }),
  }));
  vi.doMock('../src/infra/ipc.js', async () => {
    const actual = await vi.importActual<typeof import('../src/infra/ipc.js')>(
      '../src/infra/ipc.js',
    );
    return {
      ...actual,
      readOutput,
    };
  });
  vi.doMock('../src/providers/factory.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/factory.js')
    >('../src/providers/factory.js');
    return {
      ...actual,
      resolveModelRuntimeCredentials,
    };
  });
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: loggerInfo,
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

  const {
    HostExecutor,
    getWarmHostColdStartP95Ms,
    isWarmHostColdStartWithinBudget,
  } = await import('../src/infra/host-runner.js');
  const executor = new HostExecutor();

  for (let index = 0; index < 20; index += 1) {
    const sessionId = `bench-${index}`;
    await executor.exec({
      sessionId,
      messages: [{ role: 'user', content: 'synthetic warm-pool turn' }],
      chatbotId: 'bot-a',
      enableRag: false,
      model: 'gpt-5',
      agentId: 'default',
      channelId: 'benchmark',
    });
    executor.stopSession(sessionId);
    await Promise.resolve();
  }

  return {
    coldStartP95Ms: getWarmHostColdStartP95Ms(),
    coldStartsRecorded,
    withinBudget: isWarmHostColdStartWithinBudget(),
    warmClaims: loggerInfo.mock.calls.filter(
      (call) => call[1] === 'Claimed warm host agent process',
    ).length,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('node:child_process');
  vi.doUnmock('../src/infra/host-runtime-setup.js');
  vi.doUnmock('../src/infra/ipc.js');
  vi.doUnmock('../src/providers/factory.js');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
});

test('benchmark keeps p95 cold-start within the warm-process budget on a synthetic host workload', async () => {
  const result = await runSyntheticHostWorkload(50);

  expect(result.coldStartP95Ms).toBe(50);
  expect(result.coldStartsRecorded).toBe(20);
  expect(result.warmClaims).toBeGreaterThan(0);
  expect(result.withinBudget).toBe(true);
});

test('benchmark detects p95 cold-start budget violations on a synthetic host workload', async () => {
  const result = await runSyntheticHostWorkload(250);

  expect(result.coldStartP95Ms).toBe(250);
  expect(result.coldStartsRecorded).toBe(20);
  expect(result.warmClaims).toBeGreaterThan(0);
  expect(result.withinBudget).toBe(false);
});
