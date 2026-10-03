import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { ipcOutputFileName } from '../container/shared/ipc-output-files.js';
import { steerInboxDirName } from '../container/shared/steer-inbox.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-runner-interrupt-');
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllEnvs: true,
  unmock: [
    'node:child_process',
    '../src/config/config.js',
    '../src/infra/host-runtime-setup.js',
    '../src/logger.js',
    '../src/providers/factory.js',
  ],
});

type FakeProcess = EventEmitter & {
  stderr: EventEmitter;
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  exitCode: number | null;
};

function makeFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
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

function stdinRequestId(proc: FakeProcess): string | undefined {
  return JSON.parse(String(proc.stdin.write.mock.calls[0]?.[0])).requestId;
}

const RUNNERS = [
  {
    runner: 'container',
    // `docker stop` is a separate process; the `docker run` client stays alive.
    isAgentSpawn: (args: string[]) => args[0] === 'run',
    createExecutor: async () => {
      const { ContainerExecutor } = await import(
        '../src/infra/container-runner.js'
      );
      return new ContainerExecutor();
    },
  },
  {
    runner: 'host',
    isAgentSpawn: () => true,
    createExecutor: async () => {
      vi.doMock('../src/infra/host-runtime-setup.js', () => ({
        ensureHostRuntimeReady: () => ({
          command: process.execPath,
          args: ['agent.js'],
        }),
      }));
      const { HostExecutor } = await import('../src/infra/host-runner.js');
      return new HostExecutor();
    },
  },
];

async function startRunner({
  isAgentSpawn,
  createExecutor,
}: (typeof RUNNERS)[number]) {
  const homeDir = makeTempDir();
  vi.stubEnv('HOME', homeDir);

  const agents: FakeProcess[] = [];
  vi.doMock('node:child_process', async () => {
    const actual =
      await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    return {
      ...actual,
      spawn: vi.fn((_command: string, args: string[]) => {
        const proc = makeFakeProcess();
        if (isAgentSpawn(args)) agents.push(proc);
        return proc;
      }),
    };
  });
  vi.doMock('../src/providers/factory.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/factory.js')
    >('../src/providers/factory.js');
    return {
      ...actual,
      resolveModelRuntimeCredentials: vi.fn(async () => ({
        provider: 'hybridai' as const,
        apiKey: 'test-key',
        baseUrl: 'https://hybridai.one',
        chatbotId: 'bot-a',
        enableRag: false,
        requestHeaders: {},
        agentId: 'default',
        isLocal: false,
        contextWindow: 128_000,
        thinkingFormat: undefined,
      })),
    };
  });
  // A claimed warm process has its own IPC dir; the race needs the session's.
  vi.doMock('../src/config/config.js', async () => {
    const actual =
      await vi.importActual<typeof import('../src/config/config.js')>(
        '../src/config/config.js',
      );
    return {
      ...actual,
      CONTAINER_WARM_POOL: { ...actual.CONTAINER_WARM_POOL, enabled: false },
    };
  });
  vi.doMock('../src/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  const executor = await createExecutor();
  const request = {
    sessionId: 'session-interrupt',
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'tui',
  };
  const ipcDir = path.join(
    homeDir,
    '.hybridclaw',
    'data',
    'sessions',
    'session-interrupt',
    'ipc',
  );

  return { executor, agents, request, ipcDir };
}

test.each(RUNNERS)('$runner: a turn started right after an interrupt gets its own reply, not the stopped turn’s late reply', async (runner) => {
  const { executor, agents, request, ipcDir } = await startRunner(runner);

  const controller = new AbortController();
  const interrupted = executor.exec({
    ...request,
    messages: [{ role: 'user', content: 'delegate the research' }],
    abortSignal: controller.signal,
  });
  await vi.waitFor(() => expect(agents[0]?.stdin.write).toHaveBeenCalled());
  controller.abort();
  await expect(interrupted).resolves.toMatchObject({
    status: 'error',
    error: 'Interrupted by user.',
  });

  const next = executor.exec({
    ...request,
    messages: [{ role: 'user', content: 'what happened?' }],
  });
  // The stopped process has not exited yet; the next turn must not reuse it.
  await vi.waitFor(() => expect(agents[1]?.stdin.write).toHaveBeenCalled());
  const staleRequestId = stdinRequestId(agents[0]);
  const requestId = stdinRequestId(agents[1]);
  expect(requestId).toEqual(expect.any(String));
  expect(requestId).not.toBe(staleRequestId);

  // The stopped agent's SIGTERM handler answers after the next turn cleaned
  // the shared IPC dir, carrying the delegation it had queued.
  fs.writeFileSync(
    path.join(ipcDir, ipcOutputFileName(staleRequestId)),
    JSON.stringify({
      status: 'error',
      result: null,
      toolsUsed: [],
      error:
        'Request interrupted: the agent process received SIGTERM before producing a final response.',
      sideEffects: {
        delegations: [{ action: 'delegate', mode: 'single', prompt: 'stale' }],
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.writeFileSync(
    path.join(ipcDir, ipcOutputFileName(requestId)),
    JSON.stringify({ status: 'success', result: 'fresh reply', toolsUsed: [] }),
  );

  await expect(next).resolves.toEqual({
    status: 'success',
    result: 'fresh reply',
    toolsUsed: [],
  });
});

test.each(RUNNERS)('$runner: a running request takes steering notes in its own inbox, and none once it has replied', async (runner) => {
  const { executor, agents, request, ipcDir } = await startRunner(runner);
  const { SteerInbox } = await import('../src/infra/steer-inbox.js');
  const steerInbox = new SteerInbox();
  expect(steerInbox.deliver('before the request')).toBe(false);

  const running = executor.exec({
    ...request,
    messages: [{ role: 'user', content: 'plan my week' }],
    steerInbox,
  });
  await vi.waitFor(() => expect(agents[0]?.stdin.write).toHaveBeenCalled());
  const requestId = String(stdinRequestId(agents[0]));
  expect(steerInbox.deliver('before the agent took it')).toBe(false);
  // The agent makes its inbox when it takes the request.
  fs.mkdirSync(path.join(ipcDir, steerInboxDirName(requestId)));
  expect(steerInbox.deliver('skip Friday')).toBe(true);
  expect(
    fs.readdirSync(path.join(ipcDir, steerInboxDirName(requestId))),
  ).toHaveLength(1);

  fs.writeFileSync(
    path.join(ipcDir, ipcOutputFileName(requestId)),
    JSON.stringify({ status: 'success', result: 'done', toolsUsed: [] }),
  );
  await running;

  expect(steerInbox.deliver('after the reply')).toBe(false);
  expect(
    fs.readdirSync(ipcDir).filter((name) => name.startsWith('steer-')),
  ).toEqual([]);
});
