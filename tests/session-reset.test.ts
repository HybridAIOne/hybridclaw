import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

import {
  DEFAULT_RESET_POLICY,
  isSessionExpired,
  resolveResetPolicy,
  resolveSessionResetChannelKind,
} from '../src/session/session-reset.ts';

const { runPreCompactionMemoryFlushMock } = vi.hoisted(() => ({
  runPreCompactionMemoryFlushMock: vi.fn(),
}));

vi.mock('../src/session/session-maintenance.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../src/session/session-maintenance.js')
    >();
  return {
    ...actual,
    runPreCompactionMemoryFlush: runPreCompactionMemoryFlushMock,
  };
});

const ORIGINAL_HOME = process.env.HOME;
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-session-reset-'),
  );
  tempDirs.push(dir);
  return dir;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function formatSqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function updateLastActive(
  dbPath: string,
  sessionId: string,
  lastActive: string,
): void {
  const database = new Database(dbPath);
  try {
    database
      .prepare('UPDATE sessions SET last_active = ? WHERE id = ?')
      .run(lastActive, sessionId);
  } finally {
    database.close();
  }
}

async function initSessionTestContext() {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const dbPath = path.join(homeDir, 'data', 'test.db');
  const dbModule = await import('../src/memory/db.ts');
  const memoryModule = await import('../src/memory/memory-service.ts');
  const runtimeConfigModule = await import('../src/config/runtime-config.ts');

  dbModule.initDatabase({ quiet: true, dbPath });

  return {
    dbPath,
    dbModule,
    memoryService: memoryModule.memoryService,
    runtimeConfigModule,
  };
}

afterEach(() => {
  runPreCompactionMemoryFlushMock.mockReset();
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isSessionExpired returns false for mode none', () => {
  const now = new Date(2026, 2, 14, 10, 0, 0);

  expect(
    isSessionExpired(
      { mode: 'none', atHour: 4, idleMinutes: 60 },
      new Date(2025, 0, 1, 0, 0, 0).toISOString(),
      now,
    ),
  ).toBe(false);
});

test('isSessionExpired returns true for idle timeout after threshold', () => {
  const now = new Date(2026, 2, 14, 10, 0, 0);

  expect(
    isSessionExpired(
      { mode: 'idle', atHour: 4, idleMinutes: 60 },
      new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      now,
    ),
  ).toBe(true);
});

test('isSessionExpired returns false for idle timeout within threshold', () => {
  const now = new Date(2026, 2, 14, 10, 0, 0);

  expect(
    isSessionExpired(
      { mode: 'idle', atHour: 4, idleMinutes: 60 },
      new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
      now,
    ),
  ).toBe(false);
});

test('isSessionExpired returns true for daily reset when last activity is before the reset boundary', () => {
  const now = new Date(2026, 2, 14, 5, 0, 0);

  expect(
    isSessionExpired(
      { mode: 'daily', atHour: 4, idleMinutes: 1440 },
      new Date(2026, 2, 13, 3, 30, 0).toISOString(),
      now,
    ),
  ).toBe(true);
});

test('isSessionExpired returns false for daily reset when last activity is after the reset boundary', () => {
  const now = new Date(2026, 2, 14, 5, 0, 0);

  expect(
    isSessionExpired(
      { mode: 'daily', atHour: 4, idleMinutes: 1440 },
      new Date(2026, 2, 14, 4, 30, 0).toISOString(),
      now,
    ),
  ).toBe(false);
});

test('isSessionExpired returns true for mode both when idle triggers first', () => {
  const now = new Date(2026, 2, 14, 3, 0, 0);

  expect(
    isSessionExpired(
      { mode: 'both', atHour: 4, idleMinutes: 60 },
      new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      now,
    ),
  ).toBe(true);
});

test('isSessionExpired returns true for mode both when daily triggers first', () => {
  const now = new Date(2026, 2, 14, 5, 0, 0);

  expect(
    isSessionExpired(
      { mode: 'both', atHour: 4, idleMinutes: 24 * 60 },
      new Date(2026, 2, 13, 3, 59, 0).toISOString(),
      now,
    ),
  ).toBe(true);
});

test('isSessionExpired returns false for mode both when neither policy triggers', () => {
  const now = new Date(2026, 2, 14, 5, 0, 0);

  expect(
    isSessionExpired(
      { mode: 'both', atHour: 4, idleMinutes: 24 * 60 },
      new Date(2026, 2, 14, 4, 30, 0).toISOString(),
      now,
    ),
  ).toBe(false);
});

