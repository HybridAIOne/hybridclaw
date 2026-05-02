import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

let spawnImpl: (...args: unknown[]) => unknown = () => {
  throw new Error('spawn not configured for this test');
};

let readOutputImpl: (...args: unknown[]) => unknown = () => {
  throw new Error('readOutput not configured for this test');
};

let resolveModelRuntimeCredentialsImpl: (...args: unknown[]) => unknown =
  () => {
    throw new Error(
      'resolveModelRuntimeCredentials not configured for this test',
    );
  };

vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnImpl(...args),
  };
});

vi.mock('../src/infra/ipc.js', async () => {
  const actual = await vi.importActual<typeof import('../src/infra/ipc.js')>(
    '../src/infra/ipc.js',
  );
  return {
    ...actual,
    readOutput: (...args: unknown[]) => readOutputImpl(...args),
  };
});

vi.mock('../src/providers/factory.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/providers/factory.js')
  >('../src/providers/factory.js');
  return {
    ...actual,
    resolveModelRuntimeCredentials: (...args: unknown[]) =>
      resolveModelRuntimeCredentialsImpl(...args),
  };
});

vi.mock('../src/config/config.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/config/config.js')
  >('../src/config/config.js');
  return {
    ...actual,
    CONTAINER_WARM_POOL: {
      ...actual.CONTAINER_WARM_POOL,
      enabled: false,
    },
  };
});

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const ORIGINAL_HOME = process.env.HOME;

function makeTempHome(): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-host-runner-restart-'),
  );
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function makeFakeChildProcess() {
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
  });
  const proc = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    exitCode: number | null;
  };
  proc.stderr = new EventEmitter();
  proc.stdin = stdin;
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  return proc;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  spawnImpl = () => {
    throw new Error('spawn not configured for this test');
  };
  readOutputImpl = () => {
    throw new Error('readOutput not configured for this test');
  };
  resolveModelRuntimeCredentialsImpl = () => {
    throw new Error(
      'resolveModelRuntimeCredentials not configured for this test',
    );
  };
});

test('HostExecutor respawns the pooled worker when the provider changes for a session', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;

  const spawned: ReturnType<typeof makeFakeChildProcess>[] = [];
  const spawn = vi.fn(() => {
    const proc = makeFakeChildProcess();
    spawned.push(proc);
    return proc as never;
  });
  const readOutput = vi.fn(async () => ({
    status: 'success' as const,
    result: 'ok',
    toolsUsed: [],
    artifacts: [],
  }));
  const resolveModelRuntimeCredentials = vi.fn(
    async ({ model }: { model?: string }) => {
      if (String(model).startsWith('lmstudio/')) {
        return {
          provider: 'lmstudio' as const,
          apiKey: '',
          baseUrl: 'http://127.0.0.1:1234/v1',
          chatbotId: '',
          enableRag: false,
          requestHeaders: {},
          agentId: 'lmstudio',
          isLocal: true,
          contextWindow: 32_768,
          thinkingFormat: undefined,
        };
      }
      return {
        provider: 'vllm' as const,
        apiKey: '',
        baseUrl: 'http://haigpu1:8000/v1',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'vllm',
        isLocal: true,
        contextWindow: 32_768,
        thinkingFormat: undefined,
      };
    },
  );

  spawnImpl = spawn;
  readOutputImpl = readOutput;
  resolveModelRuntimeCredentialsImpl = resolveModelRuntimeCredentials;

  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const executor = new HostExecutor();

  await executor.exec({
    sessionId: 'tui:local',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: '',
    enableRag: false,
    model: 'lmstudio/qwen',
    agentId: 'lmstudio',
    channelId: 'tui',
  });

  await executor.exec({
    sessionId: 'tui:local',
    messages: [{ role: 'user', content: 'hello again' }],
    chatbotId: '',
    enableRag: false,
    model: 'vllm/mistral',
    agentId: 'vllm',
    channelId: 'tui',
  });

  expect(spawn).toHaveBeenCalledTimes(2);
  expect(spawned[0]?.kill).toHaveBeenCalledWith('SIGTERM');
  expect(String(spawn.mock.calls[0]?.[2]?.cwd || '')).toContain(
    path.join('.hybridclaw', 'data', 'agents', 'lmstudio', 'workspace'),
  );
  expect(String(spawn.mock.calls[1]?.[2]?.cwd || '')).toContain(
    path.join('.hybridclaw', 'data', 'agents', 'vllm', 'workspace'),
  );
});

