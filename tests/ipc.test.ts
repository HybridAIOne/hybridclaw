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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
});

test('writeInput omits auth material from IPC files when requested', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { ensureSessionDirs, writeInput } = await import('../src/infra/ipc.ts');
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
    runtimeEnv: {
      GOG_ACCESS_TOKEN: 'short-lived-access-token',
      GOOGLE_WORKSPACE_CLI_TOKEN: 'short-lived-access-token',
      GOG_ACCOUNT: 'user@example.com',
    },
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
    webSearch: {
      provider: 'auto' as const,
      fallbackProviders: ['brave' as const],
      defaultCount: 5,
      cacheTtlMinutes: 5,
      searxngBaseUrl: '',
      tavilySearchDepth: 'advanced' as const,
      braveApiKey: 'brave-secret',
      perplexityApiKey: 'perplexity-secret',
      tavilyApiKey: 'tavily-secret',
    },
    contentTools: {
      imageGeneration: {
        apiKey: 'fal-secret',
        baseUrl: 'https://fal.run',
        defaultModel: 'fal-ai/flux-2/klein/9b',
        defaultCount: 1,
        defaultAspectRatio: '1:1' as const,
        defaultResolution: '1K' as const,
        defaultOutputFormat: 'png' as const,
        timeoutMs: 120000,
      },
      speech: {
        apiKey: 'openai-tts-secret',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini-tts',
        defaultVoice: 'alloy',
        defaultOutputFormat: 'mp3' as const,
        defaultSpeed: 1,
        maxChars: 4000,
        timeoutMs: 60000,
      },
      transcription: {
        apiKey: 'openai-stt-secret',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'whisper-1',
        defaultLanguage: '',
        defaultPrompt: '',
        maxBytes: 25000000,
        timeoutMs: 120000,
      },
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
  expect(written.runtimeEnv).toEqual({
    GOG_ACCESS_TOKEN: 'short-lived-access-token',
    GOOGLE_WORKSPACE_CLI_TOKEN: 'short-lived-access-token',
    GOG_ACCOUNT: 'user@example.com',
  });
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
  expect(written.webSearch).toEqual({
    provider: 'auto',
    fallbackProviders: ['brave'],
    defaultCount: 5,
    cacheTtlMinutes: 5,
    searxngBaseUrl: '',
    tavilySearchDepth: 'advanced',
  });
  expect(written.contentTools).toEqual({
    imageGeneration: {
      apiKey: '',
      baseUrl: 'https://fal.run',
      defaultModel: 'fal-ai/flux-2/klein/9b',
      defaultCount: 1,
      defaultAspectRatio: '1:1',
      defaultResolution: '1K',
      defaultOutputFormat: 'png',
      timeoutMs: 120000,
    },
    speech: {
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o-mini-tts',
      defaultVoice: 'alloy',
      defaultOutputFormat: 'mp3',
      defaultSpeed: 1,
      maxChars: 4000,
      timeoutMs: 60000,
    },
    transcription: {
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'whisper-1',
      defaultLanguage: '',
      defaultPrompt: '',
      maxBytes: 25000000,
      timeoutMs: 120000,
    },
  });
  expect(input.apiKey).toBe('token_secret');
  expect(input.requestHeaders.Authorization).toBe('Bearer token_secret');
  expect(input.taskModels.compression.apiKey).toBe('or-secret');
  expect(input.webSearch.braveApiKey).toBe('brave-secret');
  expect(input.contentTools.imageGeneration.apiKey).toBe('fal-secret');
});

test('readOutput enforces a hard deadline despite repeated activity', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-11T00:00:00Z'));
  vi.resetModules();

  const { ensureSessionDirs, createActivityTracker, readOutput } = await import(
    '../src/infra/ipc.ts'
  );

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

  const { ensureSessionDirs, readOutput } = await import('../src/infra/ipc.ts');

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
