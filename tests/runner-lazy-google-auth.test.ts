import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const resolveGoogle = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('invalid_grant');
  }),
);
vi.mock('../src/auth/google-auth.js', () => ({
  resolveGoogleWorkspaceRuntimeEnv: resolveGoogle,
  getGoogleWorkspaceRuntimeEnvRecoveryHint: () => 'Google login required',
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() =>
      Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
        kill: vi.fn(),
        killed: false,
        exitCode: null,
      }),
    ),
  };
});
vi.mock('../src/infra/ipc.js', async (original) => ({
  ...(await original<typeof import('../src/infra/ipc.js')>()),
  readOutput: vi.fn(async () => ({
    status: 'success',
    result: 'Hi',
    toolsUsed: [],
  })),
}));
vi.mock('../src/providers/factory.js', async (original) => ({
  ...(await original<typeof import('../src/providers/factory.js')>()),
  resolveModelRuntimeCredentials: vi.fn(async () => ({
    provider: 'hybridai',
    apiKey: '',
    baseUrl: 'https://example.com',
    chatbotId: 'test-bot',
    enableRag: false,
    requestHeaders: {},
    agentId: 'default',
    isLocal: false,
    contextWindow: 128_000,
  })),
}));
vi.mock('../src/infra/host-runtime-setup.js', () => ({
  ensureHostRuntimeReady: vi.fn(() => ({
    command: process.execPath,
    args: ['/tmp/container/dist/index.js'],
  })),
}));
vi.mock('../src/config/config.js', async (original) => {
  const actual = await original<typeof import('../src/config/config.js')>();
  return {
    ...actual,
    CONTAINER_WARM_POOL: { ...actual.CONTAINER_WARM_POOL, enabled: false },
  };
});
const makeTemp = useTempDir('runner-lazy-google-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

test.each(['host', 'container'])(
  '%s greeting never refreshes Google credentials, including reused sessions',
  async (mode) => {
    vi.stubEnv('HOME', makeTemp());
    vi.stubEnv('HYBRIDCLAW_DATA_DIR', makeTemp());
    resolveGoogle.mockClear();
    const executor =
      mode === 'host'
        ? new (await import('../src/infra/host-runner.js')).HostExecutor()
        : new (
            await import('../src/infra/container-runner.js')
          ).ContainerExecutor();
    try {
      for (let turn = 0; turn < 2; turn++) {
        const output = await executor.exec({
          sessionId: 'test-greeting',
          messages: [{ role: 'user', content: 'Hi' }],
          chatbotId: 'test-bot',
          enableRag: false,
          model: 'gpt-5',
          agentId: 'default',
          channelId: 'tui',
        });
        expect(output.status).toBe('success');
        expect(output.result).toBe('Hi');
      }
      expect(resolveGoogle).not.toHaveBeenCalled();
    } finally {
      executor.stopAll();
    }
  },
);
