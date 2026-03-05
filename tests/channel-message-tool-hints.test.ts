import { expect, test } from 'vitest';

import { resolveChannelMessageToolHints } from '../src/channels/prompt-adapters.js';

const CHANNEL_ID = '1475079601968648386';
const GUILD_ID = '123456789012345678';

test('resolves Discord message tool hints when channelType is discord', () => {
  const hints = resolveChannelMessageToolHints({
    runtimeInfo: {
      channelType: 'discord',
      channelId: CHANNEL_ID,
      guildId: GUILD_ID,
    },
  });

  expect(hints.length).toBeGreaterThan(0);
  expect(
    hints.some((entry) =>
      entry.includes(`Current Discord channel: \`${CHANNEL_ID}\``),
    ),
  ).toBe(true);
  expect(
    hints.some((entry) => entry.includes('Supported actions: `read`')),
  ).toBe(true);
});

test('falls back to Discord adapter when ids look like Discord context', () => {
  const hints = resolveChannelMessageToolHints({
    runtimeInfo: {
      channelId: CHANNEL_ID,
    },
  });

  expect(hints.length).toBeGreaterThan(0);
  expect(
    hints.some((entry) => entry.includes('Discord targets: use `channelId`')),
  ).toBe(true);
});

test('returns no channel hints for explicit non-Discord channel type', () => {
  const hints = resolveChannelMessageToolHints({
    runtimeInfo: {
      channelType: 'tui',
      channelId: 'local-channel',
    },
  });

  expect(hints).toEqual([]);
});

test('includes DM context hint when guildId is null', () => {
  const hints = resolveChannelMessageToolHints({
    runtimeInfo: {
      channelType: 'discord',
      channelId: CHANNEL_ID,
      guildId: null,
    },
  });

  expect(
    hints.some((entry) => entry.includes('Current Discord context is a DM')),
  ).toBe(true);
});
