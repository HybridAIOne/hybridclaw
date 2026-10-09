import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  findChannelUserEmail,
  listChannelUsers,
  observeChannelUser,
} from '../src/memory/channel-users.js';
import { closeDatabase, initDatabase } from '../src/memory/database.js';
import { recordUsageEvent } from '../src/memory/usage.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-channel-users-');
beforeEach(() => {
  initDatabase({ dbPath: path.join(makeTempDir(), 'test.db'), quiet: true });
});
afterEach(() => closeDatabase());

const key = {
  channelKind: 'msteams',
  tenantId: 'Tenant-A',
  userId: 'u1',
} as const;

describe('channel user registry', () => {
  test('a later observation never clears a profile id or email it did not report', () => {
    observeChannelUser({
      ...key,
      email: 'user_a@example.com',
      profile: { teamsUserId: '29:u1', entraObjectId: 'entra-u1' },
      isMessage: true,
    });
    observeChannelUser({
      ...key,
      email: null,
      profile: { teamsUserId: '29:u1-renamed', entraObjectId: '  ' },
      isMessage: true,
    });
    observeChannelUser({ ...key, isMessage: false });

    expect(listChannelUsers('msteams', 'tenant-a')).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-a',
        userId: 'u1',
        profile: { teamsUserId: '29:u1-renamed', entraObjectId: 'entra-u1' },
        messageCount: 2,
      }),
    ]);
    expect(findChannelUserEmail('msteams', 'u1')).toBe('user_a@example.com');
  });

  test('usage totals count only the listed tenant', () => {
    observeChannelUser({ ...key, isMessage: true });
    for (const tenantId of ['tenant-a', 'tenant-b']) {
      recordUsageEvent({
        sessionId: `s-${tenantId}`,
        agentId: 'main',
        model: 'test-model',
        inputTokens: 10,
        outputTokens: 5,
        userId: 'u1',
        channelKind: 'msteams',
        tenantId,
      });
    }

    expect(listChannelUsers('msteams', 'TENANT-A')).toEqual([
      expect.objectContaining({ sessionCount: 1, totalTokens: 15 }),
    ]);
  });
});
