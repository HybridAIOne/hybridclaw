import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { ipcOutputFileName } from '../container/shared/ipc-output-files.js';

const ORIGINAL_HOME = process.env.HOME;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-ipc-'));
}

function ipcDirOf(homeDir: string, sessionId: string): string {
  return path.join(homeDir, '.hybridclaw', 'data', 'sessions', sessionId, 'ipc');
}

function writeReply(
  dir: string,
  requestId: string | undefined,
  output: Record<string, unknown>,
): void {
  fs.writeFileSync(
    path.join(dir, ipcOutputFileName(requestId)),
    JSON.stringify(output),
  );
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
    providerCredentials: {
      openai: {
        apiKey: 'openai-secret',
        baseUrl: 'https://api.openai.com/v1',
        imageModel: 'gpt-image-2',
      },
      gemini: {
        apiKey: 'gemini-secret',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
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
  expect(written.providerCredentials).toBeUndefined();
  expect(input.apiKey).toBe('token_secret');
  expect(input.requestHeaders.Authorization).toBe('Bearer token_secret');
  expect(input.taskModels.compression.apiKey).toBe('or-secret');
  expect(input.webSearch.braveApiKey).toBe('brave-secret');
  expect(input.providerCredentials.openai?.apiKey).toBe('openai-secret');
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

  const outputPromise = readOutput('session-1', 'request-1', 100, {
    activity,
  });

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

  setTimeout(() => {
    writeReply(ipcDirOf(homeDir, 'session-1'), 'request-1', {
      status: 'success',
      result: 'ok',
      toolsUsed: [],
    });
  }, 500);

  const outputPromise = readOutput('session-1', 'request-1', null, {
    maxWallClockMs: null,
  });

  // Output appears at 500ms; adaptive polling may need one capped 250ms cycle.
  await vi.advanceTimersByTimeAsync(750);

  await expect(outputPromise).resolves.toEqual(
    expect.objectContaining({
      status: 'success',
      result: 'ok',
    }),
  );
});

test('readOutput outlives a silence longer than the inactivity window while activity is reported', async () => {
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
  const heartbeat = setInterval(() => activity.notify(), 50);
  setTimeout(() => {
    clearInterval(heartbeat);
    writeReply(ipcDirOf(homeDir, 'session-1'), 'request-1', {
      status: 'success',
      result: 'ok',
      toolsUsed: [],
    });
  }, 300);

  const outputPromise = readOutput('session-1', 'request-1', 100, {
    activity,
  });
  await vi.advanceTimersByTimeAsync(360);

  await expect(outputPromise).resolves.toEqual(
    expect.objectContaining({ status: 'success', result: 'ok' }),
  );
});

const LATE_INTERRUPTED_REPLY = {
  status: 'error',
  result: null,
  toolsUsed: [],
  error:
    'Request interrupted: the agent process received SIGTERM before producing a final response.',
  sideEffects: {
    delegations: [{ action: 'delegate', mode: 'single', prompt: 'stale' }],
  },
};

test.each([
  { when: 'while it is still waiting', steps: ['late', 'wait', 'own'] },
  { when: 'after its own reply landed', steps: ['own', 'late'] },
] as const)('readOutput ignores an earlier request that answers late $when', async ({
  steps,
}) => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-11T00:00:00Z'));
  vi.resetModules();

  const { cleanupIpc, ensureSessionDirs, readOutput } = await import(
    '../src/infra/ipc.ts'
  );

  ensureSessionDirs('session-1');
  cleanupIpc('session-1');
  const dir = ipcDirOf(homeDir, 'session-1');
  let settled = false;
  const outputPromise = readOutput('session-1', 'request-b', 1_000).finally(
    () => {
      settled = true;
    },
  );

  for (const step of steps) {
    if (step === 'late') writeReply(dir, 'request-a', LATE_INTERRUPTED_REPLY);
    if (step === 'own') {
      writeReply(dir, 'request-b', {
        status: 'success',
        result: 'reply b',
        toolsUsed: [],
      });
    }
    if (step === 'wait') {
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(false);
    }
  }
  await vi.advanceTimersByTimeAsync(300);

  const output = await outputPromise;
  expect(output).toEqual({
    status: 'success',
    result: 'reply b',
    toolsUsed: [],
  });
});

test('cleanupIpc removes request files and late replies but keeps other IPC files', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { cleanupIpc, ensureSessionDirs } = await import('../src/infra/ipc.ts');

  ensureSessionDirs('session-1');
  const dir = ipcDirOf(homeDir, 'session-1');
  const kept = ['health-input.json', 'health-output.json', 'mlx-0f.request'];
  for (const file of [
    'input.json',
    'history.json',
    'output.json',
    ipcOutputFileName('request-a'),
    ...kept,
  ]) {
    fs.writeFileSync(path.join(dir, file), '{}');
  }

  cleanupIpc('session-1');

  expect(fs.readdirSync(dir).sort()).toEqual([...kept].sort());
});

// compat: remove after v0.34 — agent images built before request ids reply
// in output.json.
test('readOutput accepts the reply of an agent image that predates request ids', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-11T00:00:00Z'));
  vi.resetModules();

  const { ensureSessionDirs, readOutput } = await import('../src/infra/ipc.ts');

  ensureSessionDirs('session-1');
  writeReply(ipcDirOf(homeDir, 'session-1'), undefined, {
    status: 'success',
    result: 'legacy reply',
    toolsUsed: [],
  });

  const outputPromise = readOutput('session-1', 'request-1', 1_000);
  await vi.advanceTimersByTimeAsync(50);

  await expect(outputPromise).resolves.toEqual(
    expect.objectContaining({ status: 'success', result: 'legacy reply' }),
  );
});
