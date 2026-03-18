import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';

class FakeDiscordClient extends EventEmitter {
  login = vi.fn(async (_token: string) => 'logged-in');
  destroy = vi.fn();
  application = {
    commands: {
      set: vi.fn(async () => []),
    },
  };
  user: { id: string; tag: string } | null = null;

  isReady(): boolean {
    return false;
  }
}

async function importFreshDiscordRuntime() {
  vi.resetModules();

  const fakeClient = new FakeDiscordClient();
  const loggerError = vi.fn();
  const logger = {
    debug: vi.fn(),
    error: loggerError,
    fatal: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  vi.doMock('discord.js', async () => {
    const actual = (await vi.importActual('discord.js')) as Record<
      string,
      unknown
    >;

    return {
      ...actual,
      Client: vi.fn(function MockDiscordClient() {
        return fakeClient;
      }),
    };
  });

  vi.doMock('../src/config/config.js', async () => {
    const actual = (await vi.importActual('../src/config/config.js')) as Record<
      string,
      unknown
    >;

    return {
      ...actual,
      DISCORD_TOKEN: 'discord-test-token',
    };
  });

  vi.doMock('../src/logger.js', () => ({
    logger,
  }));

  const runtime = await import('../src/channels/discord/runtime.ts');

  return {
    ...runtime,
    fakeClient,
    loggerError,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('discord.js');
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
});

describe('Discord client error handler', () => {
  test('initDiscord logs client error events instead of throwing', async () => {
    const { fakeClient, initDiscord, loggerError } =
      await importFreshDiscordRuntime();

    const client = await initDiscord(
      vi.fn(async () => {}),
      vi.fn(async () => {}),
    );
    const err = new Error('background shard helper failed');

    expect(client).toBe(fakeClient);
    expect(fakeClient.login).toHaveBeenCalledWith('discord-test-token');
    expect(() => client.emit('error', err)).not.toThrow();
    expect(loggerError).toHaveBeenCalledWith(
      { err },
      'Discord client error',
    );
  });

  test('fatal client error events schedule a crash after logging', async () => {
    const { initDiscord, loggerError } = await importFreshDiscordRuntime();
    let scheduledCallback: (() => void) | undefined;
    const setImmediateSpy = vi
      .spyOn(global, 'setImmediate')
      .mockImplementation(((callback: () => void) => {
        scheduledCallback = callback;
        return {} as ReturnType<typeof setImmediate>;
      }) as typeof setImmediate);

    const client = await initDiscord(
      vi.fn(async () => {}),
      vi.fn(async () => {}),
    );
    const err = Object.assign(new Error('An invalid token was provided.'), {
      code: 'TokenInvalid',
    });

    expect(() => client.emit('error', err)).not.toThrow();
    expect(loggerError).toHaveBeenCalledWith(
      { err },
      'Discord client encountered a fatal error; exiting',
    );
    expect(setImmediateSpy).toHaveBeenCalledTimes(1);
    expect(scheduledCallback).toBeDefined();
    expect(() => scheduledCallback?.()).toThrow(err);
  });

  test('shard error events log reconnectable failures without throwing', async () => {
    const { initDiscord, loggerError } = await importFreshDiscordRuntime();

    const client = await initDiscord(
      vi.fn(async () => {}),
      vi.fn(async () => {}),
    );
    const err = new Error('Opening handshake has timed out');

    expect(() => client.emit('shardError', err, 7)).not.toThrow();
    expect(loggerError).toHaveBeenCalledWith(
      { err, shardId: 7 },
      'Discord shard error (Discord.js will attempt to reconnect)',
    );
  });

  test('unrecoverable shard disconnects schedule a crash after logging', async () => {
    const { initDiscord, loggerError } = await importFreshDiscordRuntime();
    let scheduledCallback: (() => void) | undefined;
    const setImmediateSpy = vi
      .spyOn(global, 'setImmediate')
      .mockImplementation(((callback: () => void) => {
        scheduledCallback = callback;
        return {} as ReturnType<typeof setImmediate>;
      }) as typeof setImmediate);

    const client = await initDiscord(
      vi.fn(async () => {}),
      vi.fn(async () => {}),
    );

    expect(() =>
      client.emit('shardDisconnect', { code: 4014, wasClean: true }, 3),
    ).not.toThrow();
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        shardId: 3,
        closeCode: 4014,
        closeReason: 'DisallowedIntents',
        wasClean: true,
      }),
      'Discord shard disconnected with unrecoverable gateway close code; exiting',
    );
    expect(setImmediateSpy).toHaveBeenCalledTimes(1);
    expect(scheduledCallback).toBeDefined();
    expect(() => scheduledCallback?.()).toThrow(
      'Discord shard 3 disconnected with unrecoverable gateway close code 4014 (DisallowedIntents).',
    );
  });
});
