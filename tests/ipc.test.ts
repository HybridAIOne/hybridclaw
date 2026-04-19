import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-ipc-'));
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function importIpc(homeDir: string) {
  vi.doMock('../src/agents/agent-registry.js', () => ({
    resolveAgentWorkspaceId: (agentId: string) => agentId,
  }));
  vi.doMock('../src/config/config.js', () => ({
    CONTAINER_MAX_OUTPUT_SIZE: 1024 * 1024,
    DATA_DIR: path.join(homeDir, '.hybridclaw', 'data'),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      debug: vi.fn(),
    },
  }));
  return import('../src/infra/ipc.ts');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('../src/agents/agent-registry.js');
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
});

test('writeInput omits auth material from IPC files when requested', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { ensureSessionDirs, writeInput } = await importIpc(homeDir);
  const input = {
    sessionId: 'session-1',
    messages: [{ role: 'user', content: 'hello' }],
    chatbotId: '',
    enableRag: false,
    apiKey: 'token_secret',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    provider: 'openai-codex' as const,
    requestHeaders: {
      Authorization: 'Bearer token_secret',
      'Chatgpt-Account-Id': 'acct_123',
      'OpenAI-Beta': 'responses=experimental',
    },
    model: 'openai-codex/gpt-5-codex',
    channelId: 'channel-1',
    taskModels: {
      compression: {
        provider: 'openrouter' as const,
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'or-secret',
        requestHeaders: {
          'HTTP-Referer': 'https://example.com',
        },
        model: 'openrouter/openai/gpt-5-nano',
        chatbotId: '',
        maxTokens: 123,
      },
    },
    modelRouting: {
      routes: [
        {
          provider: 'openrouter' as const,
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'route-secret',
          requestHeaders: {
            Authorization: 'Bearer route-secret',
          },
          model: 'openrouter/openai/gpt-5',
          chatbotId: '',
          enableRag: false,
          maxTokens: 456,
          credentialPool: {
            rotation: 'least_used' as const,
            entries: [
              {
                id: 'pool-1',
                label: 'primary',
                apiKey: 'pool-secret-1',
              },
              {
                id: 'pool-2',
                label: 'secondary',
                apiKey: 'pool-secret-2',
              },
            ],
          },
        },
      ],
      adaptiveContextTierDowngradeOn429: true,
    },
  };

  ensureSessionDirs('session-1');
  const filePath = writeInput('session-1', input, { omitApiKey: true });
  const written = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
    string,
    unknown
  >;

  expect(written.apiKey).toBe('');
  expect(written.requestHeaders).toEqual({});
  expect(written.taskModels).toEqual({
    compression: {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: '',
      requestHeaders: {},
      model: 'openrouter/openai/gpt-5-nano',
      chatbotId: '',
      maxTokens: 123,
    },
  });
  expect(written.modelRouting).toEqual({
    routes: [
      {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
        requestHeaders: {},
        model: 'openrouter/openai/gpt-5',
        chatbotId: '',
        enableRag: false,
        maxTokens: 456,
        credentialPool: {
          rotation: 'least_used',
          entries: [
            {
              id: 'pool-1',
              label: 'primary',
              apiKey: '',
            },
            {
              id: 'pool-2',
              label: 'secondary',
              apiKey: '',
            },
          ],
        },
      },
    ],
    adaptiveContextTierDowngradeOn429: true,
  });
  expect(input.apiKey).toBe('token_secret');
  expect(input.requestHeaders.Authorization).toBe('Bearer token_secret');
  expect(input.taskModels.compression.apiKey).toBe('or-secret');
  expect(input.modelRouting.routes[0].apiKey).toBe('route-secret');
  expect(input.modelRouting.routes[0].credentialPool?.entries[0].apiKey).toBe(
    'pool-secret-1',
  );
});

test('readOutput enforces a hard deadline despite repeated activity', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-11T00:00:00Z'));
  vi.resetModules();

  const { ensureSessionDirs, createActivityTracker, readOutput } =
    await importIpc(homeDir);

  ensureSessionDirs('session-1');
  const activity = createActivityTracker();
  const interval = setInterval(() => activity.notify(), 50);

  const outputPromise = readOutput('session-1', 100, { activity });

  await vi.advanceTimersByTimeAsync(400);
  clearInterval(interval);

  await expect(outputPromise).resolves.toEqual(
    expect.objectContaining({
      status: 'error',
      error:
        'Timeout waiting for agent output after 400ms total (100ms inactivity window)',
    }),
  );
});

test('readOutput does not time out when inactivity and wall-clock timeouts are disabled', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-11T00:00:00Z'));
  vi.resetModules();

  const { ensureSessionDirs, readOutput } = await importIpc(homeDir);

  ensureSessionDirs('session-1');
  const outputPath = path.join(
    homeDir,
    '.hybridclaw',
    'data',
    'sessions',
    'session-1',
    'ipc',
    'output.json',
  );

  setTimeout(() => {
    fs.writeFileSync(
      outputPath,
      JSON.stringify({
        status: 'success',
        result: 'ok',
        toolsUsed: [],
      }),
    );
  }, 500);

  const outputPromise = readOutput('session-1', null, {
    maxWallClockMs: null,
  });

  await vi.advanceTimersByTimeAsync(500);

  await expect(outputPromise).resolves.toEqual(
    expect.objectContaining({
      status: 'success',
      result: 'ok',
    }),
  );
});
