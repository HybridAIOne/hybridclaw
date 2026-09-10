import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { closeDatabase, initDatabase } from '../src/memory/database.js';
import { getOrCreateSession } from '../src/memory/sessions.js';
import {
  getMSTeamsUserAgent,
  listMSTeamsUsers,
  observeMSTeamsUser,
  setMSTeamsUserAgent,
} from '../src/memory/msteams-users.js';
import {
  recordUsageEvent,
  recordUsageEventBatch,
} from '../src/memory/usage.js';
import { buildSessionIdFromActivity } from '../src/channels/msteams/inbound.js';

const getAgentById = vi.hoisted(() =>
  vi.fn((id: string) => (id === 'sales' ? { id, archived: false } : null)),
);
vi.mock('../src/agents/agent-registry.js', () => ({ getAgentById }));
vi.mock('../src/config/runtime-config.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/config/runtime-config.js')>();
  return {
    ...actual,
    getRuntimeConfig: vi.fn(() =>
      structuredClone(actual.DEFAULT_RUNTIME_CONFIG),
    ),
  };
});
vi.mock('../src/config/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/config.js')>()),
  MSTEAMS_TENANT_ID: 'tenant-a',
}));
import { resolveMSTeamsUserAgent } from '../src/channels/msteams/user-routing.js';
import {
  getAdminMSTeamsUsers,
  updateAdminMSTeamsUser,
} from '../src/gateway/msteams-users.js';

