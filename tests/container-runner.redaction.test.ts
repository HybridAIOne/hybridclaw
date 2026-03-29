import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;

function makeTempHome(): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-container-runner-redaction-'),
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('node:child_process');
  vi.doUnmock('../src/infra/ipc.js');
  vi.doUnmock('../src/providers/factory.js');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
});

test('ContainerExecutor redacts result and error strings from agent output', async () => {
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

  const { ContainerExecutor } = await import(
    '../src/infra/container-runner.js'
  );
  const executor = new ContainerExecutor();
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

test('ContainerExecutor stops and respawns a timed out pooled container', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const spawn = vi.fn(() => makeFakeChildProcess() as never);
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

  const { ContainerExecutor } = await import(
    '../src/infra/container-runner.js'
  );
  const executor = new ContainerExecutor();

  const firstOutput = await executor.exec({
    sessionId: 'heartbeat:main',
    messages: [{ role: 'user', content: 'heartbeat' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'main',
    channelId: 'heartbeat',
  });

  expect(firstOutput.status).toBe('error');
  const stopCallsAfterFirstRun = spawn.mock.calls.filter(
    (call) => Array.isArray(call[1]) && call[1][0] === 'stop',
  );
  expect(stopCallsAfterFirstRun).toHaveLength(1);

  const secondOutput = await executor.exec({
    sessionId: 'heartbeat:main',
    messages: [{ role: 'user', content: 'heartbeat retry' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'main',
    channelId: 'heartbeat',
  });

  expect(secondOutput.status).toBe('success');
  const runCalls = spawn.mock.calls.filter(
    (call) => Array.isArray(call[1]) && call[1][0] !== 'stop',
  );
  const stopCalls = spawn.mock.calls.filter(
    (call) => Array.isArray(call[1]) && call[1][0] === 'stop',
  );
  expect(runCalls).toHaveLength(2);
  expect(stopCalls).toHaveLength(1);
});

test('ContainerExecutor surfaces missing packaged runtime dependencies as immediate errors', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const proc = makeFakeChildProcess();
  const spawn = vi.fn(() => proc as never);
  const readOutput = vi.fn(async (_sessionId: string, _timeoutMs: number, opts?: {
    terminalError?: () => string | null;
  }) => {
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
  });
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

  const { ContainerExecutor } = await import(
    '../src/infra/container-runner.js'
  );
  const executor = new ContainerExecutor();
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
    'Container runtime exited before producing output (exit code 1).',
  );
  expect(output.error).toContain(
    'Missing runtime dependency: @modelcontextprotocol/sdk.',
  );
  expect(output.error).toContain('Reinstall HybridClaw.');
});
