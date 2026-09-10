import type { ApplicationCommandDataResolvable, Client } from 'discord.js';
import { afterEach, expect, test, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({ logger: loggerMocks }));

import { registerSlashCommands } from '../src/channels/discord/slash-command-registration.js';

const definitions = ['status', 'sessions', 'audit'].map((name) => ({
  name,
  description: `Describe ${name}`,
}));

function makeGuild(id = 'guild-1') {
  const commands = new Map(
    [...definitions, { name: 'unrelated' }].map(({ name }) => [
      `${id}-${name}`,
      { id: `${id}-${name}`, name },
    ]),
  );
  return {
    id,
    commands: {
      fetch: vi.fn().mockResolvedValue(commands),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function makeClient(guilds = [makeGuild()]) {
  const create = vi
    .fn<(definition: ApplicationCommandDataResolvable) => Promise<unknown>>()
    .mockResolvedValue(undefined);
  const client = {
    application: { commands: { create } },
    guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) },
  } as unknown as Pick<Client, 'application' | 'guilds'>;
  return { client, create, guilds };
}

afterEach(() => {
  vi.clearAllMocks();
});

test('upserts global commands and removes only their matching guild copies', async () => {
  const { client, create, guilds } = makeClient();

  await registerSlashCommands(client, definitions);

  expect(create.mock.calls).toEqual(
    definitions.map((definition) => [definition]),
  );
  expect(guilds[0].commands.delete.mock.calls).toEqual([
    ['guild-1-status'],
    ['guild-1-sessions'],
    ['guild-1-audit'],
  ]);
  expect(create.mock.invocationCallOrder.at(-1)).toBeLessThan(
    guilds[0].commands.fetch.mock.invocationCallOrder[0],
  );
  expect(loggerMocks.info).toHaveBeenCalledWith(
    { scope: 'global', count: 3 },
    'Successfully registered slash commands',
  );
  expect(loggerMocks.warn).not.toHaveBeenCalled();
});

test('continues after a rejected command and preserves its guild copy until a successful retry', async () => {
  const { client, create, guilds } = makeClient();
  const error = Object.assign(new Error('Invalid Form Body'), { code: 50035 });
  create.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);

  await registerSlashCommands(client, definitions);

  expect(create.mock.calls).toEqual(
    definitions.map((definition) => [definition]),
  );
  expect(loggerMocks.warn).toHaveBeenCalledWith(
    { scope: 'global', command: 'sessions', err: error },
    'Failed to register global slash command',
  );
  expect(loggerMocks.warn).toHaveBeenCalledWith(
    { scope: 'global', count: 2, failedCount: 1 },
    'Slash command registration completed with failures',
  );
  expect(loggerMocks.info).not.toHaveBeenCalledWith(
    expect.objectContaining({ scope: 'global' }),
    'Successfully registered slash commands',
  );
  expect(guilds[0].commands.delete.mock.calls).toEqual([
    ['guild-1-status'],
    ['guild-1-audit'],
  ]);

  await registerSlashCommands(client, definitions);

  expect(guilds[0].commands.delete).toHaveBeenCalledWith('guild-1-sessions');
  expect(loggerMocks.info).toHaveBeenCalledWith(
    { scope: 'global', count: 3 },
    'Successfully registered slash commands',
  );
});

test('does not clean up any guild commands if all global registrations fail', async () => {
  const { client, create, guilds } = makeClient();
  create.mockRejectedValue(new Error('Missing Access'));

  await expect(
    registerSlashCommands(client, definitions),
  ).resolves.toBeUndefined();

  expect(create).toHaveBeenCalledTimes(3);
  expect(guilds[0].commands.fetch).not.toHaveBeenCalled();
  expect(guilds[0].commands.delete).not.toHaveBeenCalled();
  expect(loggerMocks.warn).toHaveBeenCalledWith(
    { scope: 'global', count: 0, failedCount: 3 },
    'Slash command registration completed with failures',
  );
});

test.each([
  'fetch',
  'delete',
] as const)('a guild cleanup %s failure does not stop cleanup in other guilds', async (operation) => {
  const { client, guilds } = makeClient([makeGuild(), makeGuild('guild-2')]);
  const error = new Error('Missing Permissions');
  guilds[0].commands[operation].mockRejectedValue(error);

  await expect(
    registerSlashCommands(client, definitions),
  ).resolves.toBeUndefined();

  expect(loggerMocks.warn).toHaveBeenCalledWith(
    { guildId: 'guild-1', err: error },
    'Failed to clean up Discord guild slash commands',
  );
  expect(guilds[1].commands.delete.mock.calls).toEqual([
    ['guild-2-status'],
    ['guild-2-sessions'],
    ['guild-2-audit'],
  ]);
});

test('does not register or delete commands without an application', async () => {
  const { client, create, guilds } = makeClient();
  client.application = null;

  await registerSlashCommands(client, definitions);

  expect(create).not.toHaveBeenCalled();
  expect(guilds[0].commands.fetch).not.toHaveBeenCalled();
  expect(loggerMocks.info).not.toHaveBeenCalled();
});
