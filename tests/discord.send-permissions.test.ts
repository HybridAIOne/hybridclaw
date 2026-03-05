import { expect, test } from 'vitest';

import {
  type DiscordSendPermissionSnapshot,
  resolveSendAllowedFromSnapshot,
} from '../src/channels/discord/send-permissions.js';

const GUILD_ID = '123456789012345678';
const CHANNEL_ID = '223456789012345678';
const OTHER_CHANNEL_ID = '323456789012345678';

function buildSnapshot(
  patch?: Partial<DiscordSendPermissionSnapshot>,
): DiscordSendPermissionSnapshot {
  return {
    sendPolicy: 'open',
    sendAllowedChannelIds: [],
    guilds: {},
    ...(patch || {}),
  };
}

test('resolveSendAllowedFromSnapshot allows sends by default in open mode', () => {
  const result = resolveSendAllowedFromSnapshot(buildSnapshot(), {
    channelId: CHANNEL_ID,
  });
  expect(result).toEqual({ allowed: true });
});

test('resolveSendAllowedFromSnapshot denies sends when policy is disabled', () => {
  const result = resolveSendAllowedFromSnapshot(
    buildSnapshot({ sendPolicy: 'disabled' }),
    { channelId: CHANNEL_ID },
  );
  expect(result.allowed).toBe(false);
  expect(result.reason).toContain('disabled');
});

test('resolveSendAllowedFromSnapshot enforces top-level channel allowlist', () => {
  const result = resolveSendAllowedFromSnapshot(
    buildSnapshot({ sendAllowedChannelIds: [CHANNEL_ID] }),
    { channelId: OTHER_CHANNEL_ID },
  );
  expect(result.allowed).toBe(false);
  expect(result.reason).toContain('sendAllowedChannelIds');
});

test('resolveSendAllowedFromSnapshot denies allowlist mode when channel is not configured', () => {
  const result = resolveSendAllowedFromSnapshot(
    buildSnapshot({
      sendPolicy: 'allowlist',
      guilds: {
        [GUILD_ID]: {
          defaultMode: 'mention',
          channels: {},
        },
      },
    }),
    {
      channelId: CHANNEL_ID,
      guildId: GUILD_ID,
    },
  );
  expect(result.allowed).toBe(false);
  expect(result.reason).toContain('not configured');
});

test('resolveSendAllowedFromSnapshot allows allowlist mode when channel is configured', () => {
  const result = resolveSendAllowedFromSnapshot(
    buildSnapshot({
      sendPolicy: 'allowlist',
      guilds: {
        [GUILD_ID]: {
          defaultMode: 'mention',
          channels: {
            [CHANNEL_ID]: { mode: 'mention' },
          },
        },
      },
    }),
    {
      channelId: CHANNEL_ID,
      guildId: GUILD_ID,
    },
  );
  expect(result).toEqual({ allowed: true });
});

test('resolveSendAllowedFromSnapshot respects explicit channel send deny', () => {
  const result = resolveSendAllowedFromSnapshot(
    buildSnapshot({
      sendPolicy: 'allowlist',
      guilds: {
        [GUILD_ID]: {
          defaultMode: 'mention',
          channels: {
            [CHANNEL_ID]: { mode: 'mention', allowSend: false },
          },
        },
      },
    }),
    {
      channelId: CHANNEL_ID,
      guildId: GUILD_ID,
    },
  );
  expect(result.allowed).toBe(false);
  expect(result.reason).toContain('disables outbound sends');
});

test('resolveSendAllowedFromSnapshot enforces channel user allowlist', () => {
  const snapshot = buildSnapshot({
    guilds: {
      [GUILD_ID]: {
        defaultMode: 'mention',
        channels: {
          [CHANNEL_ID]: {
            mode: 'mention',
            sendAllowedUserIds: ['555555555555555555'],
          },
        },
      },
    },
  });

  const denied = resolveSendAllowedFromSnapshot(snapshot, {
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    requestingUserId: '444444444444444444',
  });
  expect(denied.allowed).toBe(false);

  const allowed = resolveSendAllowedFromSnapshot(snapshot, {
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    requestingUserId: '555555555555555555',
  });
  expect(allowed).toEqual({ allowed: true });
});

test('resolveSendAllowedFromSnapshot enforces role allowlist when present', () => {
  const snapshot = buildSnapshot({
    guilds: {
      [GUILD_ID]: {
        defaultMode: 'mention',
        channels: {
          [CHANNEL_ID]: {
            mode: 'mention',
            sendAllowedRoleIds: ['999999999999999999'],
          },
        },
      },
    },
  });

  const denied = resolveSendAllowedFromSnapshot(snapshot, {
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    requestingUserId: '444444444444444444',
    requestingRoleIds: ['888888888888888888'],
  });
  expect(denied.allowed).toBe(false);

  const allowed = resolveSendAllowedFromSnapshot(snapshot, {
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    requestingUserId: '444444444444444444',
    requestingRoleIds: ['999999999999999999'],
  });
  expect(allowed).toEqual({ allowed: true });
});
