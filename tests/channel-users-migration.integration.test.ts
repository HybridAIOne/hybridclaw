import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { closeDatabase, initDatabase } from '../src/memory/database.js';
import {
  findChannelUserEmail,
  listChannelUsers,
} from '../src/memory/channel-users.js';
import { resolveMSTeamsUserAgent } from '../src/channels/msteams/user-routing.js';
import { getAdminMSTeamsUsers } from '../src/gateway/msteams-users.js';
import { DATABASE_SCHEMA_VERSION } from '../src/memory/schema/migrations.js';
import { recordUsageEvent } from '../src/memory/usage.js';
import { useTempDir } from './test-utils.js';

const TENANT = vi.hoisted(() => '72f988bf-86f1-41af-91ab-2d7cd011db47');

vi.mock('../src/agents/agent-registry.js', () => ({
  getAgentById: (id: string) => (id === 'main' ? { id, archived: false } : null),
}));
vi.mock('../src/config/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/config.js')>()),
  MSTEAMS_TENANT_ID: TENANT.toUpperCase(),
}));

// Copied from a database created by the released 0.39.1 package (v62 table
// plus the v66 email column), so the upgrade runs against the shipped shape.
const RELEASED_MSTEAMS_USERS = (withEmail: boolean) => `CREATE TABLE msteams_users (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    teams_user_id TEXT,
    entra_object_id TEXT,
    display_name TEXT,
    agent_id TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))${withEmail ? ', email TEXT' : ''},
    PRIMARY KEY (tenant_id, user_id)
  )`;

const RELEASED_ROWS = [
  {
    user_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    teams_user_id: '29:1erika-teams-id',
    entra_object_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    display_name: 'Erika Example',
    email: 'erika@example.com',
    agent_id: null,
    message_count: 2,
    first_seen: '2026-10-08T15:19:42.764Z',
    last_seen: '2026-10-08T15:20:12.613Z',
  },
  {
    user_id: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
    teams_user_id: '29:1max-teams-id',
    entra_object_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    display_name: 'Max Example',
    email: 'max@example.com',
    agent_id: 'main',
    message_count: 1,
    first_seen: '2026-10-08T15:20:19.603Z',
    last_seen: '2026-10-08T15:20:19.603Z',
  },
  {
    user_id: '29:1legacy-no-aad',
    teams_user_id: '29:1legacy-no-aad',
    entra_object_id: null,
    display_name: 'Legacy Sender',
    email: null,
    agent_id: null,
    message_count: 1,
    first_seen: '2026-10-08T15:20:26.400Z',
    last_seen: '2026-10-08T15:20:26.400Z',
  },
];

const makeTempDir = useTempDir('hybridclaw-channel-users-');
afterEach(() => closeDatabase());

/** Rewinds a current database to how a release at `version` left it. */
function createReleasedDatabase(version: number): string {
  const dbPath = path.join(makeTempDir(), 'hybridclaw.db');
  initDatabase({ dbPath, quiet: true });
  recordUsageEvent({
    sessionId: 'teams-dm-erika',
    agentId: 'main',
    model: 'lmstudio/fake-model',
    inputTokens: 120,
    outputTokens: 30,
    userId: RELEASED_ROWS[0].user_id,
    channelKind: 'msteams',
    tenantId: TENANT,
  });
  closeDatabase();
  const db = new Database(dbPath);
  const withEmail = version >= 66;
  db.exec('DROP TABLE IF EXISTS channel_users; DROP TABLE IF EXISTS msteams_users');
  db.exec(RELEASED_MSTEAMS_USERS(withEmail));
  const insert = db.prepare(`INSERT INTO msteams_users
    (tenant_id, user_id, teams_user_id, entra_object_id, display_name,
      agent_id, message_count, first_seen, last_seen${withEmail ? ', email' : ''})
    VALUES (@tenant_id, @user_id, @teams_user_id, @entra_object_id,
      @display_name, @agent_id, @message_count, @first_seen,
      @last_seen${withEmail ? ', @email' : ''})`);
  for (const row of RELEASED_ROWS) {
    const { email, ...rest } = row;
    insert.run({ tenant_id: TENANT, ...rest, ...(withEmail ? { email } : {}) });
  }
  db.prepare('DELETE FROM migrations WHERE version > ?').run(version);
  db.pragma(`user_version = ${version}`);
  db.close();
  return dbPath;
}

