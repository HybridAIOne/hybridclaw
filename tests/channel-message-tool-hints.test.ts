import { expect, test } from 'vitest';

import {
  DISCORD_CAPABILITIES,
  EMAIL_CAPABILITIES,
  MSTEAMS_CAPABILITIES,
  TELEGRAM_CAPABILITIES,
  WHATSAPP_CAPABILITIES,
} from '../src/channels/channel.js';
import { registerChannel } from '../src/channels/channel-registry.js';
import { resolveChannelMessageToolHints } from '../src/channels/prompt-adapters.js';

const CHANNEL_ID = '1475079601968648386';
const GUILD_ID = '123456789012345678';

test('resolves Discord message tool hints when channelType is discord', () => {
  registerChannel({
    kind: 'discord',
    id: 'discord-bot',
    capabilities: DISCORD_CAPABILITIES,
  });

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
  expect(hints.some((entry) => entry.includes('`filePath`'))).toBe(true);
  expect(
    hints.some((entry) =>
      entry.includes('WhatsApp JID/phone number or an email address instead'),
    ),
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
  registerChannel({
    kind: 'discord',
    id: 'discord-bot',
    capabilities: DISCORD_CAPABILITIES,
  });

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

test('resolves WhatsApp hints from explicit WhatsApp context', () => {
  registerChannel({
    kind: 'whatsapp',
    id: 'whatsapp',
    capabilities: WHATSAPP_CAPABILITIES,
  });

  const hints = resolveChannelMessageToolHints({
    runtimeInfo: {
      channelType: 'whatsapp',
      channelId: '491234567890@s.whatsapp.net',
    },
  });

  expect(hints.length).toBeGreaterThan(0);
  expect(hints.some((entry) => entry.includes('Current WhatsApp chat'))).toBe(
    true,
  );
  expect(
    hints.some((entry) => entry.includes('`*bold*`, `_italic_`, `~strike~`')),
  ).toBe(true);
  expect(
    hints.some((entry) => entry.includes('always provide an explicit target')),
  ).toBe(true);
});

test('prefers WhatsApp hints over email hints for raw WhatsApp jids', () => {
  const hints = resolveChannelMessageToolHints({
    runtimeInfo: {
      channelId: '491234567890@s.whatsapp.net',
    },
  });

  expect(hints.length).toBeGreaterThan(0);
  expect(hints.some((entry) => entry.includes('Current WhatsApp chat'))).toBe(
    true,
  );
  expect(hints.some((entry) => entry.includes('Current email peer'))).toBe(
    false,
  );
});

test('resolves email hints with read support from explicit email context', () => {
  registerChannel({
    kind: 'email',
    id: 'ops@example.com',
    capabilities: EMAIL_CAPABILITIES,
  });

  const hints = resolveChannelMessageToolHints({
    runtimeInfo: {
      channelType: 'email',
      channelId: 'peer@example.com',
    },
  });

  expect(hints.length).toBeGreaterThan(0);
  expect(hints.some((entry) => entry.includes('Current email peer'))).toBe(
    true,
  );
  expect(
    hints.some((entry) =>
      entry.includes('Supported `message` actions here: `read`'),
    ),
  ).toBe(true);
  expect(
    hints.some((entry) =>
      entry.includes('does not do arbitrary mailbox-wide unread searches'),
    ),
  ).toBe(true);
  expect(
    hints.some((entry) =>
      entry.includes('append a polished corporate signature block'),
    ),
  ).toBe(true);
  expect(
    hints.some((entry) =>
      entry.includes('do not use emoji or mascot-style sign-offs'),
    ),
  ).toBe(true);
  expect(
    hints.some((entry) =>
      entry.includes('make a reasonable best-effort assumption'),
    ),
  ).toBe(true);
  expect(hints.some((entry) => entry.includes('`IDENTITY.md`'))).toBe(true);
});

test('resolves Teams hints from explicit Teams context', () => {
  registerChannel({
    kind: 'msteams',
    id: 'msteams',
    capabilities: MSTEAMS_CAPABILITIES,
  });

  const hints = resolveChannelMessageToolHints({
    runtimeInfo: {
      channelType: 'msteams',
      channelId: '19:channel@thread.tacv2',
      guildId: 'team-123',
    },
  });

  expect(hints.length).toBeGreaterThan(0);
  expect(
    hints.some((entry) =>
      entry.includes('Current Teams conversation: `19:channel@thread.tacv2`'),
    ),
  ).toBe(true);
  expect(hints.some((entry) => entry.includes('Adaptive Card'))).toBe(true);
  expect(
    hints.some((entry) =>
      entry.includes(
        'supports `read`, `channel-info`, `member-info`, and `send`',
      ),
    ),
  ).toBe(true);
  expect(
    hints.some((entry) =>
      entry.includes('known Teams conversation ID or Teams session ID'),
    ),
  ).toBe(true);
  expect(hints.some((entry) => entry.includes('post or upload it here'))).toBe(
    true,
  );
});

test('resolves Telegram hints from explicit Telegram context', () => {
  registerChannel({
    kind: 'telegram',
    id: 'telegram',
    capabilities: TELEGRAM_CAPABILITIES,
  });

  const hints = resolveChannelMessageToolHints({
    runtimeInfo: {
      channelType: 'telegram',
      channelId: 'telegram:-1001234567890:topic:42',
    },
  });

  expect(hints.length).toBeGreaterThan(0);
  expect(
    hints.some((entry) =>
      entry.includes(
        'Current Telegram chat: `telegram:-1001234567890:topic:42`',
      ),
    ),
  ).toBe(true);
  expect(hints.some((entry) => entry.includes('Telegram topic targets'))).toBe(
    true,
  );
  expect(
    hints.some((entry) =>
      entry.includes(
        'Do not ask for a phone number when a valid Telegram `telegram:<chatId>` target is already available.',
      ),
    ),
  ).toBe(true);
  expect(hints.some((entry) => entry.includes('group or topic thread'))).toBe(
    true,
  );
});
