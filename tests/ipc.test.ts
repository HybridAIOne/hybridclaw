import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_WORKSPACES_DIR = process.env.HYBRIDCLAW_WORKSPACES_DIR;

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
  restoreEnvVar('HYBRIDCLAW_WORKSPACES_DIR', ORIGINAL_WORKSPACES_DIR);
});

test('agentWorkspaceDir uses HYBRIDCLAW_WORKSPACES_DIR and moves the legacy workspace once', async () => {
  const homeDir = makeTempHome();
  const workspacesDir = path.join(homeDir, 'workspaces');
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_WORKSPACES_DIR = workspacesDir;
  vi.resetModules();

  const { DATA_DIR } = await import('../src/config/config.ts');
  const legacyWorkspace = path.join(DATA_DIR, 'agents', 'main', 'workspace');
  fs.mkdirSync(legacyWorkspace, { recursive: true });
  fs.writeFileSync(path.join(legacyWorkspace, 'notes.md'), 'kept', 'utf-8');

  const { agentWorkspaceDir, ensureAgentDirs } = await import(
    '../src/infra/ipc.ts'
  );
  const target = path.join(workspacesDir, 'main');
  expect(agentWorkspaceDir('main')).toBe(target);

  ensureAgentDirs('main');

  expect(fs.readFileSync(path.join(target, 'notes.md'), 'utf-8')).toBe('kept');
  expect(fs.existsSync(legacyWorkspace)).toBe(false);

  // A second call is a no-op and never touches an existing target.
  fs.mkdirSync(legacyWorkspace, { recursive: true });
  fs.writeFileSync(path.join(legacyWorkspace, 'stale.md'), 'stale', 'utf-8');
  ensureAgentDirs('main');
  expect(fs.existsSync(path.join(target, 'stale.md'))).toBe(false);
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
  const outputPath = path.join(
    homeDir,
    '.hybridclaw',
    'data',
    'sessions',
    'session-1',
    'ipc',
    'output.json',
  );
  const activity = createActivityTracker();
  const heartbeat = setInterval(() => activity.notify(), 50);
  setTimeout(() => {
    clearInterval(heartbeat);
    fs.writeFileSync(
      outputPath,
      JSON.stringify({ status: 'success', result: 'ok', toolsUsed: [] }),
    );
  }, 300);

  const outputPromise = readOutput('session-1', 100, { activity });
  await vi.advanceTimersByTimeAsync(360);

  await expect(outputPromise).resolves.toEqual(
    expect.objectContaining({ status: 'success', result: 'ok' }),
  );
});

test('migrateLegacyAgentWorkspace copies across filesystems when rename reports EXDEV', async () => {
  const homeDir = makeTempHome();
  const workspacesDir = path.join(homeDir, 'workspaces');
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_WORKSPACES_DIR = workspacesDir;
  vi.resetModules();

  const { DATA_DIR } = await import('../src/config/config.ts');
  const legacyWorkspace = path.join(DATA_DIR, 'agents', 'main', 'workspace');
  fs.mkdirSync(path.join(legacyWorkspace, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(legacyWorkspace, 'memory', 'a.md'), 'kept', 'utf-8');

  const realRename = fs.renameSync;
  const target = path.join(workspacesDir, 'main');
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(from) === legacyWorkspace && String(to) === target) {
      throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' });
    }
    return realRename(from, to);
  });

  const { ensureAgentDirs } = await import('../src/infra/ipc.ts');
  ensureAgentDirs('main');

  expect(fs.readFileSync(path.join(target, 'memory', 'a.md'), 'utf-8')).toBe('kept');
  expect(fs.existsSync(legacyWorkspace)).toBe(false);
  expect(fs.existsSync(`${target}.migrating`)).toBe(false);
});

test('a failed workspace move throws and never leaves an empty target behind', async () => {
  const homeDir = makeTempHome();
  const workspacesDir = path.join(homeDir, 'workspaces');
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_WORKSPACES_DIR = workspacesDir;
  vi.resetModules();

  const { DATA_DIR } = await import('../src/config/config.ts');
  const legacyWorkspace = path.join(DATA_DIR, 'agents', 'main', 'workspace');
  fs.mkdirSync(legacyWorkspace, { recursive: true });
  fs.writeFileSync(path.join(legacyWorkspace, 'notes.md'), 'kept', 'utf-8');

  vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  });

  const { ensureAgentDirs } = await import('../src/infra/ipc.ts');
  const target = path.join(workspacesDir, 'main');
  expect(() => ensureAgentDirs('main')).toThrow(/Failed to move agent workspace/);
  expect(fs.existsSync(target)).toBe(false);
  expect(fs.readFileSync(path.join(legacyWorkspace, 'notes.md'), 'utf-8')).toBe('kept');

  // Once the cause is fixed, the next boot migrates normally.
  vi.restoreAllMocks();
  ensureAgentDirs('main');
  expect(fs.readFileSync(path.join(target, 'notes.md'), 'utf-8')).toBe('kept');
});
