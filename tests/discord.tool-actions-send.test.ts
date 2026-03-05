import type { Client } from 'discord.js';
import { expect, test, vi } from 'vitest';
import type { ResolveSendAllowedResult } from '../src/channels/discord/send-permissions.js';
import { createDiscordToolActionRunner } from '../src/channels/discord/tool-actions.js';

const CHANNEL_ID = '223456789012345678';
const DM_CHANNEL_ID = '223456789012345679';
const GUILD_ID = '123456789012345678';
const REQUESTING_USER_ID = '333333333333333333';
const REQUESTING_ROLE_ID = '444444444444444444';

function createRunner(params?: {
  channel?: Record<string, unknown> | null;
  sendAllowed?: ResolveSendAllowedResult;
}) {
  const channel =
    params?.channel ??
    ({ id: CHANNEL_ID, guildId: GUILD_ID, send: vi.fn() } as const);
  const fetchChannel = vi.fn(async () => channel);
  const client = {
    channels: {
      fetch: fetchChannel,
      cache: new Map(),
    },
  } as unknown as Client;
  const sendToChannel = vi.fn(async () => {});
  const resolveSendAllowed = vi
    .fn()
    .mockReturnValue(params?.sendAllowed ?? { allowed: true });

  const runner = createDiscordToolActionRunner({
    requireDiscordClientReady: () => client,
    getDiscordPresence: () => undefined,
    sendToChannel,
    resolveSendAllowed,
  });

  return {
    runner,
    fetchChannel,
    sendToChannel,
    resolveSendAllowed,
  };
}

test('send action sends validated content to channel', async () => {
  const { runner, sendToChannel, resolveSendAllowed } = createRunner();
  const result = await runner({
    action: 'send',
    channelId: CHANNEL_ID,
    content: 'hello from tool',
  });

  expect(resolveSendAllowed).toHaveBeenCalledWith({
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    requestingUserId: undefined,
    requestingRoleIds: undefined,
  });
  expect(sendToChannel).toHaveBeenCalledWith(CHANNEL_ID, 'hello from tool');
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    channelId: CHANNEL_ID,
  });
});

test('send action rejects when permission resolver denies send', async () => {
  const { runner, sendToChannel } = createRunner({
    sendAllowed: { allowed: false, reason: 'blocked by policy' },
  });
  await expect(
    runner({
      action: 'send',
      channelId: CHANNEL_ID,
      content: 'hello',
    }),
  ).rejects.toThrow('blocked by policy');
  expect(sendToChannel).not.toHaveBeenCalled();
});

test('send action rejects missing content', async () => {
  const { runner, sendToChannel } = createRunner();
  await expect(
    runner({
      action: 'send',
      channelId: CHANNEL_ID,
      content: '   ',
    }),
  ).rejects.toThrow('content is required');
  expect(sendToChannel).not.toHaveBeenCalled();
});

test('send action rejects unresolved channel names without guild context', async () => {
  const { runner } = createRunner();
  await expect(
    runner({
      action: 'send',
      channelId: 'invalid',
      content: 'hello',
    }),
  ).rejects.toThrow('Provide guildId');
});

test('send action supports Discord component payloads', async () => {
  const send = vi.fn(async () => ({ id: '777777777777777777' }));
  const { runner, sendToChannel } = createRunner({
    channel: { id: CHANNEL_ID, guildId: GUILD_ID, send },
  });
  const result = await runner({
    action: 'send',
    channelId: CHANNEL_ID,
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: 'Confirm',
            custom_id: 'confirm_action',
          },
        ],
      },
    ],
  });

  expect(sendToChannel).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith({
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: 'Confirm',
            custom_id: 'confirm_action',
          },
        ],
      },
    ],
  });
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    channelId: CHANNEL_ID,
    componentsIncluded: true,
  });
});

test('send action rejects non-sendable channels', async () => {
  const { runner, sendToChannel } = createRunner({
    channel: { id: CHANNEL_ID, guildId: GUILD_ID },
  });
  await expect(
    runner({
      action: 'send',
      channelId: CHANNEL_ID,
      content: 'hello',
    }),
  ).rejects.toThrow('does not support sending messages');
  expect(sendToChannel).not.toHaveBeenCalled();
});

test('send action forwards requesting user roles to permission resolver', async () => {
  const member = {
    roles: {
      cache: {
        filter: (predicate: (role: { id: string }) => boolean) => ({
          map: (mapper: (role: { id: string }) => string) =>
            [REQUESTING_ROLE_ID, GUILD_ID]
              .map((id) => ({ id }))
              .filter(predicate)
              .map(mapper),
        }),
      },
    },
  };
  const channel = {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    send: vi.fn(),
    guild: {
      id: GUILD_ID,
      members: {
        fetch: vi.fn(async () => member),
      },
    },
  };
  const { runner, resolveSendAllowed } = createRunner({ channel });

  await runner({
    action: 'send',
    channelId: CHANNEL_ID,
    userId: REQUESTING_USER_ID,
    content: 'hello',
  });

  expect(resolveSendAllowed).toHaveBeenCalledWith({
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    requestingUserId: REQUESTING_USER_ID,
    requestingRoleIds: [REQUESTING_ROLE_ID],
  });
});

