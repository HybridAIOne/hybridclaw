import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;

function makeTempHome(): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-host-runner-redaction-'),
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
  vi.doUnmock('../src/infra/host-runtime-setup.js');
  vi.doUnmock('../src/infra/ipc.js');
  vi.doUnmock('../src/providers/factory.js');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
});

function mockHostRuntimeReady(): void {
  vi.doMock('../src/infra/host-runtime-setup.js', () => ({
    ensureHostRuntimeReady: () => ({
      command: process.execPath,
      args: ['/tmp/container/dist/index.js'],
    }),
  }));
}

test('HostExecutor redacts result and error strings from agent output', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const spawn = vi.fn(() => makeFakeChildProcess() as never);
  const readOutput = vi.fn(async () => ({
    status: 'error' as const,
    result: 'OPENAI_API_KEY=sk-1234567890abcdefghijklmnop',
    toolsUsed: [],
    artifacts: [],
    error: 'Authorization: Bearer 1234567890abcdefghijklmnopqrstuv',
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
  mockHostRuntimeReady();

  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const executor = new HostExecutor();
  const output = await executor.exec({
    sessionId: 'session-redaction',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'tui',
  });

  expect(output.result).toBe('OPENAI_API_KEY=sk-123...mnop');
  expect(output.error).toBe('Authorization: Bearer 123456...stuv');
});

test('HostExecutor exposes the uploaded media cache root to host agent processes', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const spawn = vi.fn(() => makeFakeChildProcess() as never);
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
  mockHostRuntimeReady();

  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const { resolveUploadedMediaCacheHostDir } = await import(
    '../src/media/uploaded-media-cache.ts'
  );
  const executor = new HostExecutor();

  await executor.exec({
    sessionId: 'session-uploaded-media-root',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'web',
  });

  const spawnEnv = spawn.mock.calls[0]?.[2]?.env as
    | NodeJS.ProcessEnv
    | undefined;
  expect(spawnEnv?.HYBRIDCLAW_AGENT_UPLOADED_MEDIA_ROOT).toBe(
    resolveUploadedMediaCacheHostDir(),
  );
  expect(JSON.parse(spawnEnv?.HYBRIDCLAW_AGENT_ALLOWED_ROOTS || '[]')).toEqual(
    expect.arrayContaining([os.homedir(), process.cwd(), os.tmpdir()]),
  );
});

test('HostExecutor treats interrupted stdin EPIPE as a user interrupt', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const proc = makeFakeChildProcess();
  const controller = new AbortController();
  proc.stdin.write.mockImplementation(() => {
    controller.abort(new Error('Interrupted by user.'));
    proc.killed = true;
    proc.exitCode = 0;
    const error = Object.assign(new Error('write EPIPE'), {
      code: 'EPIPE',
    });
    throw error;
  });

  const spawn = vi.fn(() => proc as never);
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
  mockHostRuntimeReady();

  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const executor = new HostExecutor();
  const output = await executor.exec({
    sessionId: 'session-interrupted-epipe',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'web',
    abortSignal: controller.signal,
  });

  expect(output).toEqual({
    status: 'error',
    result: null,
    toolsUsed: [],
    error: 'Interrupted by user.',
  });
  expect(readOutput).not.toHaveBeenCalled();
});

test('HostExecutor surfaces missing packaged runtime dependencies as immediate errors', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const proc = makeFakeChildProcess();
  const spawn = vi.fn(() => proc as never);
  const readOutput = vi.fn(
    async (
      _sessionId: string,
      _timeoutMs: number,
      opts?: {
        terminalError?: () => string | null;
      },
    ) => {
      proc.stderr.emit(
        'data',
        Buffer.from(
          "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@modelcontextprotocol/sdk' imported from /pkg/container/dist/mcp/client-manager.js\n",
        ),
      );
      proc.exitCode = 1;
      proc.emit('close', 1, null);
      return {
        status: 'error' as const,
        result: null,
        toolsUsed: [],
        artifacts: [],
        error: opts?.terminalError?.() || 'missing terminal error',
      };
    },
  );
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
  mockHostRuntimeReady();

  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const executor = new HostExecutor();
  const output = await executor.exec({
    sessionId: 'session-missing-runtime-dep',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'tui',
  });

  expect(output.status).toBe('error');
  expect(output.error).toContain(
    'Host agent process exited before producing output (exit code 1).',
  );
  expect(output.error).toContain(
    'Missing runtime dependency: @modelcontextprotocol/sdk.',
  );
  expect(output.error).toContain('Reinstall HybridClaw.');
});
