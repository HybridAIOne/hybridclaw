import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { decodeAuthenticatedInput } from '../container/shared/ipc-input-auth.js';
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

test('writeInput omits auth material from IPC files', async () => {
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
    ipcAuthSecret: 'secret-should-not-persist',
    gatewayApiToken: 'gateway-secret',
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
  };

  ensureSessionDirs('session-1');
  const authSecret = 'worker-secret';
  const filePath = writeInput('session-1', input, { authSecret });
  // The file is an authenticity envelope; verify it and read the body back.
  const decoded = decodeAuthenticatedInput(
    authSecret,
    fs.readFileSync(filePath, 'utf-8'),
  );
  expect(decoded.status).toBe('ok');
  if (decoded.status !== 'ok') throw new Error('expected authentic input');
  const written = JSON.parse(decoded.body) as Record<string, unknown>;

  // Credentials never reach the follow-up file: the per-worker secret, the
  // gateway token, and the runtime env are all delivered on stdin instead.
  expect(written.ipcAuthSecret).toBeUndefined();
  expect(written.gatewayApiToken).toBeUndefined();
  expect(written.runtimeEnv).toBeUndefined();
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
  expect(written.webSearch).toEqual({
    provider: 'auto',
    fallbackProviders: ['brave'],
    defaultCount: 5,
    cacheTtlMinutes: 5,
    searxngBaseUrl: '',
    tavilySearchDepth: 'advanced',
  });
  expect(input.apiKey).toBe('token_secret');
  expect(input.requestHeaders.Authorization).toBe('Bearer token_secret');
  expect(input.taskModels.compression.apiKey).toBe('or-secret');
  expect(input.webSearch.braveApiKey).toBe('brave-secret');
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

const INTERRUPTED_TOOL_HISTORY = [
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: {
          name: 'vision_analyze',
          arguments: '{"image_url":"/uploaded-media-cache/2026-09-26/1-a-Logo.png"}',
        },
      },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'call-1',
    content: 'Tool outcome unknown: the agent process received SIGTERM.',
    is_error: true,
  },
];
const INTERRUPTED = {
  status: 'error',
  result: null,
  toolsUsed: [],
  error: 'Interrupted by user.',
};

async function startInterruptedRead(terminalError?: () => string | null) {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-26T00:00:00Z'));
  vi.resetModules();
  const { ensureSessionDirs, readOutput } = await import('../src/infra/ipc.ts');
  ensureSessionDirs('session-1');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  let settled = false;
  const output = readOutput('session-1', 'request-1', null, {
    signal: controller.signal,
    maxWallClockMs: null,
    terminalError,
  }).finally(() => {
    settled = true;
  });
  return {
    output,
    isSettled: () => settled,
    outputPath: path.join(
      ipcDirOf(homeDir, 'session-1'),
      ipcOutputFileName('request-1'),
    ),
  };
}

test('an interrupted readOutput keeps only the tool history the stopped agent flushed', async () => {
  const { output, outputPath } = await startInterruptedRead();
  // The agent's SIGTERM handler writes its output just after the interrupt.
  setTimeout(() => {
    fs.writeFileSync(
      outputPath,
      JSON.stringify({
        status: 'error',
        result: 'late reply text',
        toolsUsed: ['vision_analyze'],
        error: 'Request interrupted: the agent process received SIGTERM.',
        sideEffects: {
          delegations: [{ action: 'delegate', prompt: 'summarize inbox' }],
        },
        toolHistory: INTERRUPTED_TOOL_HISTORY,
        toolHistoryForReplay: INTERRUPTED_TOOL_HISTORY,
      }),
    );
  }, 150);

  await vi.advanceTimersByTimeAsync(500);

  await expect(output).resolves.toEqual({
    ...INTERRUPTED,
    toolHistory: INTERRUPTED_TOOL_HISTORY,
    toolHistoryForReplay: INTERRUPTED_TOOL_HISTORY,
  });
  expect(fs.existsSync(outputPath)).toBe(false);
});

test('an interrupted readOutput waits at most the grace window for shutdown output', async () => {
  const { output, isSettled } = await startInterruptedRead();

  await vi.advanceTimersByTimeAsync(1_900);
  expect(isSettled()).toBe(false);
  await vi.advanceTimersByTimeAsync(400);

  await expect(output).resolves.toEqual(INTERRUPTED);
});

test('an interrupted readOutput stops waiting once the agent has exited', async () => {
  let exited = false;
  const { output, isSettled } = await startInterruptedRead(() =>
    exited ? 'Host agent process exited (signal SIGTERM)' : null,
  );
  setTimeout(() => {
    exited = true;
  }, 120);

  await vi.advanceTimersByTimeAsync(400);

  expect(isSettled()).toBe(true);
  await expect(output).resolves.toEqual(INTERRUPTED);
});
