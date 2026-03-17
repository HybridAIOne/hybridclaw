import { expect, test } from 'vitest';

import {
  buildSessionKey,
  inspectSessionKeyMigration,
  isLegacySessionKey,
  migrateLegacySessionKey,
  parseSessionKey,
} from '../src/session/session-key.js';

test('buildSessionKey lowercases and formats hierarchical keys', () => {
  expect(buildSessionKey('Main', 'Discord', 'Channel', 'ABC123')).toBe(
    'agent:main:discord:channel:abc123',
  );
});

test('parseSessionKey parses valid hierarchical keys', () => {
  expect(parseSessionKey('agent:main:scheduler:cron:job:42')).toEqual({
    agentId: 'main',
    channelKind: 'scheduler',
    chatType: 'cron',
    peerId: 'job:42',
  });
});

test('parseSessionKey returns null for legacy keys', () => {
  expect(parseSessionKey('dm:439508376087560193')).toBeNull();
});

test('isLegacySessionKey detects supported legacy formats', () => {
  expect(isLegacySessionKey('123456789012345678:1475079601968648386')).toBe(
    true,
  );
  expect(isLegacySessionKey('dm:439508376087560193')).toBe(true);
  expect(isLegacySessionKey('heartbeat:main')).toBe(true);
  expect(isLegacySessionKey('cron:42')).toBe(true);
  expect(isLegacySessionKey('agent:main:discord:dm:439508376087560193')).toBe(
    false,
  );
});

test('migrateLegacySessionKey converts legacy ids using session metadata', () => {
  expect(
    migrateLegacySessionKey('123456789012345678:1475079601968648386', {
      agent_id: 'main',
      channel_id: '1475079601968648386',
    }),
  ).toBe('agent:main:discord:channel:1475079601968648386');
  expect(
    migrateLegacySessionKey('dm:439508376087560193', {
      agent_id: 'main',
    }),
  ).toBe('agent:main:discord:dm:439508376087560193');
  expect(
    migrateLegacySessionKey('heartbeat:main', {
      agent_id: 'ignored',
    }),
  ).toBe('agent:main:heartbeat:system:default');
  expect(
    migrateLegacySessionKey('scheduler:nightly', {
      agent_id: 'main',
    }),
  ).toBe('agent:main:scheduler:system:nightly');
});

test('inspectSessionKeyMigration distinguishes rewritten and no-op results', () => {
  expect(
    inspectSessionKeyMigration('dm:439508376087560193', {
      agent_id: 'main',
    }),
  ).toEqual({
    key: 'agent:main:discord:dm:439508376087560193',
    migrated: true,
  });

  expect(
    inspectSessionKeyMigration('custom-session-id', {
      agent_id: 'main',
    }),
  ).toEqual({
    key: 'custom-session-id',
    migrated: false,
  });
});

test('build and parse round-trip to the same segments', () => {
  const key = buildSessionKey('main', 'scheduler', 'cron', '42');
  expect(parseSessionKey(key)).toEqual({
    agentId: 'main',
    channelKind: 'scheduler',
    chatType: 'cron',
    peerId: '42',
  });
});
