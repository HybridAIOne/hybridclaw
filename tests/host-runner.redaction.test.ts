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
  vi.unstubAllEnvs();
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

test('HostExecutor preserves user-visible result and error strings from agent output', async () => {
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

  expect(output.result).toBe(
    'Invited max.noller@hybridai.one and used OPENAI_API_KEY=sk-123...mnop.',
  );
  expect(output.error).toBe(
    'Could not notify stephan.noller@hybridai.one with Authorization: Bearer 123456...stuv',
  );
});

test('HostExecutor preserves user-visible streamed text and tool progress while redacting credentials', async () => {
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
  mockHostRuntimeReady();

  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const executor = new HostExecutor();
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

test('HostExecutor preserves user-visible approval details while redacting credentials', async () => {
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
  mockHostRuntimeReady();

  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const executor = new HostExecutor();
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

test('HostExecutor strips ambient credentials from host agent process env', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.stubEnv('OPENAI_API_KEY', 'openai-secret');
  vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-secret');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'aws-access-key');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-secret-key');
  vi.stubEnv('AWS_SESSION_TOKEN', 'aws-session-token');
  vi.stubEnv('GITHUB_TOKEN', 'github-token');
  vi.stubEnv('GH_TOKEN', 'gh-token');
  vi.stubEnv('CUSTOM_SERVICE_API_KEY', 'custom-service-key');
  vi.stubEnv('CUSTOM_PASSWORD', 'custom-password');
  vi.stubEnv('SSH_AUTH_SOCK', '/tmp/ssh-agent.sock');
  vi.stubEnv('BRAVE_API_KEY', 'brave-secret');
  vi.stubEnv('PERPLEXITY_API_KEY', 'perplexity-secret');
  vi.stubEnv('TAVILY_API_KEY', 'tavily-secret');
  vi.stubEnv('HYBRIDCLAW_TEST_VISIBLE', 'visible');
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
  mockHostRuntimeReady();

  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const executor = new HostExecutor();

  await executor.exec({
    sessionId: 'session-sanitized-env',
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
  expect(spawnEnv?.HYBRIDCLAW_AGENT_SANDBOX_MODE).toBe('host');
  expect(spawnEnv?.HYBRIDCLAW_TEST_VISIBLE).toBe('visible');
  expect(spawnEnv?.OPENAI_API_KEY).toBeUndefined();
  expect(spawnEnv?.ANTHROPIC_API_KEY).toBeUndefined();
  expect(spawnEnv?.AWS_ACCESS_KEY_ID).toBeUndefined();
  expect(spawnEnv?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(spawnEnv?.AWS_SESSION_TOKEN).toBeUndefined();
  expect(spawnEnv?.GITHUB_TOKEN).toBeUndefined();
  expect(spawnEnv?.GH_TOKEN).toBeUndefined();
  expect(spawnEnv?.CUSTOM_SERVICE_API_KEY).toBeUndefined();
  expect(spawnEnv?.CUSTOM_PASSWORD).toBeUndefined();
  expect(spawnEnv?.SSH_AUTH_SOCK).toBeUndefined();
  expect(spawnEnv?.BRAVE_API_KEY).toBeUndefined();
  expect(spawnEnv?.PERPLEXITY_API_KEY).toBeUndefined();
  expect(spawnEnv?.TAVILY_API_KEY).toBeUndefined();

  const firstInput = JSON.parse(
    String(proc.stdin.write.mock.calls[0]?.[0] || '').trim(),
  ) as { webSearch?: Record<string, unknown> };
  expect(firstInput.webSearch).toMatchObject({
    braveApiKey: 'brave-secret',
    perplexityApiKey: 'perplexity-secret',
    tavilyApiKey: 'tavily-secret',
  });
});

test('HostExecutor disables internal text streaming when no text callback is provided', async () => {
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
  mockHostRuntimeReady();

  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const executor = new HostExecutor();

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

test('HostExecutor does not apply the HybridAI token cap to remote OpenAI-compatible providers by default', async () => {
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
  mockHostRuntimeReady();

  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const executor = new HostExecutor();

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

test('HostExecutor uses discovered maxTokens for Anthropic OpenRouter models', async () => {
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
  mockHostRuntimeReady();

  const { HostExecutor } = await import('../src/infra/host-runner.js');
  const executor = new HostExecutor();

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

test('HostExecutor exposes the bundled agent-browser binary to host agent processes', async () => {
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
  const { resolveInstallRoot } = await import('../src/infra/install-root.js');
  const executor = new HostExecutor();

  await executor.exec({
    sessionId: 'session-agent-browser-bin',
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
  expect(spawnEnv?.AGENT_BROWSER_BIN).toBe(
    path.join(
      resolveInstallRoot(),
      'container',
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'agent-browser.cmd' : 'agent-browser',
    ),
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

test('HostExecutor forwards maxWallClockMs to the IPC output reader', async () => {
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
  const executor = new HostExecutor();

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

test('HostExecutor forwards disabled inactivity timeout to the IPC output reader', async () => {
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
  const executor = new HostExecutor();

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
