import { expect, test } from 'vitest';

import {
  type MSTeamsPermissionSnapshot,
  resolveMSTeamsChannelPolicyFromSnapshot,
} from '../src/channels/msteams/send-permissions.js';

const TEAM_ID = 'team-123';
const CHANNEL_ID = '19:channel@thread.tacv2';

function buildSnapshot(
  patch?: Partial<MSTeamsPermissionSnapshot>,
): MSTeamsPermissionSnapshot {
  return {
    groupPolicy: 'allowlist',
    dmPolicy: 'allowlist',
    allowFrom: [],
    teams: {},
    requireMention: true,
    replyStyle: 'thread',
    dangerouslyAllowNameMatching: false,
    ...(patch || {}),
  };
}

test('denies group activity by default in allowlist mode', () => {
  const result = resolveMSTeamsChannelPolicyFromSnapshot(buildSnapshot(), {
    isDm: false,
    teamId: TEAM_ID,
    channelId: CHANNEL_ID,
    actor: { userId: 'aad-user-1', aadObjectId: 'aad-user-1' },
  });

  expect(result.allowed).toBe(false);
  expect(result.groupPolicy).toBe('allowlist');
  expect(result.requireMention).toBe(true);
  expect(result.replyStyle).toBe('thread');
});

test('enforces cascading allowFrom from channel to team to global', () => {
  const snapshot = buildSnapshot({
    allowFrom: ['global-user'],
    teams: {
      [TEAM_ID]: {
        allowFrom: ['team-user'],
        requireMention: false,
        replyStyle: 'top-level',
        channels: {
          [CHANNEL_ID]: {
            allowFrom: ['channel-user'],
          },
        },
      },
    },
  });

  const denied = resolveMSTeamsChannelPolicyFromSnapshot(snapshot, {
    isDm: false,
    teamId: TEAM_ID,
    channelId: CHANNEL_ID,
    actor: { userId: 'team-user', aadObjectId: 'team-user' },
  });
  expect(denied.allowed).toBe(false);

  const allowed = resolveMSTeamsChannelPolicyFromSnapshot(snapshot, {
    isDm: false,
    teamId: TEAM_ID,
    channelId: CHANNEL_ID,
    actor: { userId: 'channel-user', aadObjectId: 'channel-user' },
  });
  expect(allowed.allowed).toBe(true);
  expect(allowed.effectiveAllowFrom).toEqual(['channel-user']);
  expect(allowed.replyStyle).toBe('top-level');
  expect(allowed.requireMention).toBe(false);
});

test('enforces Teams DM allowlists when dmPolicy is allowlist', () => {
  const result = resolveMSTeamsChannelPolicyFromSnapshot(
    buildSnapshot({
      dmPolicy: 'allowlist',
      allowFrom: ['aad-user-1'],
    }),
    {
      isDm: true,
      actor: { userId: 'aad-user-1', aadObjectId: 'aad-user-1' },
    },
  );

  expect(result.allowed).toBe(true);
  expect(result.dmPolicy).toBe('allowlist');
});

test('dangerouslyAllowNameMatching allows display-name fallback', () => {
  const result = resolveMSTeamsChannelPolicyFromSnapshot(
    buildSnapshot({
      groupPolicy: 'allowlist',
      allowFrom: ['Alice Example'],
      dangerouslyAllowNameMatching: true,
    }),
    {
      isDm: false,
      teamId: TEAM_ID,
      channelId: CHANNEL_ID,
      actor: {
        userId: 'aad-user-2',
        aadObjectId: 'aad-user-2',
        displayName: 'Alice Example',
      },
    },
  );

  expect(result.allowed).toBe(true);
  expect(result.matchedAllowFrom).toBe('Alice Example');
});
