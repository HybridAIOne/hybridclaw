import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock('node:child_process');
});

test('routes Anthropic claude-cli calls through `claude -p`', async () => {
  const originalSandboxMode = process.env.HYBRIDCLAW_AGENT_SANDBOX_MODE;
  process.env.HYBRIDCLAW_AGENT_SANDBOX_MODE = 'host';
  const spawnMock = vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    queueMicrotask(() => {
      child.stdout.write(
        `${JSON.stringify({
          type: 'result',
          session_id: 'session_123',
          result: 'cli response',
        })}\n`,
      );
      child.stdout.end();
      child.emit('close', 0);
    });

    return child;
  });

  vi.doMock('node:child_process', () => ({
    spawn: spawnMock,
  }));

  const { callAnthropicProvider } = await import(
    '../container/src/providers/anthropic.js'
  );

  const response = await callAnthropicProvider({
    provider: 'anthropic',
    providerMethod: 'claude-cli',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: '',
    model: 'anthropic/claude-sonnet-4-6',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 128,
    isLocal: false,
    contextWindow: undefined,
    thinkingFormat: undefined,
  });

  expect(spawnMock).toHaveBeenCalledWith(
    'claude',
    expect.arrayContaining([
      '-p',
      expect.any(String),
      '--verbose',
      '--output-format',
      'stream-json',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      'claude-sonnet-4-6',
    ]),
    expect.objectContaining({
      cwd: process.cwd(),
      env: expect.objectContaining({
        HOME: expect.any(String),
      }),
    }),
  );
  expect(spawnMock.mock.calls[0]?.[1]).not.toContain('--cwd');
  expect(response).toMatchObject({
    id: 'session_123',
    model: 'claude-sonnet-4-6',
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'cli response',
        },
        finish_reason: 'stop',
      },
    ],
  });
  if (originalSandboxMode == null) {
    delete process.env.HYBRIDCLAW_AGENT_SANDBOX_MODE;
  } else {
    process.env.HYBRIDCLAW_AGENT_SANDBOX_MODE = originalSandboxMode;
  }
});

test('uses the real host HOME for Anthropic claude-cli in host sandbox mode', async () => {
  const originalSandboxMode = process.env.HYBRIDCLAW_AGENT_SANDBOX_MODE;
  const originalHome = process.env.HOME;
  process.env.HYBRIDCLAW_AGENT_SANDBOX_MODE = 'host';
  process.env.HOME = '/tmp/hybridclaw-host-home';

  const spawnMock = vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    queueMicrotask(() => {
      child.stdout.write(
        `${JSON.stringify({
          type: 'result',
          session_id: 'session_host',
          result: 'host cli response',
        })}\n`,
      );
      child.stdout.end();
      child.emit('close', 0);
    });

    return child;
  });

  vi.doMock('node:child_process', () => ({
    spawn: spawnMock,
  }));

  try {
    const { callAnthropicProvider } = await import(
      '../container/src/providers/anthropic.js'
    );

    await callAnthropicProvider({
      provider: 'anthropic',
      providerMethod: 'claude-cli',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: '',
      model: 'anthropic/claude-sonnet-4-6',
      chatbotId: '',
      enableRag: false,
      requestHeaders: {},
      messages: [{ role: 'user', content: 'hello from host mode' }],
      tools: [],
      maxTokens: 128,
      isLocal: false,
      contextWindow: undefined,
      thinkingFormat: undefined,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          HOME: '/tmp/hybridclaw-host-home',
        }),
      }),
    );
  } finally {
    if (originalSandboxMode == null) {
      delete process.env.HYBRIDCLAW_AGENT_SANDBOX_MODE;
    } else {
      process.env.HYBRIDCLAW_AGENT_SANDBOX_MODE = originalSandboxMode;
    }
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test('rejects Anthropic claude-cli in container sandbox mode', async () => {
  const originalSandboxMode = process.env.HYBRIDCLAW_AGENT_SANDBOX_MODE;
  process.env.HYBRIDCLAW_AGENT_SANDBOX_MODE = 'container';

  try {
    const { callAnthropicProvider } = await import(
      '../container/src/providers/anthropic.js'
    );

    await expect(
      callAnthropicProvider({
        provider: 'anthropic',
        providerMethod: 'claude-cli',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: '',
        model: 'anthropic/claude-sonnet-4-6',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        messages: [{ role: 'user', content: 'hello from container mode' }],
        tools: [],
        maxTokens: 128,
        isLocal: false,
        contextWindow: undefined,
        thinkingFormat: undefined,
      }),
    ).rejects.toThrow('requires `--sandbox=host`');
  } finally {
    if (originalSandboxMode == null) {
      delete process.env.HYBRIDCLAW_AGENT_SANDBOX_MODE;
    } else {
      process.env.HYBRIDCLAW_AGENT_SANDBOX_MODE = originalSandboxMode;
    }
  }
});