test('resolveResetPolicy returns the default constant when config is missing', () => {
  expect(resolveResetPolicy()).toBe(DEFAULT_RESET_POLICY);
});

test('resolveSessionResetChannelKind infers real channel kinds from channel ids', () => {
  expect(resolveSessionResetChannelKind('heartbeat')).toBe('heartbeat');
  expect(resolveSessionResetChannelKind(' heartbeat ')).toBe('heartbeat');
  expect(resolveSessionResetChannelKind('123456789012345678')).toBe('discord');
  expect(resolveSessionResetChannelKind('491234567890@s.whatsapp.net')).toBe(
    'whatsapp',
  );
  expect(resolveSessionResetChannelKind('peer@example.com')).toBe('email');
  expect(resolveSessionResetChannelKind('tui')).toBe('tui');
  expect(resolveSessionResetChannelKind('web')).toBe('web');
  expect(resolveSessionResetChannelKind('cli')).toBe('cli');
  expect(
    resolveSessionResetChannelKind('not-a-known-channel-kind'),
  ).toBeUndefined();
  expect(resolveSessionResetChannelKind(undefined)).toBeUndefined();
});

test('resolveResetPolicy returns channel overrides when configured', async () => {
  const { runtimeConfigModule } = await initSessionTestContext();

  runtimeConfigModule.updateRuntimeConfig((draft) => {
    draft.sessionReset.defaultPolicy = {
      mode: 'idle',
      atHour: 6,
      idleMinutes: 240,
    };
    draft.sessionReset.byChannelKind = {
      heartbeat: {
        mode: 'none',
      },
      discord: {
        atHour: 8,
        idleMinutes: 30,
      },
    };
  });

  const config = runtimeConfigModule.getRuntimeConfig();
  expect(resolveResetPolicy({ channelKind: 'heartbeat', config })).toEqual({
    mode: 'none',
    atHour: 6,
    idleMinutes: 240,
  });
  expect(
    resolveResetPolicy({
      channelKind: resolveSessionResetChannelKind('123456789012345678'),
      config,
    }),
  ).toEqual({
    mode: 'idle',
    atHour: 8,
    idleMinutes: 30,
  });
});

test('resolveResetPolicy falls back to the default policy when a channel override is missing', async () => {
  const { runtimeConfigModule } = await initSessionTestContext();

  runtimeConfigModule.updateRuntimeConfig((draft) => {
    draft.sessionReset.defaultPolicy = {
      mode: 'daily',
      atHour: 7,
      idleMinutes: 90,
    };
    draft.sessionReset.byChannelKind = {
      heartbeat: {
        mode: 'none',
      },
    };
  });

  const config = runtimeConfigModule.getRuntimeConfig();
  expect(resolveResetPolicy({ channelKind: 'tui', config })).toEqual({
    mode: 'daily',
    atHour: 7,
    idleMinutes: 90,
  });
});

test('resetSessionIfExpired applies byChannelKind overrides for real transport channel ids', async () => {
  const { dbModule, memoryService, runtimeConfigModule, dbPath } =
    await initSessionTestContext();
  const sessionId = 'discord-reset';
  const channelId = '123456789012345678';

  runtimeConfigModule.updateRuntimeConfig((draft) => {
    draft.sessionReset.defaultPolicy = {
      mode: 'none',
      atHour: 4,
      idleMinutes: 1440,
    };
    draft.sessionReset.byChannelKind = {
      discord: {
        mode: 'idle',
        idleMinutes: 60,
      },
    };
  });

  dbModule.getOrCreateSession(sessionId, null, channelId);
  memoryService.storeMessage({
    sessionId,
    userId: 'user-1',
    username: 'user',
    role: 'user',
    content: 'discord context',
  });
  updateLastActive(
    dbPath,
    sessionId,
    formatSqliteUtc(new Date(Date.now() - 2 * 60 * 60 * 1000)),
  );

  const reset = dbModule.resetSessionIfExpired(sessionId, {
    policy: {
      mode: 'idle',
      atHour: 4,
      idleMinutes: 60,
    },
  });
  const session = dbModule.getSessionById(sessionId);

  expect(reset).toBe(true);
  expect(session?.message_count).toBe(0);
  expect(session?.reset_count).toBe(1);
  expect(memoryService.getConversationHistory(sessionId, 10)).toHaveLength(0);
});

