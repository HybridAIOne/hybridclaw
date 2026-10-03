import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-session-end-');
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllEnvs: true,
});

async function fixture(options?: {
  mode?: 'idle' | 'daily';
  throwing?: boolean;
}) {
  const home = makeTempDir();
  vi.stubEnv('HOME', home);
  const pluginDir = path.join(home, '.hybridclaw', 'plugins', 'end-recorder');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.hybridclaw', 'config.json'),
    JSON.stringify({
      sessionCompaction: { preCompactionMemoryFlush: { enabled: false } },
      sessionReset: {
        defaultPolicy: {
          mode: options?.mode || 'none',
          atHour: 4,
          idleMinutes: 1,
        },
      },
      plugins: { list: [{ id: 'end-recorder', enabled: true }] },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    'id: end-recorder\nname: End Recorder\nkind: tool\n',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.js'),
    `
    export default {
      id: 'end-recorder',
      register(api) {
        const events = [];
        ${options?.throwing ? "api.on('session_end', () => { throw new Error('test hook failure'); });" : ''}
        api.on('session_end', async context => {
          await Promise.resolve();
          events.push({ hook: 'session_end', ...context });
        });
        api.on('session_reset', context => events.push({ hook: 'session_reset', ...context }));
        api.registerCommand({ name: 'end_events', description: 'Read events',
          handler: () => JSON.stringify(events) });
      }
    };
  `,
  );
  const db = await import('../src/memory/db.js');
  const { DB_PATH } = await import('../src/config/config.js');
  const { ensurePluginManagerInitialized } = await import(
    '../src/plugins/plugin-manager.js'
  );
  const gateway = await import('../src/gateway/gateway-service.js');
  db.initDatabase({ quiet: true });
  const session = db.getOrCreateSession('end-test', null, 'web', 'main');
  db.storeMessage(session.id, 'user_a', null, 'user', 'Remember this');
  const workspacePath = path.join(home, 'workspace');
  const manager = await ensurePluginManagerInitialized();
  await manager.notifySessionStart({
    sessionId: session.id,
    userId: 'user_a',
    agentId: 'main',
    channelId: 'web',
    workspacePath,
  });
  const events = async () =>
    JSON.parse(
      String(
        await manager.findCommand('end_events')?.handler([], {
          sessionId: session.id,
          channelId: 'web',
        }),
      ),
    ) as Array<{
      hook: string;
      sessionId: string;
      userId: string;
      workspacePath?: string;
      previousSessionId?: string;
    }>;
  const command = (args: string[]) =>
    gateway.handleGatewayCommand({
      sessionId: session.id,
      guildId: null,
      channelId: 'web',
      userId: 'user_a',
      args,
    });
  return {
    db,
    DB_PATH,
    session,
    manager,
    gateway,
    events,
    command,
    workspacePath,
  };
}

test.each(['clear', 'new', 'reset'])(
  '%s dispatches session_end before session_reset and transfers context',
  async (command) => {
    const f = await fixture();
    if (command === 'reset') {
      await f.command(['reset']);
      expect(await f.events()).toEqual([]);
    }
    const result = await f.command(
      command === 'reset' ? ['reset', 'yes'] : [command],
    );
    expect(result.kind).toBe('info');
    expect(await f.events()).toEqual([
      {
        hook: 'session_end',
        sessionId: f.session.id,
        userId: 'user_a',
        agentId: 'main',
        channelId: 'web',
        workspacePath: f.workspacePath,
      },
      expect.objectContaining({
        hook: 'session_reset',
        previousSessionId: f.session.id,
        sessionId: result.sessionId,
        reason: command,
      }),
    ]);
    expect(f.manager.getSessionUserId(f.session.id)).toBeNull();
    expect(f.manager.getSessionWorkspaceRoot(f.session.id)).toBeNull();
    expect(f.manager.getSessionUserId(result.sessionId!)).toBe('user_a');
    expect(f.manager.getSessionWorkspaceRoot(result.sessionId!)).toBe(
      f.workspacePath,
    );
  },
);

test.each(['idle', 'daily'] as const)(
  '%s expiry dispatches session_end for the expired instance',
  async (mode) => {
    const f = await fixture({ mode });
    const database = new Database(f.DB_PATH);
    database
      .prepare('UPDATE sessions SET last_active = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', f.session.id);
    database.close();
    const result = await f.command(['status']);
    expect(result.sessionId).not.toBe(f.session.id);
    expect(await f.events()).toEqual([
      expect.objectContaining({ hook: 'session_end', sessionId: f.session.id }),
      expect.objectContaining({ hook: 'session_reset', reason: 'auto-reset' }),
    ]);
  },
);

test.each([false, true])(
  'deletion awaits subscribed handlers and clears context (throwing=%s)',
  async (throwing) => {
    const f = await fixture({ throwing });
    const notify = f.manager.notifySessionEnd.bind(f.manager);
    vi.spyOn(f.manager, 'notifySessionEnd').mockImplementation(
      async (context) => {
        expect(f.db.getSessionById(f.session.id)).toBeDefined();
        expect(f.db.sessionHasUserMessages(f.session.id)).toBe(true);
        await notify(context);
      },
    );
    const result = await f.gateway.deleteGatewayAdminSession(f.session.id);
    expect(result.deleted).toBe(true);
    expect(await f.events()).toEqual([
      expect.objectContaining({
        hook: 'session_end',
        sessionId: f.session.id,
        userId: 'user_a',
        agentId: 'main',
        channelId: 'web',
        workspacePath: f.workspacePath,
      }),
    ]);
    expect(f.manager.getSessionUserId(f.session.id)).toBeNull();
    expect(f.manager.getSessionWorkspaceRoot(f.session.id)).toBeNull();
    expect(
      (await f.gateway.deleteGatewayAdminSession(f.session.id)).deleted,
    ).toBe(false);
    expect(await f.events()).toHaveLength(1);
  },
);

test('conditional deletion leaves sessions with user messages and their plugin context intact', async () => {
  const f = await fixture();
  expect(
    await f.gateway.deleteGatewayAdminSession(f.session.id, {
      onlyWithoutUserMessages: true,
    }),
  ).toMatchObject({ deleted: false, skippedReason: 'has_user_messages' });
  expect(await f.events()).toEqual([]);
  expect(f.manager.getSessionUserId(f.session.id)).toBe('user_a');
  expect(f.manager.getSessionWorkspaceRoot(f.session.id)).toBe(f.workspacePath);
});

test('conditional deletion rechecks user messages after asynchronous hooks', async () => {
  const f = await fixture();
  const empty = f.db.getOrCreateSession('empty-test', null, 'web', 'main');
  const notify = f.manager.notifySessionEnd.bind(f.manager);
  vi.spyOn(f.manager, 'notifySessionEnd').mockImplementation(
    async (context) => {
      await notify(context);
      f.db.storeMessage(empty.id, 'user_a', null, 'user', 'Keep this session');
    },
  );
  expect(
    await f.gateway.deleteGatewayAdminSession(empty.id, {
      onlyWithoutUserMessages: true,
    }),
  ).toMatchObject({ deleted: false, skippedReason: 'has_user_messages' });
  expect(f.db.sessionHasUserMessages(empty.id)).toBe(true);
});

test('switching sessions ends the previous active instance', async () => {
  const f = await fixture();
  const next = await f.command(['new']);
  const result = await f.gateway.handleGatewayCommand({
    sessionId: next.sessionId!,
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    args: ['sessions', 'switch', f.session.id],
  });
  expect(result.sessionId).toBe(f.session.id);
  expect((await f.events()).slice(2)).toEqual([
    expect.objectContaining({ hook: 'session_end', sessionId: next.sessionId }),
    expect.objectContaining({
      hook: 'session_reset',
      reason: 'switch',
      sessionId: f.session.id,
    }),
  ]);
});

test('deletion recovers identity from stored history when no live plugin context exists', async () => {
  const f = await fixture();
  const cold = f.db.getOrCreateSession('cold-session', null, 'tui', 'main');
  f.db.storeMessage(cold.id, 'user_b', null, 'user', 'Stored user');
  f.db.storeMessage(cold.id, 'assistant', null, 'assistant', 'Stored reply');
  expect((await f.gateway.deleteGatewayAdminSession(cold.id)).deleted).toBe(
    true,
  );
  expect(await f.events()).toEqual([
    expect.objectContaining({
      hook: 'session_end',
      sessionId: cold.id,
      userId: 'user_b',
      agentId: 'main',
      channelId: 'tui',
    }),
  ]);
});

test('plugin initialization failure does not prevent deletion', async () => {
  const f = await fixture();
  vi.spyOn(f.manager, 'ensureInitialized').mockRejectedValue(
    new Error('test initialization failure'),
  );
  expect(
    (await f.gateway.deleteGatewayAdminSession(f.session.id)).deleted,
  ).toBe(true);
  expect(f.db.getSessionById(f.session.id)).toBeUndefined();
});

test('a failing session_end handler does not prevent reset or context transfer', async () => {
  const f = await fixture({ throwing: true });
  const result = await f.command(['clear']);
  expect(result.sessionId).not.toBe(f.session.id);
  expect((await f.events()).map((event) => event.hook)).toEqual([
    'session_end',
    'session_reset',
  ]);
  expect(f.manager.getSessionUserId(f.session.id)).toBeNull();
  expect(f.manager.getSessionWorkspaceRoot(result.sessionId!)).toBe(
    f.workspacePath,
  );
});
