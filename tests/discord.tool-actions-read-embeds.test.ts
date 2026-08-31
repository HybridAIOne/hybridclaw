import type { Client } from 'discord.js';
import { expect, test, vi } from 'vitest';

import { createDiscordToolActionRunner } from '../src/channels/discord/tool-actions.js';

const GUILD_ID = '123456789012345678';
const CHANNEL_ID = '223456789012345678';
const MESSAGE_ID = '323456789012345678';

type EmbedFixture = {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  timestamp?: string | null;
  author?: { name: string } | null;
  footer?: { text: string } | null;
  fields?: Array<{ name: string; value: string }>;
};

function createReadRunner(embeds: EmbedFixture[]) {
  const message = {
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    content: '',
    createdTimestamp: Date.parse('2026-08-29T10:00:00.000Z'),
    editedAt: null,
    author: {
      id: '423456789012345678',
      username: 'monit-alerts',
      globalName: null,
      bot: true,
    },
    member: null,
    attachments: new Map(),
    embeds,
    mentions: {
      users: new Map(),
      roles: new Map(),
      channels: new Map(),
    },
  };

  const channel = {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    messages: {
      fetch: vi.fn(async () => new Map([[MESSAGE_ID, message]])),
    },
  };

  const client = {
    channels: {
      fetch: vi.fn(async (channelId: string) =>
        channelId === CHANNEL_ID ? channel : null,
      ),
      cache: new Map(),
    },
    guilds: { fetch: vi.fn() },
  } as unknown as Client;

  return createDiscordToolActionRunner({
    requireDiscordClientReady: () => client,
    getDiscordPresence: () => undefined,
    sendToChannel: vi.fn(async () => {}),
    resolveSendAllowed: () => ({ allowed: true }),
  });
}

test('read action surfaces embed payloads for embed-only alert messages', async () => {
  const runner = createReadRunner([
    {
      title: 'Monit alert: prod-app-1',
      description: 'cpu usage of 97% matches resource limit',
      url: 'https://monit.example.com/alerts/42',
      timestamp: '2026-08-29T09:59:58.000Z',
      author: { name: 'Monit' },
      footer: { text: 'monit@prod-app-1' },
      fields: [
        { name: 'Host', value: 'prod-app-1' },
        { name: 'Severity', value: 'critical' },
      ],
    },
  ]);

  const result = (await runner({
    action: 'read',
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
  })) as {
    messages: Array<{
      content: string;
      embeds: Array<Record<string, unknown>>;
    }>;
  };

  expect(result.messages).toHaveLength(1);
  const [readMessage] = result.messages;
  expect(readMessage.content).toBe('');
  expect(readMessage.embeds).toEqual([
    {
      title: 'Monit alert: prod-app-1',
      description: 'cpu usage of 97% matches resource limit',
      url: 'https://monit.example.com/alerts/42',
      timestamp: '2026-08-29T09:59:58.000Z',
      author: { name: 'Monit' },
      footer: { text: 'monit@prod-app-1' },
      fields: [
        { name: 'Host', value: 'prod-app-1' },
        { name: 'Severity', value: 'critical' },
      ],
    },
  ]);
});

test('read action returns an empty embeds array when a message has none', async () => {
  const runner = createReadRunner([]);
  const result = (await runner({
    action: 'read',
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
  })) as { messages: Array<{ embeds: unknown[] }> };
  expect(result.messages[0].embeds).toEqual([]);
});

test('read action caps embeds per message and fields per embed', async () => {
  const runner = createReadRunner(
    Array.from({ length: 8 }, (_, embedIndex) => ({
      title: `embed-${embedIndex}`,
      description: null,
      fields: Array.from({ length: 14 }, (_, fieldIndex) => ({
        name: `field-${fieldIndex}`,
        value: `value-${fieldIndex}`,
      })),
    })),
  );

  const result = (await runner({
    action: 'read',
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
  })) as {
    messages: Array<{
      embeds: Array<{ title: string; fields: Array<{ name: string }> }>;
    }>;
  };

  const { embeds } = result.messages[0];
  expect(embeds).toHaveLength(5);
  expect(embeds.map((embed) => embed.title)).toEqual([
    'embed-0',
    'embed-1',
    'embed-2',
    'embed-3',
    'embed-4',
  ]);
  expect(embeds[0].fields).toHaveLength(10);
  expect(embeds[0].fields.at(-1)?.name).toBe('field-9');
});
