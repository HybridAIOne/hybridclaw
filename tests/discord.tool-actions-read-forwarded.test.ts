import type { Client } from 'discord.js';
import { expect, test, vi } from 'vitest';

import { createDiscordToolActionRunner } from '../src/channels/discord/tool-actions.js';

const GUILD_ID = '123456789012345678';
const CHANNEL_ID = '223456789012345678';
const MESSAGE_ID = '323456789012345678';
const FORWARDED_MESSAGE_ID = '423456789012345678';

function createReadRunner(messageSnapshots: Map<string, unknown> | undefined) {
  const message = {
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    // A forward has no content of its own; everything lives in the snapshot.
    content: '',
    createdTimestamp: Date.parse('2026-09-18T12:58:00.000Z'),
    editedAt: null,
    author: {
      id: '523456789012345678',
      username: 'forwarder',
      globalName: null,
      bot: false,
    },
    member: null,
    attachments: new Map(),
    embeds: [],
    messageSnapshots,
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

test('read action surfaces the content, embeds and attachments of a forwarded message', async () => {
  const snapshot = {
    id: FORWARDED_MESSAGE_ID,
    content: 'Please look at this report',
    attachments: new Map([
      [
        'att-1',
        {
          id: 'att-1',
          name: 'screenshot.png',
          url: 'https://cdn.discordapp.com/attachments/1/2/screenshot.png',
          contentType: 'image/png',
          size: 1234,
        },
      ],
    ]),
    embeds: [
      {
        title: 'Negative feedback',
        description: 'New feedback for My Assistant',
        url: null,
        timestamp: null,
        author: null,
        footer: { text: 'Bot Issues' },
        fields: [{ name: 'Issue', value: '#619' }],
      },
    ],
  };
  const runner = createReadRunner(new Map([[FORWARDED_MESSAGE_ID, snapshot]]));

  const result = (await runner({
    action: 'read',
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
  })) as {
    messages: Array<{
      content: string;
      forwarded?: Array<{
        content: string;
        attachments: Array<Record<string, unknown>>;
        embeds: Array<Record<string, unknown>>;
      }>;
    }>;
  };

  expect(result.messages).toHaveLength(1);
  const [readMessage] = result.messages;
  expect(readMessage.content).toBe('');
  expect(readMessage.forwarded).toEqual([
    {
      content: 'Please look at this report',
      attachments: [
        {
          id: 'att-1',
          name: 'screenshot.png',
          url: 'https://cdn.discordapp.com/attachments/1/2/screenshot.png',
          contentType: 'image/png',
          size: 1234,
        },
      ],
      embeds: [
        {
          title: 'Negative feedback',
          description: 'New feedback for My Assistant',
          url: null,
          timestamp: null,
          author: null,
          footer: { text: 'Bot Issues' },
          fields: [{ name: 'Issue', value: '#619' }],
        },
      ],
    },
  ]);
});

test('read action omits the forwarded field for ordinary messages', async () => {
  const runner = createReadRunner(new Map());
  const result = (await runner({
    action: 'read',
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
  })) as { messages: Array<Record<string, unknown>> };
  expect(result.messages[0]).not.toHaveProperty('forwarded');

  const legacyRunner = createReadRunner(undefined);
  const legacyResult = (await legacyRunner({
    action: 'read',
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
  })) as { messages: Array<Record<string, unknown>> };
  expect(legacyResult.messages[0]).not.toHaveProperty('forwarded');
});
