import type { Client } from 'discord.js';
import { expect, test, vi } from 'vitest';

import { createDiscordToolActionRunner } from '../src/channels/discord/tool-actions.js';

const GUILD_ID = '123456789012345678';
const CHANNEL_ID = '223456789012345678';

function createSendRunner(params?: {
  channelCache?: Map<string, unknown>;
  guildChannelEntries?: Array<[string, unknown]>;
}) {
  const sendableChannel = {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    send: vi.fn(),
  };
  const channelFetch = vi.fn(async (channelId: string) =>
    channelId === CHANNEL_ID ? sendableChannel : null,
  );
  const guildFetch = vi.fn(async () => ({
    channels: {
      fetch: vi.fn(async () => new Map(params?.guildChannelEntries || [])),
    },
  }));
  const client = {
    channels: {
      fetch: channelFetch,
      cache: params?.channelCache || new Map(),
    },
    guilds: {
      fetch: guildFetch,
    },
  } as unknown as Client;

  const sendToChannel = vi.fn(async () => {});
  const runner = createDiscordToolActionRunner({
    requireDiscordClientReady: () => client,
    getDiscordPresence: () => undefined,
    sendToChannel,
    resolveSendAllowed: () => ({ allowed: true }),
  });

  return { runner, sendToChannel, channelFetch, guildFetch };
}

test('send action accepts Discord channel mentions', async () => {
  const { runner, sendToChannel } = createSendRunner();
  await runner({
    action: 'send',
    channelId: `<#${CHANNEL_ID}>`,
    content: 'hello',
  });
  expect(sendToChannel).toHaveBeenCalledWith(CHANNEL_ID, 'hello');
});

test('send action resolves #channel names with guildId', async () => {
  const { runner, sendToChannel } = createSendRunner({
    guildChannelEntries: [
      [
        CHANNEL_ID,
        {
          id: CHANNEL_ID,
          name: 'alerts',
          isTextBased: () => true,
        },
      ],
    ],
  });
  await runner({
    action: 'send',
    channelId: '#alerts',
    guildId: GUILD_ID,
    content: 'hello',
  });
  expect(sendToChannel).toHaveBeenCalledWith(CHANNEL_ID, 'hello');
});

test('send action resolves #channel names from channel cache when guildId is omitted', async () => {
  const { runner, sendToChannel } = createSendRunner({
    channelCache: new Map([
      [
        CHANNEL_ID,
        {
          id: CHANNEL_ID,
          name: 'alerts',
          isTextBased: () => true,
        },
      ],
    ]),
  });
  await runner({
    action: 'send',
    channelId: '#alerts',
    content: 'hello',
  });
  expect(sendToChannel).toHaveBeenCalledWith(CHANNEL_ID, 'hello');
});

test('send action asks for guildId when #channel lookup cannot resolve from cache', async () => {
  const { runner } = createSendRunner();
  await expect(
    runner({
      action: 'send',
      channelId: '#alerts',
      content: 'hello',
    }),
  ).rejects.toThrow('Provide guildId');
});

test('read action resolves #channel names and reads channel history', async () => {
  const readChannel = {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    messages: {
      fetch: vi.fn(async () => new Map()),
    },
  };
  const client = {
    channels: {
      fetch: vi.fn(async (channelId: string) =>
        channelId === CHANNEL_ID ? readChannel : null,
      ),
      cache: new Map(),
    },
    guilds: {
      fetch: vi.fn(async () => ({
        channels: {
          fetch: vi.fn(
            async () =>
              new Map([
                [
                  CHANNEL_ID,
                  {
                    id: CHANNEL_ID,
                    name: 'alerts',
                    isTextBased: () => true,
                  },
                ],
              ]),
          ),
        },
      })),
    },
  } as unknown as Client;

  const runner = createDiscordToolActionRunner({
    requireDiscordClientReady: () => client,
    getDiscordPresence: () => undefined,
    sendToChannel: vi.fn(async () => {}),
    resolveSendAllowed: () => ({ allowed: true }),
  });

  const result = await runner({
    action: 'read',
    channelId: '#alerts',
    guildId: GUILD_ID,
    limit: 1,
  });

  expect(result).toMatchObject({
    ok: true,
    action: 'read',
    channelId: CHANNEL_ID,
  });
});