test('send action resolves user names from context channel guild in one call', async () => {
  const contextChannel = {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    send: vi.fn(),
  };
  const dmChannel = {
    id: DM_CHANNEL_ID,
    send: vi.fn(),
  };
  const channelsFetch = vi.fn(async (channelId: string) => {
    if (channelId === CHANNEL_ID) return contextChannel;
    if (channelId === DM_CHANNEL_ID) return dmChannel;
    return null;
  });
  const client = {
    channels: {
      fetch: channelsFetch,
      cache: new Map(),
    },
    guilds: {
      fetch: vi.fn(async () => ({
        channels: {
          fetch: vi.fn(async () => new Map()),
        },
        members: {
          search: vi.fn(
            async () =>
              new Map([
                [
                  '555555555555555555',
                  {
                    id: '555555555555555555',
                    displayName: 'Alice',
                    user: {
                      username: 'alice',
                      globalName: 'Alice',
                      discriminator: '1234',
                    },
                  },
                ],
              ]),
          ),
          fetch: vi.fn(
            async () =>
              new Map([
                [
                  '555555555555555555',
                  {
                    id: '555555555555555555',
                    displayName: 'Alice',
                    user: {
                      username: 'alice',
                      globalName: 'Alice',
                      discriminator: '1234',
                    },
                  },
                ],
              ]),
          ),
        },
      })),
    },
    users: {
      fetch: vi.fn(async () => ({
        createDM: vi.fn(async () => ({ id: DM_CHANNEL_ID })),
      })),
    },
  } as unknown as Client;
  const sendToChannel = vi.fn(async () => {});

  const runner = createDiscordToolActionRunner({
    requireDiscordClientReady: () => client,
    getDiscordPresence: () => undefined,
    sendToChannel,
    resolveSendAllowed: () => ({ allowed: true }),
  });

  const result = await runner({
    action: 'send',
    channelId: '@alice',
    contextChannelId: CHANNEL_ID,
    content: 'hello from one-call dm',
  });

  expect(sendToChannel).toHaveBeenCalledWith(
    DM_CHANNEL_ID,
    'hello from one-call dm',
  );
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    channelId: DM_CHANNEL_ID,
  });
});

test('send action resolves username field to DM when channelId is omitted', async () => {
  const contextChannel = {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    send: vi.fn(),
  };
  const client = {
    channels: {
      fetch: vi.fn(async (channelId: string) => {
        if (channelId === CHANNEL_ID) return contextChannel;
        if (channelId === DM_CHANNEL_ID)
          return { id: DM_CHANNEL_ID, send: vi.fn() };
        return null;
      }),
      cache: new Map(),
    },
    guilds: {
      fetch: vi.fn(async () => ({
        channels: {
          fetch: vi.fn(async () => new Map()),
        },
        members: {
          search: vi.fn(
            async () =>
              new Map([
                [
                  '555555555555555555',
                  {
                    id: '555555555555555555',
                    displayName: 'Alice',
                    user: {
                      username: 'alice',
                      globalName: 'Alice',
                      discriminator: '1234',
                    },
                  },
                ],
              ]),
          ),
          fetch: vi.fn(
            async () =>
              new Map([
                [
                  '555555555555555555',
                  {
                    id: '555555555555555555',
                    displayName: 'Alice',
                    user: {
                      username: 'alice',
                      globalName: 'Alice',
                      discriminator: '1234',
                    },
                  },
                ],
              ]),
          ),
        },
      })),
    },
    users: {
      fetch: vi.fn(async () => ({
        createDM: vi.fn(async () => ({ id: DM_CHANNEL_ID })),
      })),
    },
  } as unknown as Client;
  const sendToChannel = vi.fn(async () => {});

  const runner = createDiscordToolActionRunner({
    requireDiscordClientReady: () => client,
    getDiscordPresence: () => undefined,
    sendToChannel,
    resolveSendAllowed: () => ({ allowed: true }),
  });

  const result = await runner({
    action: 'send',
    username: '@alice',
    contextChannelId: CHANNEL_ID,
    content: 'hello from username field',
  });

  expect(sendToChannel).toHaveBeenCalledWith(
    DM_CHANNEL_ID,
    'hello from username field',
  );
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    channelId: DM_CHANNEL_ID,
  });
});

test('send action resolves numeric user ids to DM when no channel exists', async () => {
  const userId = '555555555555555555';
  const dmChannel = {
    id: DM_CHANNEL_ID,
    send: vi.fn(),
  };
  const client = {
    channels: {
      fetch: vi.fn(async (channelId: string) => {
        if (channelId === userId) return null;
        if (channelId === DM_CHANNEL_ID) return dmChannel;
        return null;
      }),
      cache: new Map(),
    },
    users: {
      fetch: vi.fn(async (id: string) => ({
        id,
        createDM: vi.fn(async () => ({ id: DM_CHANNEL_ID })),
      })),
    },
  } as unknown as Client;
  const sendToChannel = vi.fn(async () => {});

  const runner = createDiscordToolActionRunner({
    requireDiscordClientReady: () => client,
    getDiscordPresence: () => undefined,
    sendToChannel,
    resolveSendAllowed: () => ({ allowed: true }),
  });

  const result = await runner({
    action: 'send',
    channelId: userId,
    content: 'hello numeric id',
  });

  expect(sendToChannel).toHaveBeenCalledWith(DM_CHANNEL_ID, 'hello numeric id');
  expect(result).toMatchObject({
    ok: true,
    action: 'send',
    channelId: DM_CHANNEL_ID,
  });
});
