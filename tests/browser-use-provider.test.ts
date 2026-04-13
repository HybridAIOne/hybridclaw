import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

type MockState = {
  browserCreateResult: Record<string, unknown>;
  browserCreateCalls: Record<string, unknown>[];
  browserStopCalls: string[];
  browserStopResult: Record<string, unknown>;
  profileCreateCalls: Record<string, unknown>[];
  profileGetCalls: string[];
  profileListCalls: Record<string, unknown>[];
  profileCreateResult: Record<string, unknown>;
  profileListItems: Record<string, unknown>[];
  workspaceCreateCalls: Record<string, unknown>[];
  workspaceCreateResult: Record<string, unknown>;
  workspaceGetCalls: string[];
  workspaceUploadCalls: Array<{
    workspaceId: string;
    filePath: string;
    options: Record<string, unknown>;
  }>;
  workspaceDownloadCalls: Array<{
    workspaceId: string;
    options: Record<string, unknown>;
  }>;
  sessionGetCalls: string[];
  sessionGetResult: Record<string, unknown> | null;
  sessionStopCalls: Array<{ sessionId: string; body: Record<string, unknown> }>;
  sessionStopResult: Record<string, unknown>;
  sessionWaitForRecordingCalls: string[];
  sessionWaitForRecordingResult: string[];
  runCalls: Array<{ task: string; options: Record<string, unknown> }>;
  runMessages: Record<string, unknown>[];
  runResult: Record<string, unknown>;
};

let mockState: MockState;
let tempRoot = '';

function resetMockState(): void {
  mockState = {
    browserCreateResult: {
      id: 'browser-1',
      status: 'active',
      cdpUrl: 'wss://browser-use.example/cdp',
      liveUrl: 'https://browser-use.example/live/browser-1',
      timeoutAt: '2026-04-13T10:00:00.000Z',
    },
    browserCreateCalls: [],
    browserStopCalls: [],
    browserStopResult: {
      id: 'browser-1',
      status: 'stopped',
      recordingUrl: null,
    },
    profileCreateCalls: [],
    profileGetCalls: [],
    profileListCalls: [],
    profileCreateResult: {
      id: 'profile-created',
      name: 'Saved profile',
      userId: 'user-1',
      createdAt: '2026-04-13T09:00:00.000Z',
      updatedAt: '2026-04-13T09:00:00.000Z',
    },
    profileListItems: [],
    workspaceCreateCalls: [],
    workspaceCreateResult: {
      id: 'workspace-1',
      name: 'HybridClaw session',
      createdAt: '2026-04-13T09:00:00.000Z',
      updatedAt: '2026-04-13T09:00:00.000Z',
    },
    workspaceGetCalls: [],
    workspaceUploadCalls: [],
    workspaceDownloadCalls: [],
    sessionGetCalls: [],
    sessionGetResult: null,
    sessionStopCalls: [],
    sessionStopResult: {
      id: 'session-1',
      status: 'stopped',
      recordingUrls: [],
    },
    sessionWaitForRecordingCalls: [],
    sessionWaitForRecordingResult: [],
    runCalls: [],
    runMessages: [],
    runResult: {
      id: 'session-1',
      status: 'idle',
      output: { ok: true },
      stepCount: 2,
      lastStepSummary: 'Finished',
      isTaskSuccessful: true,
      liveUrl: 'https://browser-use.example/live/session-1',
      recordingUrls: [],
      profileId: 'profile-created',
      workspaceId: 'workspace-1',
      llmCostUsd: '0.10',
      proxyCostUsd: '0.01',
      browserCostUsd: '0.02',
      totalCostUsd: '0.13',
      totalInputTokens: 120,
      totalOutputTokens: 30,
      screenshotUrl: 'https://browser-use.example/screens/session-1.png',
    },
  };
}