test('resetSessionState clears messages and tracks the reset metadata', async () => {
  const { dbModule, memoryService } = await initSessionTestContext();
  const sessionId = 'reset-state';

  dbModule.getOrCreateSession(sessionId, null, 'tui');
  memoryService.storeMessage({
    sessionId,
    userId: 'user-1',
    username: 'user',
    role: 'user',
    content: 'remember this',
  });
  memoryService.storeMessage({
    sessionId,
    userId: 'assistant-1',
    username: 'assistant',
    role: 'assistant',
    content: 'noted',
  });
  dbModule.updateSessionSummary(sessionId, 'summary');
  dbModule.markSessionMemoryFlush(sessionId);

  dbModule.resetSessionState(sessionId);

  const session = dbModule.getSessionById(sessionId);
  expect(session).toBeDefined();
  expect(session?.message_count).toBe(0);
  expect(session?.session_summary).toBeNull();
  expect(session?.compaction_count).toBe(0);
  expect(session?.memory_flush_at).toBeNull();
  expect(session?.reset_count).toBe(1);
  expect(session?.reset_at).not.toBeNull();
  expect(memoryService.getConversationHistory(sessionId, 10)).toHaveLength(0);
});

test('resetSessionIfExpired auto-resets expired sessions', async () => {
  const { dbModule, memoryService, dbPath } = await initSessionTestContext();
  const sessionId = 'auto-reset';

  dbModule.getOrCreateSession(sessionId, null, 'tui');
  memoryService.storeMessage({
    sessionId,
    userId: 'user-1',
    username: 'user',
    role: 'user',
    content: 'old context',
  });
  dbModule.updateSessionSummary(sessionId, 'summary');
  updateLastActive(
    dbPath,
    sessionId,
    formatSqliteUtc(new Date(Date.now() - 2 * 60 * 60 * 1000)),
  );

  const reset = dbModule.resetSessionIfExpired(sessionId, {
    policy: {
      mode: 'idle',
      atHour: 4,
      idleMinutes: 60,
    },
  });
  const session = dbModule.getSessionById(sessionId);

  expect(reset).toBe(true);
  expect(session?.message_count).toBe(0);
  expect(session?.session_summary).toBeNull();
  expect(session?.reset_count).toBe(1);
  expect(session?.reset_at).not.toBeNull();
  expect(memoryService.getConversationHistory(sessionId, 10)).toHaveLength(0);
});

test('getOrCreateSession keeps recent sessions intact', async () => {
  const { dbModule, memoryService, runtimeConfigModule } =
    await initSessionTestContext();
  const sessionId = 'recent-session';

  runtimeConfigModule.updateRuntimeConfig((draft) => {
    draft.sessionReset.defaultPolicy = {
      mode: 'idle',
      atHour: 4,
      idleMinutes: 60,
    };
  });

  dbModule.getOrCreateSession(sessionId, null, 'tui');
  memoryService.storeMessage({
    sessionId,
    userId: 'user-1',
    username: 'user',
    role: 'user',
    content: 'fresh context',
  });

  const session = dbModule.getOrCreateSession(sessionId, null, 'tui');

  expect(session.message_count).toBe(1);
  expect(session.reset_count).toBe(0);
  expect(session.reset_at).toBeNull();
  expect(memoryService.getConversationHistory(sessionId, 10)).toHaveLength(1);
});

test('getOrCreateSession leaves expired sessions untouched until resetSessionIfExpired runs', async () => {
  const { dbModule, memoryService, runtimeConfigModule, dbPath } =
    await initSessionTestContext();
  const sessionId = 'expired-but-not-reset';

  runtimeConfigModule.updateRuntimeConfig((draft) => {
    draft.sessionReset.defaultPolicy = {
      mode: 'idle',
      atHour: 4,
      idleMinutes: 60,
    };
  });

  dbModule.getOrCreateSession(sessionId, null, 'tui');
  memoryService.storeMessage({
    sessionId,
    userId: 'user-1',
    username: 'user',
    role: 'user',
    content: 'stale context',
  });
  updateLastActive(
    dbPath,
    sessionId,
    formatSqliteUtc(new Date(Date.now() - 2 * 60 * 60 * 1000)),
  );

  const session = dbModule.getOrCreateSession(sessionId, null, 'tui');

  expect(session.message_count).toBe(1);
  expect(session.reset_count).toBe(0);
  expect(session.reset_at).toBeNull();
  expect(memoryService.getConversationHistory(sessionId, 10)).toHaveLength(1);
});