function readTables(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      userVersion: db.pragma('user_version', { simple: true }),
      tables: (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('msteams_users', 'channel_users') ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
      migration: db
        .prepare('SELECT description FROM migrations WHERE version = 73')
        .get(),
      rows: db
        .prepare(
          'SELECT * FROM channel_users ORDER BY channel_kind, tenant_id, user_id',
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

describe('msteams_users to channel_users upgrade', () => {
  test('a fresh database has channel_users and no Teams-only table', () => {
    const dbPath = path.join(makeTempDir(), 'hybridclaw.db');
    initDatabase({ dbPath, quiet: true });
    expect(readTables(dbPath)).toMatchObject({
      userVersion: DATABASE_SCHEMA_VERSION,
      tables: ['channel_users'],
      rows: [],
    });
  });

  test('carries a 0.39.1 (v72) database over once and keeps Teams behaviour', () => {
    const dbPath = createReleasedDatabase(72);
    initDatabase({ dbPath, quiet: true });

    const after = readTables(dbPath);
    expect(after.userVersion).toBe(DATABASE_SCHEMA_VERSION);
    expect(after.tables).toEqual(['channel_users']);
    expect(after.migration).toEqual({
      description: 'Replace the Teams-only user table with channel_users',
    });
    expect(after.rows).toEqual(
      RELEASED_ROWS.map((row) => ({
        channel_kind: 'msteams',
        tenant_id: TENANT,
        user_id: row.user_id,
        display_name: row.display_name,
        email: row.email,
        agent_id: row.agent_id,
        profile_json: JSON.stringify({
          teamsUserId: row.teams_user_id,
          ...(row.entra_object_id
            ? { entraObjectId: row.entra_object_id }
            : {}),
        }),
        message_count: row.message_count,
        first_seen: row.first_seen,
        last_seen: row.last_seen,
      })).sort((a, b) => (a.user_id < b.user_id ? -1 : 1)),
    );

    expect(getAdminMSTeamsUsers().users).toEqual(
      expect.arrayContaining(
        RELEASED_ROWS.map((row) =>
          expect.objectContaining({
            tenantId: TENANT,
            userId: row.user_id,
            teamsUserId: row.teams_user_id,
            entraObjectId: row.entra_object_id,
            agentId: row.agent_id,
            messageCount: row.message_count,
          }),
        ),
      ),
    );
    expect(
      listChannelUsers('msteams', TENANT).find(
        (user) => user.userId === RELEASED_ROWS[0].user_id,
      ),
    ).toMatchObject({ totalTokens: 150, sessionCount: 1 });
    expect(resolveMSTeamsUserAgent(TENANT, RELEASED_ROWS[1].user_id)).toBe(
      'main',
    );
    expect(findChannelUserEmail('msteams', RELEASED_ROWS[0].user_id)).toBe(
      'erika@example.com',
    );

    closeDatabase();
    initDatabase({ dbPath, quiet: true });
    expect(readTables(dbPath).rows).toEqual(after.rows);
  });

  test('carries a pre-email (v65) table over with no email', () => {
    const dbPath = createReleasedDatabase(65);
    initDatabase({ dbPath, quiet: true });
    const after = readTables(dbPath);
    expect(after.tables).toEqual(['channel_users']);
    expect(after.rows).toHaveLength(RELEASED_ROWS.length);
    expect(after.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
          email: null,
          agent_id: 'main',
        }),
      ]),
    );
  });
});
