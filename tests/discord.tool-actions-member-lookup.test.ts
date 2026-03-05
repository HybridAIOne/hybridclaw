import type { Client, GuildMember } from 'discord.js';
import { expect, test, vi } from 'vitest';

import { createDiscordToolActionRunner } from '../src/channels/discord/tool-actions.js';

const GUILD_ID = '123456789012345678';

function makeMember(params: {
  id: string;
  username: string;
  displayName?: string;
  discriminator?: string;
}): GuildMember {
  const displayName = params.displayName || params.username;
  return {
    id: params.id,
    displayName,
    nickname: null,
    user: {
      id: params.id,
      username: params.username,
      globalName: displayName,
      discriminator: params.discriminator || '0001',
      bot: false,
    },
    joinedAt: null,
    premiumSince: null,
    communicationDisabledUntil: null,
    roles: {
      cache: {
        filter: () => ({
          map: () => [],
        }),
      },
    },
  } as unknown as GuildMember;
}

function createRunnerWithMembers(members: Map<string, GuildMember>) {
  const search = vi.fn(async () => members);
  const fetchByQuery = vi.fn(async (value: unknown) => {
    if (typeof value === 'string') return members.get(value) || null;
    return members;
  });
  const guildFetch = vi.fn(async () => ({
    id: GUILD_ID,
    members: {
      search,
      fetch: fetchByQuery,
    },
  }));

  const client = {
    guilds: {
      fetch: guildFetch,
    },
  } as unknown as Client;

  const runner = createDiscordToolActionRunner({
    requireDiscordClientReady: () => client,
    getDiscordPresence: () => undefined,
    sendToChannel: vi.fn(async () => {}),
    resolveSendAllowed: () => ({ allowed: true }),
  });

  return { runner, search, fetchByQuery, guildFetch };
}

test('member-info no-match returns structured hint text', async () => {
  const { runner } = createRunnerWithMembers(new Map());

  const result = await runner({
    action: 'member-info',
    guildId: GUILD_ID,
    user: 'missing-user',
  });

  expect(result).toMatchObject({
    ok: false,
    action: 'member-info',
    guildId: GUILD_ID,
  });
  expect(String(result.error || '')).toContain(
    'Hint: use a Discord user ID, @mention, or exact username',
  );
  expect('candidates' in result).toBe(false);
});

test('member-info ambiguous match returns structured candidates', async () => {
  const { runner } = createRunnerWithMembers(
    new Map<string, GuildMember>([
      [
        '111111111111111111',
        makeMember({
          id: '111111111111111111',
          username: 'alice',
          displayName: 'Alice',
          discriminator: '1234',
        }),
      ],
      [
        '222222222222222222',
        makeMember({
          id: '222222222222222222',
          username: 'alina',
          displayName: 'Alina',
          discriminator: '5678',
        }),
      ],
    ]),
  );

  const result = await runner({
    action: 'member-info',
    guildId: GUILD_ID,
    user: 'ali',
  });

  expect(result).toMatchObject({
    ok: false,
    action: 'member-info',
    guildId: GUILD_ID,
  });
  expect(String(result.error || '')).toContain('Ambiguous guild member match');
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  expect(candidates.length).toBe(2);
  expect(candidates).toEqual(
    expect.arrayContaining([
      {
        id: '111111111111111111',
        name: 'Alice',
        discriminator: '1234',
      },
      {
        id: '222222222222222222',
        name: 'Alina',
        discriminator: '5678',
      },
    ]),
  );
});

test('member-info ambiguous match auto-resolves when resolveAmbiguous=best', async () => {
  const { runner } = createRunnerWithMembers(
    new Map<string, GuildMember>([
      [
        '111111111111111111',
        makeMember({
          id: '111111111111111111',
          username: 'alice',
          displayName: 'Alice',
          discriminator: '1234',
        }),
      ],
      [
        '222222222222222222',
        makeMember({
          id: '222222222222222222',
          username: 'alicia',
          displayName: 'Alicia',
          discriminator: '5678',
        }),
      ],
    ]),
  );

  const result = await runner({
    action: 'member-info',
    guildId: GUILD_ID,
    user: 'ali',
    resolveAmbiguous: 'best',
  });

  expect(result).toMatchObject({
    ok: true,
    action: 'member-info',
    guildId: GUILD_ID,
    userId: '111111111111111111',
  });
  expect(String(result.note || '')).toContain(
    'Resolved ambiguous match to: Alice',
  );
  expect(String(result.note || '')).toContain('Other candidates: Alicia');
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  expect(candidates.length).toBe(2);
});
