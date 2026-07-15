import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_GATEWAY_API_TOKEN = process.env.GATEWAY_API_TOKEN;

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
  restoreEnvVar('GATEWAY_API_TOKEN', ORIGINAL_GATEWAY_API_TOKEN);
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

test('ContainerExecutor claims a warm container for a later session', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const spawnedRuns: Array<{
    args: string[];
    proc: ReturnType<typeof makeFakeChildProcess>;
  }> = [];
  const spawn = vi.fn((command: string, args?: string[]) => {
    const proc = makeFakeChildProcess();
    if (command === 'docker' && Array.isArray(args) && args[0] === 'run') {
      spawnedRuns.push({ args: [...args], proc });
    }
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
  const loggerInfo = vi.fn();

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
      info: loggerInfo,
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

  const { ContainerExecutor } = await import(
    '../src/infra/container-runner.js'
  );
  const executor = new ContainerExecutor();

  await executor.exec({
    sessionId: 'session-before-warm',
    messages: [{ role: 'user', content: 'prime warm pool' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'tui',
  });
  executor.stopSession('session-before-warm');

  const initialWarmRun = spawnedRuns.find(({ args }) => {
    const nameIndex = args.indexOf('--name');
    const containerName =
      nameIndex >= 0 && typeof args[nameIndex + 1] === 'string'
        ? args[nameIndex + 1]
        : '';
    return containerName.startsWith('hybridclaw-warm-');
  });
  expect(initialWarmRun).toBeDefined();
  expect(initialWarmRun?.proc.stdin.write).not.toHaveBeenCalled();

  await executor.exec({
    sessionId: 'session-claims-warm',
    messages: [{ role: 'user', content: 'claim warm pool' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'tui',
  });

  expect(loggerInfo).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-claims-warm',
      agentId: 'default',
      containerName: expect.stringContaining('warm-'),
    }),
    'Claimed warm container',
  );
  expect(initialWarmRun?.proc.stdin.write).toHaveBeenCalledTimes(1);
});

test('ContainerExecutor injects gateway runtime env into docker launch', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.GATEWAY_API_TOKEN = 'gateway-secret';
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
    sessionId: 'session-gateway-env',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'tui',
  });

  const runArgs = spawn.mock.calls.find(
    (call) => call[0] === 'docker' && Array.isArray(call[1]),
  )?.[1] as string[] | undefined;
  expect(runArgs).toContain(
    'HYBRIDCLAW_GATEWAY_URL=http://host.docker.internal:9090',
  );
  expect(runArgs).toContain('HYBRIDCLAW_GATEWAY_TOKEN=gateway-secret');
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

test('ContainerExecutor isolates instance data mounts while staging current shared-user media', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.GATEWAY_API_TOKEN = 'shared-master-token';
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
    return { ...actual, spawn };
  });
  vi.doMock('../src/infra/ipc.js', async () => {
    const actual = await vi.importActual<typeof import('../src/infra/ipc.js')>(
      '../src/infra/ipc.js',
    );
    return { ...actual, readOutput };
  });
  vi.doMock('../src/providers/factory.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/factory.js')
    >('../src/providers/factory.js');
    return { ...actual, resolveModelRuntimeCredentials };
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
  const { workspacePath } = getSessionPaths(
    'session-shared-transcripts',
    'default',
  );
  const transcriptDir = path.join(workspacePath, '.session-transcripts');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, 'other-user.jsonl'), 'secret');

  const { DATA_DIR } = await import('../src/config/config.js');
  const discordCacheRoot = path.join(DATA_DIR, 'discord-media-cache');
  const uploadedCacheRoot = path.join(DATA_DIR, 'uploaded-media-cache');
  const currentDiscordPath = path.join(
    discordCacheRoot,
    'current',
    'photo.png',
  );
  const currentUploadedPath = path.join(
    uploadedCacheRoot,
    'current',
    'brief.txt',
  );
  fs.mkdirSync(path.dirname(currentDiscordPath), { recursive: true });
  fs.mkdirSync(path.dirname(currentUploadedPath), { recursive: true });
  fs.writeFileSync(currentDiscordPath, 'current-discord-media');
  fs.writeFileSync(currentUploadedPath, 'current-uploaded-media');
  fs.writeFileSync(path.join(discordCacheRoot, 'other-user.png'), 'secret');
  fs.writeFileSync(path.join(uploadedCacheRoot, 'other-user.txt'), 'secret');

  const { resolveBehaviorAnomalyTrajectoryStoreDir } = await import(
    '../src/infra/behavior-anomaly-runtime.js'
  );
  const globalTrajectoryRoot = resolveBehaviorAnomalyTrajectoryStoreDir();
  fs.mkdirSync(globalTrajectoryRoot, { recursive: true });
  fs.writeFileSync(path.join(globalTrajectoryRoot, 'admin.jsonl'), 'secret');

  const { ContainerExecutor, resolveBrowserProfileHostDir } = await import(
    '../src/infra/container-runner.js'
  );
  const globalBrowserProfileRoot = resolveBrowserProfileHostDir();
  fs.mkdirSync(globalBrowserProfileRoot, { recursive: true });
  fs.writeFileSync(
    path.join(globalBrowserProfileRoot, 'admin-cookies.sqlite'),
    'secret',
  );
  const executor = new ContainerExecutor();
  await executor.exec({
    sessionId: 'session-shared-transcripts',
    messages: [{ role: 'user', content: 'read another transcript' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'web',
    isolateSessionTranscripts: true,
    media: [
      {
        path: '/discord-media-cache/current/photo.png',
        url: 'https://example.com/photo.png',
        originalUrl: 'https://example.com/photo.png',
        mimeType: 'image/png',
        sizeBytes: 21,
        filename: 'photo.png',
      },
      {
        path: currentUploadedPath,
        url: 'https://example.com/brief.txt',
        originalUrl: 'https://example.com/brief.txt',
        mimeType: 'text/plain',
        sizeBytes: 22,
        filename: 'brief.txt',
      },
    ],
  });

  const runArgs = spawn.mock.calls.find(
    (call) =>
      call[0] === 'docker' &&
      Array.isArray(call[1]) &&
      call[1].some((arg) =>
        String(arg).endsWith(':/workspace/.session-transcripts:ro'),
      ),
  )?.[1] as string[] | undefined;
  expect(runArgs).toBeDefined();
  const workspaceMountIndex = runArgs?.indexOf(
    `${workspacePath}:/workspace:rw`,
  );
  const maskMountIndex = runArgs?.findIndex((arg) =>
    arg.endsWith(':/workspace/.session-transcripts:ro'),
  );
  expect(maskMountIndex).toBeGreaterThan(workspaceMountIndex ?? -1);
  const maskMount = runArgs?.[maskMountIndex ?? -1] || '';
  const maskHostPath = maskMount.slice(
    0,
    -':/workspace/.session-transcripts:ro'.length,
  );
  expect(maskHostPath.startsWith(workspacePath)).toBe(false);
  expect(fs.readdirSync(maskHostPath)).toEqual([]);

  const discordMount =
    runArgs?.find((arg) => arg.endsWith(':/discord-media-cache:ro')) || '';
  const stagedDiscordRoot = discordMount.slice(
    0,
    -':/discord-media-cache:ro'.length,
  );
  expect(stagedDiscordRoot).not.toBe(discordCacheRoot);
  expect(
    fs.readFileSync(path.join(stagedDiscordRoot, 'current', 'photo.png'), 'utf8'),
  ).toBe('current-discord-media');
  expect(fs.existsSync(path.join(stagedDiscordRoot, 'other-user.png'))).toBe(
    false,
  );

  const uploadedMount =
    runArgs?.find((arg) => arg.endsWith(':/uploaded-media-cache:ro')) || '';
  const stagedUploadedRoot = uploadedMount.slice(
    0,
    -':/uploaded-media-cache:ro'.length,
  );
  expect(stagedUploadedRoot).not.toBe(uploadedCacheRoot);
  expect(
    fs.readFileSync(
      path.join(stagedUploadedRoot, 'current', 'brief.txt'),
      'utf8',
    ),
  ).toBe('current-uploaded-media');
  expect(fs.existsSync(path.join(stagedUploadedRoot, 'other-user.txt'))).toBe(
    false,
  );

  const browserMount =
    runArgs?.find((arg) => arg.endsWith(':/browser-profiles:rw')) || '';
  const isolatedBrowserProfileRoot = browserMount.slice(
    0,
    -':/browser-profiles:rw'.length,
  );
  expect(isolatedBrowserProfileRoot).not.toBe(globalBrowserProfileRoot);
  expect(fs.readdirSync(isolatedBrowserProfileRoot)).toEqual([]);

  const trajectoryMount =
    runArgs?.find((arg) => arg.endsWith(':/hybridclaw-trajectories:ro')) || '';
  const trajectoryMaskRoot = trajectoryMount.slice(
    0,
    -':/hybridclaw-trajectories:ro'.length,
  );
  expect(trajectoryMaskRoot).not.toBe(globalTrajectoryRoot);
  expect(fs.readdirSync(trajectoryMaskRoot)).toEqual([]);

  expect(runArgs).toContain('HYBRIDCLAW_GATEWAY_TOKEN=');
  expect(runArgs?.join('\n')).not.toContain('shared-master-token');
  const firstInput = JSON.parse(
    String(proc.stdin.write.mock.calls[0]?.[0] || '').trim(),
  ) as {
    gatewayApiToken?: string;
    media?: Array<{ path: string | null }>;
  };
  expect(firstInput.gatewayApiToken).toBeUndefined();
  expect(firstInput.media?.map((item) => item.path)).toEqual([
    '/discord-media-cache/current/photo.png',
    '/uploaded-media-cache/current/brief.txt',
  ]);

  await executor.exec({
    sessionId: 'session-shared-transcripts',
    messages: [{ role: 'user', content: 'next turn without attachments' }],
    chatbotId: 'bot-a',
    enableRag: false,
    model: 'gpt-5',
    agentId: 'default',
    channelId: 'web',
    isolateSessionTranscripts: true,
  });
  expect(fs.readdirSync(stagedDiscordRoot)).toEqual([]);
  expect(fs.readdirSync(stagedUploadedRoot)).toEqual([]);
  expect(
    spawn.mock.calls.filter(
      (call) =>
        call[0] === 'docker' &&
        Array.isArray(call[1]) &&
        call[1][0] === 'run' &&
        call[1].some((arg) =>
          String(arg).endsWith(':/workspace/.session-transcripts:ro'),
        ),
    ),
  ).toHaveLength(1);
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
  // Docker images bake their own node_modules; the hint must point at an
  // image rebuild, not the host-side bootstrap script.
  expect(output.error).toContain('npm run build:container');
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
