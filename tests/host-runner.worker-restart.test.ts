import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

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
  vi.doUnmock('node:child_process');
  vi.doUnmock('../src/infra/ipc.js');
  vi.doUnmock('../src/providers/factory.js');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
});

test('HostExecutor respawns the pooled worker when the provider changes for a session', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

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
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

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
  vi.resetModules();

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
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

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
  vi.resetModules();

  const spawned: ReturnType<typeof makeFakeChildProcess>[] = [];
  const spawn = vi.fn(() => {
    const proc = makeFakeChildProcess();
    spawned.push(proc);
    return proc as never;
  });
  const readOutput = vi
    .fn()
    .mockResolvedValueOnce({
      status: 'error' as const,
      result: null,
      toolsUsed: [],
      artifacts: [],
      error:
        'Timeout waiting for agent output after 1200000ms total (300000ms inactivity window)',
    })
    .mockResolvedValueOnce({
      status: 'success' as const,
      result: 'ok',
      toolsUsed: [],
      artifacts: [],
    });
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
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const executor = new HostExecutor();

  const firstOutput = await executor.exec({
    sessionId: 'heartbeat:main',
    messages: [{ role: 'user', content: 'heartbeat' }],
    chatbotId: 'bot-a',
    enableRag: true,
    model: 'gpt-5',
    agentId: 'main',
    channelId: 'heartbeat',
  });

  expect(firstOutput.status).toBe('error');
  expect(spawned[0]?.kill).toHaveBeenCalledWith('SIGTERM');

  const secondOutput = await executor.exec({
    sessionId: 'heartbeat:main',
    messages: [{ role: 'user', content: 'heartbeat retry' }],
    chatbotId: 'bot-a',
    enableRag: true,
    model: 'gpt-5',
    agentId: 'main',
    channelId: 'heartbeat',
  });

  expect(secondOutput.status).toBe('success');
  expect(spawn).toHaveBeenCalledTimes(2);
});