test('HostExecutor respawns the pooled worker when the agentId changes without auth changes', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;

  const spawned: ReturnType<typeof makeFakeChildProcess>[] = [];
  const spawn = vi.fn(() => {
    const proc = makeFakeChildProcess();
    spawned.push(proc);
    return proc as never;
  });
  const readOutput = vi.fn(async () => ({
    status: 'success' as const,
    result: 'ok',
    toolsUsed: [],
    artifacts: [],
  }));
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'hybridai' as const,
    apiKey: 'shared-token',
    baseUrl: 'https://hybridai.one',
    chatbotId: 'bot-a',
    enableRag: true,
    requestHeaders: {},
    agentId: 'default',
    isLocal: false,
    contextWindow: 128_000,
    thinkingFormat: undefined,
  }));

  spawnImpl = spawn;
  readOutputImpl = readOutput;
  resolveModelRuntimeCredentialsImpl = resolveModelRuntimeCredentials;

  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const executor = new HostExecutor();

  await executor.exec({
    sessionId: 'tui:local',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: true,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'tui',
  });

  await executor.exec({
    sessionId: 'tui:local',
    messages: [{ role: 'user', content: 'hello again' }],
    chatbotId: 'bot-a',
    enableRag: true,
    model: 'gpt-5',
    agentId: 'workspace-b',
    channelId: 'tui',
  });

  expect(spawn).toHaveBeenCalledTimes(2);
  expect(spawned[0]?.kill).toHaveBeenCalledWith('SIGTERM');
  expect(String(spawn.mock.calls[0]?.[2]?.cwd || '')).toContain(
    path.join('.hybridclaw', 'data', 'agents', 'default', 'workspace'),
  );
  expect(String(spawn.mock.calls[1]?.[2]?.cwd || '')).toContain(
    path.join('.hybridclaw', 'data', 'agents', 'workspace-b', 'workspace'),
  );
});

test('HostExecutor stops and respawns a timed out pooled worker', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;

  const spawned: ReturnType<typeof makeFakeChildProcess>[] = [];
  const spawn = vi.fn(() => {
    const proc = makeFakeChildProcess();
    spawned.push(proc);
    return proc as never;
  });
  let readOutputCallCount = 0;
  const readOutput = vi.fn(async () => {
    readOutputCallCount++;
    if (readOutputCallCount === 1) {
      return {
        status: 'error' as const,
        result: null,
        toolsUsed: [],
        error: 'Timeout waiting for agent output after 300000ms',
      };
    }
    return {
      status: 'success' as const,
      result: 'ok',
      toolsUsed: [],
      artifacts: [],
    };
  });
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'hybridai' as const,
    apiKey: 'token',
    baseUrl: 'https://hybridai.one',
    chatbotId: 'bot-a',
    enableRag: true,
    requestHeaders: {},
    agentId: 'default',
    isLocal: false,
    contextWindow: 128_000,
    thinkingFormat: undefined,
  }));

  spawnImpl = spawn;
  readOutputImpl = readOutput;
  resolveModelRuntimeCredentialsImpl = resolveModelRuntimeCredentials;

  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const executor = new HostExecutor();

  const firstOutput = await executor.exec({
    sessionId: 'tui:local',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: true,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'tui',
  });

  expect(firstOutput.status).toBe('error');
  expect(spawned[0]?.kill).toHaveBeenCalledWith('SIGTERM');

  const secondOutput = await executor.exec({
    sessionId: 'tui:local',
    messages: [{ role: 'user', content: 'hello again' }],
    chatbotId: 'bot-a',
    enableRag: true,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'tui',
  });

  expect(secondOutput.status).toBe('success');
  expect(spawn).toHaveBeenCalledTimes(2);
});

test('HostExecutor waits briefly for capacity instead of failing immediately when the host pool is full', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;

  const spawned: ReturnType<typeof makeFakeChildProcess>[] = [];
  const spawn = vi.fn(() => {
    const proc = makeFakeChildProcess();
    spawned.push(proc);
    return proc as never;
  });
  const readOutput = vi.fn(
    () =>
      new Promise<{
        status: 'success';
        result: string;
        toolsUsed: string[];
        artifacts: string[];
      }>((resolve) => {
        setTimeout(
          () =>
            resolve({
              status: 'success',
              result: 'ok',
              toolsUsed: [],
              artifacts: [],
            }),
          200,
        );
      }),
  );
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'hybridai' as const,
    apiKey: 'token',
    baseUrl: 'https://hybridai.one',
    chatbotId: 'bot-a',
    enableRag: true,
    requestHeaders: {},
    agentId: 'default',
    isLocal: false,
    contextWindow: 128_000,
    thinkingFormat: undefined,
  }));

  spawnImpl = spawn;
  readOutputImpl = readOutput;
  resolveModelRuntimeCredentialsImpl = resolveModelRuntimeCredentials;

  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const executor = new HostExecutor();

  const sessions = [
    'sess-1',
    'sess-2',
    'sess-3',
    'sess-4',
    'heartbeat:main',
  ] as const;
  const promises = sessions.map((sessionId) =>
    executor.exec({
      sessionId,
      messages: [{ role: 'user', content: 'hello' }],
      chatbotId: 'bot-a',
      enableRag: true,
      model: 'gpt-5',
      agentId: 'default',
      channelId: 'tui',
    }),
  );

  await vi.waitFor(() => {
    expect(spawn).toHaveBeenCalledTimes(5);
  });

  const results = await Promise.all(promises);
  expect(results.every((r) => r.status === 'success')).toBe(true);
});
