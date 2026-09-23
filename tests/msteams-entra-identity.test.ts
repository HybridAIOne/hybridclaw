import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  buildSessionIdFromActivity,
  extractActorIdentity,
} from '../src/channels/msteams/inbound.js';
import { closeDatabase, initDatabase } from '../src/memory/database.js';
import {
  listMSTeamsUsers,
  observeMSTeamsUser,
} from '../src/memory/msteams-users.js';

const getAgentById = vi.hoisted(() =>
  vi.fn((id: string) => (id === 'sales' ? { id, archived: false } : null)),
);
vi.mock('../src/agents/agent-registry.js', () => ({ getAgentById }));
vi.mock('../src/config/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/config.js')>()),
  MSTEAMS_TENANT_ID: '72F988BF-86F1-41AF-91AB-2D7CD011DB47',
}));
import { resolveMSTeamsUserAgent } from '../src/channels/msteams/user-routing.js';
import {
  getAdminMSTeamsUsers,
  updateAdminMSTeamsUser,
} from '../src/gateway/msteams-users.js';

const ENTRA_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';

// Shape of a personal-chat message as Bot Framework delivers it from Teams.
const activity = {
  type: 'message',
  text: 'Hallo',
  from: {
    id: '29:1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-abcdefghijklmnop',
    name: 'Example User',
    aadObjectId: ENTRA_ID,
  },
  conversation: {
    id: 'a:1conversation',
    conversationType: 'personal',
    tenantId: TENANT,
  },
  channelData: { tenant: { id: TENANT } },
  channelId: 'msteams',
};

let tempDir: string;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-entra-'));
  initDatabase({ dbPath: path.join(tempDir, 'test.db'), quiet: true });
});
afterEach(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function observe(input: typeof activity) {
  const actor = extractActorIdentity(input as never);
  observeMSTeamsUser({
    tenantId: TENANT,
    userId: actor.userId,
    teamsUserId: input.from.id,
    entraObjectId: actor.aadObjectId,
    displayName: actor.displayName,
    isMessage: true,
  });
  return actor;
}

test('the Entra object ID is the routing key, the stored identity, and the session peer', () => {
  const actor = observe(activity);
  expect(actor.userId).toBe(ENTRA_ID);
  expect(actor.aadObjectId).toBe(ENTRA_ID);

  expect(getAdminMSTeamsUsers().users).toEqual([
    expect.objectContaining({
      userId: ENTRA_ID,
      entraObjectId: ENTRA_ID,
      teamsUserId: activity.from.id,
      displayName: 'Example User',
      agentId: null,
    }),
  ]);
  expect(resolveMSTeamsUserAgent(TENANT, actor.userId)).toBe('main');
  expect(buildSessionIdFromActivity(activity as never, 'main')).toBe(
    `agent:main:channel:msteams:chat:dm:peer:${ENTRA_ID}`,
  );

  expect(updateAdminMSTeamsUser({ userId: ENTRA_ID, agentId: 'sales' })).toEqual(
    { status: 200 },
  );
  const agentId = resolveMSTeamsUserAgent(TENANT, actor.userId);
  expect(agentId).toBe('sales');
  expect(buildSessionIdFromActivity(activity as never, agentId)).toBe(
    `agent:sales:channel:msteams:chat:dm:peer:${ENTRA_ID}`,
  );
  expect(listMSTeamsUsers('72F988BF-86F1-41AF-91AB-2D7CD011DB47')).toHaveLength(
    1,
  );
});

test('a sender without aadObjectId falls back to the Teams ID as a separate identity', () => {
  const withoutAad = {
    ...activity,
    from: { id: activity.from.id, name: activity.from.name },
  } as typeof activity;
  observe(withoutAad);
  observe(activity);
  expect(
    listMSTeamsUsers(TENANT)
      .map((user) => user.userId)
      .sort(),
  ).toEqual([activity.from.id, ENTRA_ID].sort());
});