let tempDir: string;
let dbPath: string;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-teams-users-'));
  dbPath = path.join(tempDir, 'test.db');
  initDatabase({ dbPath, quiet: true });
  getAgentById.mockImplementation((id) =>
    id === 'sales' ? { id, archived: false } : null,
  );
});
afterEach(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function observe(userId = 'user-a', tenantId = 'tenant-a', isMessage = true) {
  observeMSTeamsUser({
    tenantId,
    userId,
    teamsUserId: `29:${userId}`,
    entraObjectId: userId,
    displayName: 'Example User',
    isMessage,
  });
}

describe('Teams user routing and attribution', () => {
  test('persists observed identities and mappings across reopen; commands do not add messages', () => {
    observe('user-a', 'TENANT-A');
    expect(
      updateAdminMSTeamsUser({ userId: 'user-a', agentId: 'sales' }),
    ).toEqual({ status: 200 });
    observe('user-a', 'tenant-a', false);
    closeDatabase();
    initDatabase({ dbPath, quiet: true });
    expect(listMSTeamsUsers('tenant-a')).toEqual([
      expect.objectContaining({
        userId: 'user-a',
        teamsUserId: '29:user-a',
        entraObjectId: 'user-a',
        agentId: 'sales',
        messageCount: 1,
      }),
    ]);
    expect(resolveMSTeamsUserAgent('tenant-a', 'user-a')).toBe('sales');
    expect(resolveMSTeamsUserAgent('tenant-a', 'user-b')).toBe('main');
    expect(updateAdminMSTeamsUser({ userId: 'user-a', agentId: null })).toEqual(
      { status: 200 },
    );
    expect(resolveMSTeamsUserAgent('tenant-a', 'user-a')).toBe('main');
  });

  test('keeps case-sensitive Teams IDs separate for mappings and usage', () => {
    for (const userId of ['29:User-A', '29:user-a']) {
      observeMSTeamsUser({
        tenantId: 'tenant-a',
        userId,
        teamsUserId: userId,
        isMessage: true,
      });
    }
    expect(
      updateAdminMSTeamsUser({ userId: '29:User-A', agentId: 'sales' }),
    ).toEqual({ status: 200 });
    expect(resolveMSTeamsUserAgent('tenant-a', '29:User-A')).toBe('sales');
    expect(resolveMSTeamsUserAgent('tenant-a', '29:user-a')).toBe('main');
    recordUsageEvent({
      sessionId: 'shared-session',
      agentId: 'sales',
      model: 'test-model',
      userId: '29:User-A',
      channelKind: 'msteams',
      tenantId: 'tenant-a',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.25,
    });
    const users = new Map(
      listMSTeamsUsers('tenant-a').map((user) => [user.userId, user]),
    );
    expect(users.get('29:User-A')).toMatchObject({ totalTokens: 15 });
    expect(users.get('29:user-a')).toMatchObject({ totalTokens: 0 });
  });

  test('uses the configured default agent when no user mapping exists', async () => {
    const { getRuntimeConfig } = await import(
      '../src/config/runtime-config.js'
    );
    const config = getRuntimeConfig();
    config.agents.defaultAgentId = 'support';
    config.agents.list.push({ id: 'support' });
    vi.mocked(getRuntimeConfig).mockReturnValueOnce(config);
    expect(resolveMSTeamsUserAgent('tenant-a', 'new-user')).toBe('support');
  });

  test('isolates tenants and rejects unknown users, malformed assignments, and unavailable agents', () => {
    observe();
    observe('user-b', 'tenant-b');
    expect(getAdminMSTeamsUsers().users).toHaveLength(1);
    expect(
      updateAdminMSTeamsUser({
        userId: 'user-b',
        tenantId: 'tenant-b',
        agentId: 'sales',
      }).status,
    ).toBe(404);
    for (const input of [
      null,
      [],
      {},
      { userId: 'user-a' },
      { userId: 'user-a', agentId: '' },
      { userId: 'user-a', agentId: 'missing' },
    ]) {
      expect(updateAdminMSTeamsUser(input).status).toBe(400);
    }
    setMSTeamsUserAgent('tenant-a', 'user-a', 'sales');
    expect(getMSTeamsUserAgent('tenant-b', 'user-a')).toBeNull();
    getAgentById.mockReturnValue({ id: 'sales', archived: true });
    expect(
      updateAdminMSTeamsUser({ userId: 'user-a', agentId: 'sales' }).status,
    ).toBe(400);
    expect(() => resolveMSTeamsUserAgent('tenant-a', 'user-a')).toThrow(
      'unavailable',
    );
    getAgentById.mockReturnValue(null);
    expect(() => resolveMSTeamsUserAgent('tenant-a', 'user-a')).toThrow(
      'unavailable',
    );
  });

  test.each([
    'personal',
    'groupChat',
    'channel',
  ])('agent mappings isolate %s histories and changing back resumes the earlier key', (conversationType) => {
    const activity = {
      conversation: { id: 'conversation-a', conversationType },
      from: { id: '29:user-a', aadObjectId: 'user-a' },
    };
    const originalKey = buildSessionIdFromActivity(activity as never, 'main');
    const mappedKey = buildSessionIdFromActivity(activity as never, 'sales');
    expect(mappedKey).not.toBe(originalKey);
    const original = getOrCreateSession(
      originalKey,
      null,
      'conversation-a',
      'main',
    );
    const mapped = getOrCreateSession(
      mappedKey,
      null,
      'conversation-a',
      'sales',
    );
    expect(mapped.agent_id).toBe('sales');
    expect(mapped.id).not.toBe(original.id);
    expect(
      getOrCreateSession(originalKey, null, 'conversation-a', 'main').id,
    ).toBe(original.id);
  });

  test('counts each initiating user once across shared sessions, retries, and agent changes', () => {
    observe();
    observe('user-b');
    observe('user-a', 'tenant-b');
    const base = {
      sessionId: 'shared-session',
      agentId: 'main',
      model: 'test-model',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.25,
      channelKind: 'msteams',
      tenantId: 'tenant-a',
    };
    recordUsageEvent({ ...base, userId: 'user-a' });
    recordUsageEventBatch([
      {
        ...base,
        userId: 'user-a',
        agentId: 'sales',
        sessionId: 'sales-session',
      },
      { ...base, userId: 'user-b', totalTokens: 30, costUsd: 0.5 },
      { ...base, userId: 'user-a', tenantId: 'tenant-b', totalTokens: 1000 },
      { ...base, userId: 'user-a', channelKind: 'slack', totalTokens: 2000 },
      { ...base, totalTokens: 3000 },
    ]);
    const users = new Map(
      listMSTeamsUsers('tenant-a').map((user) => [user.userId, user]),
    );
    expect(users.get('user-a')).toMatchObject({
      totalTokens: 30,
      costUsd: 0.5,
      sessionCount: 2,
      messageCount: 1,
    });
    expect(users.get('user-b')).toMatchObject({
      totalTokens: 30,
      costUsd: 0.5,
      sessionCount: 1,
    });
  });

  test.each([
    57, 59,
  ])('migrates a v%s database without attributing historical usage', (version) => {
    recordUsageEvent({
      sessionId: 'historical',
      agentId: 'main',
      model: 'test-model',
      inputTokens: 100,
      outputTokens: 50,
    });
    closeDatabase();
    const db = new Database(dbPath);
    db.exec(
      'DROP TABLE msteams_users; DROP INDEX idx_usage_events_channel_user; ALTER TABLE usage_events DROP COLUMN user_id; ALTER TABLE usage_events DROP COLUMN channel_kind; ALTER TABLE usage_events DROP COLUMN tenant_id;',
    );
    if (version === 57) {
      db.exec(
        'ALTER TABLE jobs DROP COLUMN last_error; ALTER TABLE proactive_message_queue DROP COLUMN failed_at; ALTER TABLE proactive_message_queue DROP COLUMN failure_reason; ALTER TABLE messages DROP COLUMN tool_history_json;',
      );
    }
    db.pragma(`user_version = ${version}`);
    db.close();
    initDatabase({ dbPath, quiet: true });
    observe();
    expect(listMSTeamsUsers('tenant-a')[0]).toMatchObject({
      totalTokens: 0,
      costUsd: 0,
    });
    const migrated = new Database(dbPath, { readonly: true });
    try {
      expect(migrated.pragma('user_version', { simple: true })).toBe(60);
      for (const [table, column] of [
        ['jobs', 'last_error'],
        ['proactive_message_queue', 'failed_at'],
        ['proactive_message_queue', 'failure_reason'],
        ['messages', 'tool_history_json'],
      ]) {
        expect(migrated.pragma(`table_info(${table})`)).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: column })]),
        );
      }
    } finally {
      migrated.close();
    }
  });
});