test('resetSessionIfExpired skips auto-reset when policy mode is none', async () => {
  const { dbModule, memoryService, runtimeConfigModule, dbPath } =
    await initSessionTestContext();
  const sessionId = 'no-auto-reset';

  runtimeConfigModule.updateRuntimeConfig((draft) => {
    draft.sessionReset.defaultPolicy = {
      mode: 'idle',
      atHour: 4,
      idleMinutes: 60,
    };
  });

  dbModule.getOrCreateSession(sessionId, null, 'tui');
  memoryService.storeMessage({
    sessionId,
    userId: 'user-1',
    username: 'user',
    role: 'user',
    content: 'persistent context',
  });
  updateLastActive(
    dbPath,
    sessionId,
    formatSqliteUtc(new Date(Date.now() - 2 * 60 * 60 * 1000)),
  );

  const reset = dbModule.resetSessionIfExpired(sessionId, {
    policy: {
      mode: 'none',
      atHour: 4,
      idleMinutes: 60,
    },
  });
  const session = dbModule.getSessionById(sessionId);

  expect(reset).toBe(false);
  expect(session?.message_count).toBe(1);
  expect(session?.reset_count).toBe(0);
  expect(session?.reset_at).toBeNull();
  expect(memoryService.getConversationHistory(sessionId, 10)).toHaveLength(1);
});

test('resetSessionIfExpired recomputes expiry when a cached evaluation is stale', async () => {
  const { dbModule, memoryService, runtimeConfigModule, dbPath } =
    await initSessionTestContext();
  const sessionId = 'stale-expiry-evaluation';

  runtimeConfigModule.updateRuntimeConfig((draft) => {
    draft.sessionReset.defaultPolicy = {
      mode: 'idle',
      atHour: 4,
      idleMinutes: 60,
    };
  });

  dbModule.getOrCreateSession(sessionId, null, 'tui');
  memoryService.storeMessage({
    sessionId,
    userId: 'user-1',
    username: 'user',
    role: 'user',
    content: 'context to clear',
  });
  const beforeExpiry = dbModule.getSessionById(sessionId);
  expect(beforeExpiry).toBeDefined();
  updateLastActive(
    dbPath,
    sessionId,
    formatSqliteUtc(new Date(Date.now() - 2 * 60 * 60 * 1000)),
  );

  const reset = dbModule.resetSessionIfExpired(sessionId, {
    policy: {
      mode: 'idle',
      atHour: 4,
      idleMinutes: 60,
    },
    expiryEvaluation: {
      lastActive: beforeExpiry?.last_active ?? '',
      isExpired: false,
    },
  });
  const session = dbModule.getSessionById(sessionId);

  expect(reset).toBe(true);
  expect(session?.message_count).toBe(0);
  expect(session?.reset_count).toBe(1);
  expect(memoryService.getConversationHistory(sessionId, 10)).toHaveLength(0);
});

test('handleGatewayCommand flushes memories before auto-resetting an expired session', async () => {
  const { dbModule, memoryService, runtimeConfigModule, dbPath } =
    await initSessionTestContext();
  const sessionId = 'gateway-auto-reset';

  runtimeConfigModule.updateRuntimeConfig((draft) => {
    draft.sessionReset.defaultPolicy = {
      mode: 'idle',
      atHour: 4,
      idleMinutes: 1,
    };
    draft.sessionCompaction.preCompactionMemoryFlush.enabled = true;
  });

  dbModule.getOrCreateSession(sessionId, null, 'tui');
  memoryService.storeMessage({
    sessionId,
    userId: 'user-1',
    username: 'user',
    role: 'user',
    content: 'old context',
  });
  dbModule.updateSessionSummary(sessionId, 'summary');
  updateLastActive(
    dbPath,
    sessionId,
    formatSqliteUtc(new Date(Date.now() - 2 * 60 * 60 * 1000)),
  );

  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  await handleGatewayCommand({
    sessionId,
    guildId: null,
    channelId: 'tui',
    args: ['help'],
  });

  expect(runPreCompactionMemoryFlushMock).toHaveBeenCalledTimes(1);
  expect(runPreCompactionMemoryFlushMock).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId,
      channelId: 'tui',
      sessionSummary: 'summary',
      olderMessages: expect.any(Array),
    }),
  );

  const session = dbModule.getSessionById(sessionId);
  expect(session?.reset_count).toBe(1);
  expect(session?.message_count).toBe(0);
});
