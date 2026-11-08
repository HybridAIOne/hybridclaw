import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import type { ContainerOutput } from '../src/types/container.js';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const { runAgent, stop } = vi.hoisted(() => ({
  runAgent:
    vi.fn<(request: { sessionId: string }) => Promise<ContainerOutput>>(),
  stop: vi.fn(async (_session: string) => true),
}));
vi.mock('../src/agent/agent.js', () => ({ runAgent }));
vi.mock('../src/agent/executor.js', async (original) => ({
  ...(await original<typeof import('../src/agent/executor.js')>()),
  stopSessionExecution: stop,
}));
const temp = useTempDir('gateway-chat-creation-');
useCleanMocks({
  cleanup: async () => {
    await cleanupGatewayRuntime();
    runAgent.mockReset();
    stop.mockClear();
  },
  resetModules: true,
  unstubAllEnvs: true,
});
const success: ContainerOutput = {
  status: 'success',
  result: 'Fixture reply.',
  toolsUsed: [],
};

test.each([
  { initial: 'canonical', target: 'key' },
  { initial: 'canonical', target: 'stored ID' },
  { initial: 'canonical', target: 'release' },
  { initial: 'legacy', target: 'key' },
  { initial: 'legacy', target: 'stored ID' },
  { initial: 'legacy', target: 'release' },
] as const)(
  'a cold $initial chat holds its stored queue for $target',
  async ({ initial, target }) => {
    vi.stubEnv('HOME', temp());
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    vi.stubEnv('HYBRIDAI_API_KEY', '');
    vi.stubEnv('HYBRIDAI_CHATBOT_ID', '');
    const db = await import('../src/memory/db.js');
    const { buildSessionKey } = await import('../src/session/session-key.js');
    const { handleGatewayMessage } = await import(
      '../src/gateway/gateway-chat-service.js'
    );
    const { releaseSessionWorker } = await import(
      '../src/gateway/session-worker-release.js'
    );
    db.initDatabase({ quiet: true });
    const key =
      initial === 'legacy'
        ? 'tui:new-peer'
        : buildSessionKey('main', 'web', 'dm', 'new-peer');
    expect(db.getSessionById(key)).toBeUndefined();
    const other = db.getOrCreateSession('other-peer', null, 'web', 'main');
    let entered!: () => void;
    let finish!: (output: ContainerOutput) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<ContainerOutput>((resolve) => {
      finish = resolve;
    });
    runAgent.mockImplementationOnce(async () => {
      entered();
      return pending;
    });
    runAgent.mockResolvedValue(success);
    const request = {
      guildId: null,
      channelId: initial === 'legacy' ? 'tui' : 'web',
      userId: 'user_a',
      content: 'Prepare a fixture reply.',
      model: 'hybridai/gpt-5-mini',
      chatbotId: 'test-bot',
      sessionMode: 'resume' as const,
      workspacePathOverride: temp(),
    };
    const first = handleGatewayMessage({ ...request, sessionId: key });
    let second: Promise<unknown> | undefined;
    let id = '';
    try {
      await Promise.race([
        started,
        first.then((result) => {
          throw new Error('First turn ended before executor: ' + result.status);
        }),
      ]);
      id = db.getSessionById(key)?.id ?? '';
      expect(id).not.toBe('');
      second =
        target === 'release'
          ? releaseSessionWorker(key)
          : handleGatewayMessage({
              ...request,
              sessionId: target === 'key' ? key : id,
            });
      const parallel = await handleGatewayMessage({
        ...request,
        channelId: 'web',
        sessionId: other.id,
      });
      expect(parallel.status).toBe('success');
      expect(
        runAgent.mock.calls.filter(([run]) => run.sessionId === id),
      ).toHaveLength(1);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      finish(success);
      await Promise.all([first, second]);
    }
    if (target === 'release') expect(stop).toHaveBeenCalledExactlyOnceWith(id);
    else
      expect(
        runAgent.mock.calls.filter(([run]) => run.sessionId === id),
      ).toHaveLength(2);
  },
);

test.each(['workspace', 'auto-reset'] as const)(
  'a %s rotation holds the newly stored session through reply completion',
  async (mode) => {
    vi.stubEnv('HOME', temp());
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    vi.stubEnv('HYBRIDAI_API_KEY', '');
    vi.stubEnv('HYBRIDAI_CHATBOT_ID', '');
    const db = await import('../src/memory/db.js');
    const { DB_PATH } = await import('../src/config/config.js');
    const { updateRuntimeConfig } = await import(
      '../src/config/runtime-config.js'
    );
    const { handleGatewayMessage } = await import(
      '../src/gateway/gateway-chat-service.js'
    );
    db.initDatabase({ quiet: true });
    updateRuntimeConfig((draft) => {
      draft.sessionCompaction.preCompactionMemoryFlush.enabled = false;
      draft.sessionReset.defaultPolicy = {
        mode: mode === 'auto-reset' ? 'idle' : 'none',
        atHour: 4,
        idleMinutes: 1,
      };
    });
    const original = db.getOrCreateSession(
      'rotating-chat',
      null,
      'web',
      'main',
    );
    db.storeMessage(
      original.id,
      'user_a',
      'Fixture user',
      'user',
      'Earlier fixture question.',
      'main',
    );
    const other = db.getOrCreateSession('other-chat', null, 'web', 'main');
    if (mode === 'auto-reset') {
      const database = new Database(DB_PATH);
      try {
        database
          .prepare('UPDATE sessions SET last_active = ? WHERE id = ?')
          .run('2000-01-01 00:00:00', original.id);
      } finally {
        database.close();
      }
    }
    let entered!: () => void;
    let finish!: (output: ContainerOutput) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<ContainerOutput>((resolve) => {
      finish = resolve;
    });
    runAgent.mockImplementationOnce(async () => {
      entered();
      return pending;
    });
    runAgent.mockResolvedValue(success);
    const request = {
      guildId: null,
      channelId: 'web',
      userId: 'user_a',
      content: 'Continue the fixture.',
      model: 'hybridai/gpt-5-mini',
      chatbotId: 'test-bot',
      sessionMode: 'resume' as const,
      workspacePathOverride: mode === 'auto-reset' ? temp() : undefined,
    };
    const first = handleGatewayMessage({ ...request, sessionId: original.id });
    let second: Promise<unknown> | undefined;
    let id = '';
    try {
      await Promise.race([
        started,
        first.then((result) => {
          throw new Error('First turn ended before executor: ' + result.status);
        }),
      ]);
      id = runAgent.mock.calls[0][0].sessionId;
      expect(id).not.toBe(original.id);
      second = handleGatewayMessage({ ...request, sessionId: id });
      const parallel = await handleGatewayMessage({
        ...request,
        sessionId: other.id,
        workspacePathOverride: temp(),
      });
      expect(parallel.status).toBe('success');
      expect(
        runAgent.mock.calls.filter(([run]) => run.sessionId === id),
      ).toHaveLength(1);
    } finally {
      finish(success);
      await Promise.all([first, second]);
    }
    expect(
      runAgent.mock.calls.filter(([run]) => run.sessionId === id),
    ).toHaveLength(2);
  },
);