vi.mock('browser-use-sdk/v3', () => {
  class BrowserUse {
    browsers = {
      create: vi.fn(async (body: Record<string, unknown> = {}) => {
        mockState.browserCreateCalls.push({ ...body });
        return structuredClone(mockState.browserCreateResult);
      }),
      stop: vi.fn(async (sessionId: string) => {
        mockState.browserStopCalls.push(sessionId);
        return structuredClone(mockState.browserStopResult);
      }),
    };

    profiles = {
      create: vi.fn(async (body: Record<string, unknown> = {}) => {
        mockState.profileCreateCalls.push({ ...body });
        return structuredClone(mockState.profileCreateResult);
      }),
      get: vi.fn(async (profileId: string) => {
        mockState.profileGetCalls.push(profileId);
        return {
          ...structuredClone(mockState.profileCreateResult),
          id: profileId,
        };
      }),
      list: vi.fn(async (params: Record<string, unknown> = {}) => {
        mockState.profileListCalls.push({ ...params });
        return {
          items: structuredClone(mockState.profileListItems),
          totalItems: mockState.profileListItems.length,
          pageNumber: 1,
          pageSize: 100,
        };
      }),
    };

    workspaces = {
      create: vi.fn(async (body: Record<string, unknown> = {}) => {
        mockState.workspaceCreateCalls.push({ ...body });
        return structuredClone(mockState.workspaceCreateResult);
      }),
      get: vi.fn(async (workspaceId: string) => {
        mockState.workspaceGetCalls.push(workspaceId);
        return {
          ...structuredClone(mockState.workspaceCreateResult),
          id: workspaceId,
        };
      }),
      upload: vi.fn(
        async (
          workspaceId: string,
          filePath: string,
          options: Record<string, unknown> = {},
        ) => {
          mockState.workspaceUploadCalls.push({
            workspaceId,
            filePath,
            options: { ...options },
          });
          return [filePath];
        },
      ),
      downloadAll: vi.fn(
        async (workspaceId: string, options: Record<string, unknown> = {}) => {
          mockState.workspaceDownloadCalls.push({
            workspaceId,
            options: { ...options },
          });
          const outDir = String(options.to || '');
          if (outDir) {
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(path.join(outDir, 'downloaded.json'), '{}');
          }
          return [path.join(outDir, 'downloaded.json')];
        },
      ),
    };

    sessions = {
      get: vi.fn(async (sessionId: string) => {
        mockState.sessionGetCalls.push(sessionId);
        if (mockState.sessionGetResult) {
          return structuredClone(mockState.sessionGetResult);
        }
        return {
          id: sessionId,
          status: 'stopped',
        };
      }),
      stop: vi.fn(
        async (sessionId: string, body: Record<string, unknown> = {}) => {
          mockState.sessionStopCalls.push({ sessionId, body: { ...body } });
          return structuredClone(mockState.sessionStopResult);
        },
      ),
      waitForRecording: vi.fn(async (sessionId: string) => {
        mockState.sessionWaitForRecordingCalls.push(sessionId);
        return [...mockState.sessionWaitForRecordingResult];
      }),
    };

    run(task: string, options: Record<string, unknown> = {}) {
      mockState.runCalls.push({ task, options: { ...options } });
      const result = structuredClone(mockState.runResult);
      const messages = structuredClone(mockState.runMessages) as Array<
        Record<string, unknown>
      >;
      const run = Promise.resolve(result) as Promise<typeof result> & {
        sessionId: string;
        result: typeof result;
        [Symbol.asyncIterator](): AsyncGenerator<
          Record<string, unknown>,
          void,
          unknown
        >;
      };
      run.sessionId = String(result.id || '');
      run.result = result;
      run[Symbol.asyncIterator] = async function* () {
        for (const message of messages) {
          yield message;
        }
      };
      return run;
    }
  }

  return {
    BrowserUse,
  };
});

async function importFreshProvider() {
  vi.resetModules();
  return await import('../container/src/browser-use-provider.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetMockState();
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
});

test('ensureCdpSession creates one cloud browser and reuses it for the same HybridClaw session', async () => {
  resetMockState();
  vi.stubEnv('BROWSER_CLOUD_PROVIDER', 'browser-use');
  vi.stubEnv('BROWSER_USE_API_KEY', 'bu-test-key');
  vi.stubEnv('BROWSER_USE_DEFAULT_PROXY_COUNTRY', 'us');

  const { browserUseProvider } = await importFreshProvider();
  const profile = await browserUseProvider.createProfile({
    localSessionId: 'session-a',
    name: 'Authenticated profile',
  });
  expect(profile.profile.id).toBe('profile-created');

  const first = await browserUseProvider.ensureCdpSession({
    localSessionId: 'session-a',
  });
  const second = await browserUseProvider.ensureCdpSession({
    localSessionId: 'session-a',
  });

  expect(first.cdpUrl).toBe('wss://browser-use.example/cdp');
  expect(second.id).toBe(first.id);
  expect(mockState.browserCreateCalls).toHaveLength(1);
  expect(mockState.browserCreateCalls[0]).toMatchObject({
    profileId: 'profile-created',
    proxyCountryCode: 'us',
    timeout: 30,
    enableRecording: false,
  });
});

