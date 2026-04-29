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

test('ContainerExecutor preserves user-visible result and error strings from agent output', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const spawn = vi.fn(() => makeFakeChildProcess() as never);
  const readOutput = vi.fn(async () => ({
    status: 'error' as const,
    result:
      'Invited max.noller@hybridai.one and used OPENAI_API_KEY=sk-1234567890abcdefghijklmnop.',
    toolsUsed: [],
    artifacts: [],
    error:
      'Could not notify stephan.noller@hybridai.one with Authorization: Bearer 1234567890abcdefghijklmnopqrstuv',
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

  expect(output.result).toBe(
    'Invited max.noller@hybridai.one and used OPENAI_API_KEY=sk-123...mnop.',
  );
  expect(output.error).toBe(
    'Could not notify stephan.noller@hybridai.one with Authorization: Bearer 123456...stuv',
  );
});

test('ContainerExecutor preserves user-visible streamed text and tool progress while redacting credentials', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const proc = makeFakeChildProcess();
  const spawn = vi.fn(() => proc as never);
  const readOutput = vi.fn(async () => {
    const delta = Buffer.from(
      'Invited max.noller@hybridai.one with token sk-1234567890abcdefghijklmnop.',
      'utf-8',
    ).toString('base64');
    proc.stderr.emit('data', Buffer.from(`[stream] ${delta}\n`));
    proc.stderr.emit(
      'data',
      Buffer.from(
        '[tool] bash result (12ms): emailed user@example.com with OPENAI_API_KEY=sk-1234567890abcdefghijklmnop\n',
      ),
    );
    return {
      status: 'success' as const,
      result: 'ok',
      toolsUsed: [],
      artifacts: [],
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
  const deltas: string[] = [];
  const toolEvents: Array<{ preview?: string }> = [];
  await executor.exec({
    sessionId: 'session-stream-visible',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'tui',
    onTextDelta: (delta) => deltas.push(delta),
    onToolProgress: (event) => toolEvents.push(event),
  });

  expect(deltas).toEqual([
    'Invited max.noller@hybridai.one with token sk-123...mnop.',
  ]);
  expect(toolEvents[0]?.preview).toBe(
    'emailed user@example.com with OPENAI_API_KEY=sk-123...mnop',
  );
});

test('ContainerExecutor preserves user-visible approval details while redacting credentials', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const spawn = vi.fn(() => makeFakeChildProcess() as never);
  const readOutput = vi.fn(async () => ({
    status: 'success' as const,
    result: 'Approval needed.',
    toolsUsed: ['web_search'],
    artifacts: [],
    pendingApproval: {
      approvalId: '089 4233232',
      prompt:
        'I need your approval before I call +49 170 3330160, contact user@example.com, and use OPENAI_API_KEY=sk-1234567890abcdefghijklmnop.',
      intent: 'contact +49 170 3330160',
      reason: 'notify user@example.com',
      allowSession: true,
      allowAgent: true,
      allowAll: true,
      expiresAt: 1_710_000_000_000,
    },
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
    sessionId: 'session-approval-redaction',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'tui',
  });

  expect(output.pendingApproval?.approvalId).toBe('089 4233232');
  expect(output.pendingApproval?.prompt).toContain('+49 170 3330160');
  expect(output.pendingApproval?.prompt).toContain('user@example.com');
  expect(output.pendingApproval?.prompt).toContain(
    'OPENAI_API_KEY=sk-123...mnop',
  );
  expect(output.pendingApproval?.intent).toContain('+49 170 3330160');
  expect(output.pendingApproval?.reason).toContain('user@example.com');
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
    (call) => Array.isArray(call[1]) && call[1][0] === 'run',
  );
  const activeRunCalls = runCalls.filter((call) => {
    const args = call[1];
    if (!Array.isArray(args)) return false;
    const nameIndex = args.indexOf('--name');
    const containerName =
      nameIndex >= 0 && typeof args[nameIndex + 1] === 'string'
        ? args[nameIndex + 1]
        : '';
    return !containerName.includes('warm-');
  });
  const stopCalls = spawn.mock.calls.filter(
    (call) => Array.isArray(call[1]) && call[1][0] === 'stop',
  );
  expect(activeRunCalls).toHaveLength(2);
  expect(stopCalls).toHaveLength(1);
});

test('ContainerExecutor stages the container node_modules symlink before docker launch', async () => {
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

  const { getSessionPaths } = await import('../src/infra/ipc.js');
  const { workspacePath } = getSessionPaths('session-node-link', 'default');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.symlinkSync(
    '/Users/example/project/node_modules',
    path.join(workspacePath, 'node_modules'),
    'dir',
  );

  const { ContainerExecutor } = await import(
    '../src/infra/container-runner.js'
  );
  const executor = new ContainerExecutor();

  await executor.exec({
    sessionId: 'session-node-link',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'tui',
  });

  expect(fs.readlinkSync(path.join(workspacePath, 'node_modules'))).toBe(
    '/app/node_modules',
  );
  expect(
    spawn.mock.calls.some(
      (call) =>
        Array.isArray(call[1]) &&
        call[1].includes(`${workspacePath}:/workspace:rw`),
    ),
  ).toBe(true);
});

test('ContainerExecutor disables internal text streaming when no text callback is provided', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const proc = makeFakeChildProcess();
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

  const { ContainerExecutor } = await import(
    '../src/infra/container-runner.js'
  );
  const executor = new ContainerExecutor();

  await executor.exec({
    sessionId: 'session-no-stream-ipc',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'web',
  });

  expect(proc.stdin.write).toHaveBeenCalledTimes(1);
  const firstInput = JSON.parse(
    String(proc.stdin.write.mock.calls[0]?.[0] || '').trim(),
  ) as Record<string, unknown>;
  expect(firstInput).toMatchObject({
    streamTextDeltas: false,
  });
});

test('ContainerExecutor does not apply the HybridAI token cap to remote OpenAI-compatible providers by default', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const proc = makeFakeChildProcess();
  const spawn = vi.fn(() => proc as never);
  const readOutput = vi.fn(async () => ({
    status: 'success' as const,
    result: 'ok',
    toolsUsed: [],
    artifacts: [],
  }));
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'openrouter' as const,
    apiKey: '',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatbotId: '',
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

  await executor.exec({
    sessionId: 'session-openrouter-max-tokens',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: '',
    enableRag: false,
    model: 'openrouter/qwen/qwen3.5-27b',
    agentId: 'default',
    channelId: 'web',
  });

  const firstInput = JSON.parse(
    String(proc.stdin.write.mock.calls[0]?.[0] || '').trim(),
  ) as Record<string, unknown>;
  expect(firstInput).not.toHaveProperty('maxTokens');
});

test('ContainerExecutor uses discovered maxTokens for Anthropic OpenRouter models', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const proc = makeFakeChildProcess();
  const spawn = vi.fn(() => proc as never);
  const readOutput = vi.fn(async () => ({
    status: 'success' as const,
    result: 'ok',
    toolsUsed: [],
    artifacts: [],
  }));
  const resolveModelRuntimeCredentials = vi.fn(async () => ({
    provider: 'openrouter' as const,
    apiKey: '',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'default',
    isLocal: false,
    contextWindow: 200_000,
    maxTokens: 64_000,
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

  await executor.exec({
    sessionId: 'session-openrouter-anthropic-max-tokens',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: '',
    enableRag: false,
    model: 'openrouter/anthropic/claude-sonnet-4',
    agentId: 'default',
    channelId: 'web',
  });

  const firstInput = JSON.parse(
    String(proc.stdin.write.mock.calls[0]?.[0] || '').trim(),
  ) as Record<string, unknown>;
  expect(firstInput.maxTokens).toBe(64_000);
});

test('ContainerExecutor surfaces missing packaged runtime dependencies as immediate errors', async () => {
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

test('ContainerExecutor forwards maxWallClockMs to the IPC output reader', async () => {
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

  const { ContainerExecutor } = await import(
    '../src/infra/container-runner.js'
  );
  const executor = new ContainerExecutor();

  await executor.exec({
    sessionId: 'session-max-wall-clock',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'tui',
    maxWallClockMs: 3_600_000,
  });

  expect(readOutput).toHaveBeenCalledWith(
    'session-max-wall-clock',
    expect.any(Number),
    expect.objectContaining({
      maxWallClockMs: 3_600_000,
    }),
  );
});

test('ContainerExecutor forwards disabled inactivity timeout to the IPC output reader', async () => {
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

  const { ContainerExecutor } = await import(
    '../src/infra/container-runner.js'
  );
  const executor = new ContainerExecutor();

  await executor.exec({
    sessionId: 'session-no-inactivity-timeout',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'tui',
    inactivityTimeoutMs: null,
  });

  expect(readOutput).toHaveBeenCalledWith(
    'session-no-inactivity-timeout',
    null,
    expect.any(Object),
  );
});