test('runAgentTask syncs artifacts, streams progress, and downloads the recording', async () => {
  resetMockState();
  vi.stubEnv('BROWSER_CLOUD_PROVIDER', 'browser-use');
  vi.stubEnv('BROWSER_USE_API_KEY', 'bu-test-key');
  vi.stubEnv('BROWSER_USE_ENABLE_RECORDING', 'true');

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-browser-use-'));
  fs.writeFileSync(path.join(tempRoot, 'input.txt'), 'hello world', 'utf-8');
  fs.writeFileSync(path.join(tempRoot, 'stale.txt'), 'stale data', 'utf-8');

  mockState.workspaceCreateResult = {
    id: 'workspace-123',
    name: 'Workspace 123',
    createdAt: '2026-04-13T09:00:00.000Z',
    updatedAt: '2026-04-13T09:00:00.000Z',
  };
  mockState.runResult = {
    id: 'session-123',
    status: 'idle',
    output: { title: 'Example' },
    stepCount: 3,
    lastStepSummary: 'Completed extraction',
    isTaskSuccessful: true,
    liveUrl: 'https://browser-use.example/live/session-123',
    recordingUrls: [],
    profileId: 'profile-created',
    workspaceId: 'workspace-123',
    llmCostUsd: '0.12',
    proxyCostUsd: '0.02',
    browserCostUsd: '0.03',
    totalCostUsd: '0.17',
    totalInputTokens: 345,
    totalOutputTokens: 67,
    screenshotUrl: 'https://browser-use.example/screens/session-123.png',
  };
  mockState.runMessages = [
    {
      id: 'msg-1',
      sessionId: 'session-123',
      role: 'ai',
      data: 'Opening example.com',
      type: 'planning',
      summary: 'Opening example.com',
      hidden: false,
      createdAt: '2026-04-13T09:01:00.000Z',
    },
    {
      id: 'msg-2',
      sessionId: 'session-123',
      role: 'ai',
      data: 'Extracting fields',
      type: 'browser_action',
      summary: 'Extracting fields',
      hidden: false,
      createdAt: '2026-04-13T09:01:05.000Z',
    },
  ];
  mockState.sessionWaitForRecordingResult = [
    'https://browser-use.example/recordings/session-123.mp4',
  ];

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
  );

  const progress = vi.fn();
  const { browserUseProvider } = await importFreshProvider();
  const result = await browserUseProvider.runAgentTask({
    localSessionId: 'session-b',
    task: 'Extract the page title and return it as structured JSON.',
    outputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
      },
    },
    artifactPaths: ['input.txt'],
    artifactRoot: tempRoot,
    progress,
  });

  expect(mockState.workspaceCreateCalls).toHaveLength(1);
  expect(mockState.workspaceUploadCalls).toHaveLength(1);
  expect(mockState.workspaceUploadCalls[0]).toMatchObject({
    workspaceId: 'workspace-123',
    filePath: path.join(tempRoot, 'input.txt'),
  });
  expect(mockState.runCalls[0]).toMatchObject({
    task: 'Extract the page title and return it as structured JSON.',
  });
  expect(mockState.runCalls[0]?.options).toMatchObject({
    workspaceId: 'workspace-123',
    outputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
      },
    },
    enableRecording: true,
    cacheScript: true,
    autoHeal: true,
    maxCostUsd: 1,
  });
  expect(progress).toHaveBeenCalledWith(
    'Opening example.com',
    expect.objectContaining({ id: 'msg-1' }),
  );
  expect(progress).toHaveBeenCalledWith(
    'Extracting fields',
    expect.objectContaining({ id: 'msg-2' }),
  );
  expect(mockState.workspaceDownloadCalls).toHaveLength(1);
  expect(mockState.workspaceDownloadCalls[0]).toMatchObject({
    workspaceId: 'workspace-123',
    options: {
      to: path.join(
        tempRoot,
        'browser-use-workspaces',
        'session-b',
        'session-123',
      ),
    },
  });
  expect(mockState.sessionWaitForRecordingCalls).toEqual(['session-123']);
  expect(result.totalCostUsd).toBe('0.17');
  expect(result.recordingPaths).toHaveLength(1);
  expect(result.workspaceArtifactPaths).toEqual([
    path.join(
      tempRoot,
      'browser-use-workspaces',
      'session-b',
      'session-123',
      'downloaded.json',
    ),
  ]);
  expect(fs.existsSync(result.recordingPaths[0] || '')).toBe(true);
  expect(
    browserUseProvider.getLatestRecordingArtifacts('session-b'),
  ).toMatchObject([
    {
      path: result.recordingPaths[0],
      mimeType: 'video/mp4',
    },
  ]);
});

test('closeLocalSession stops tracked cloud sessions and clears tracked ids', async () => {
  resetMockState();
  vi.stubEnv('BROWSER_CLOUD_PROVIDER', 'browser-use');
  vi.stubEnv('BROWSER_USE_API_KEY', 'bu-test-key');

  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-close-'),
  );

  const { browserUseProvider } = await importFreshProvider();
  await browserUseProvider.ensureCdpSession({
    localSessionId: 'session-c',
  });

  expect(browserUseProvider.getTrackedSessionIds()).toEqual(['session-c']);

  await browserUseProvider.closeLocalSession('session-c', tempRoot);

  expect(mockState.browserStopCalls).toEqual(['browser-1']);
  expect(browserUseProvider.getTrackedSessionIds()).toEqual([]);
});
