import { expect, test, vi } from 'vitest';

async function importFreshChannelRegistryModules() {
  vi.resetModules();
  const channelModule = await import('../src/channels/channel.js');
  const channelRegistryModule = await import(
    '../src/channels/channel-registry.js'
  );
  return {
    ...channelModule,
    ...channelRegistryModule,
  };
}

test('registerChannel and getChannel return registered channel info', async () => {
  const { DISCORD_CAPABILITIES, getChannel, registerChannel } =
    await importFreshChannelRegistryModules();

  registerChannel({
    kind: 'discord',
    id: 'discord-bot',
    capabilities: DISCORD_CAPABILITIES,
  });

  expect(getChannel('discord')).toMatchObject({
    kind: 'discord',
    id: 'discord-bot',
  });
});

test('getChannelByContextId resolves Discord, WhatsApp, email, and Teams ids', async () => {
  const { getChannelByContextId } = await importFreshChannelRegistryModules();

  expect(getChannelByContextId('1475079601968648386')?.kind).toBe('discord');
  expect(getChannelByContextId('491234567890@s.whatsapp.net')?.kind).toBe(
    'whatsapp',
  );
  expect(getChannelByContextId('peer@example.com')?.kind).toBe('email');
  expect(getChannelByContextId('19:channel@thread.tacv2')?.kind).toBe(
    'msteams',
  );
});

test('getChannel normalizes the teams alias only for registered channels', async () => {
  const { MSTEAMS_CAPABILITIES, getChannel, registerChannel } =
    await importFreshChannelRegistryModules();

  expect(getChannel('teams')).toBeUndefined();

  registerChannel({
    kind: 'msteams',
    id: 'msteams',
    capabilities: MSTEAMS_CAPABILITIES,
  });

  expect(getChannel('teams')?.kind).toBe('msteams');
});

test('getChannel returns undefined for unregistered and unknown channel kinds', async () => {
  const { getChannel } = await importFreshChannelRegistryModules();

  expect(getChannel('discord')).toBeUndefined();
  expect(getChannel('teams')).toBeUndefined();
  expect(getChannel('unknown')).toBeUndefined();
  expect(getChannel('api')).toBeUndefined();
  expect(getChannel('cli')).toBeUndefined();
  expect(getChannel('web')).toBeUndefined();
  expect(getChannel('irc')).toBeUndefined();
});

test('listChannels returns registered channels', async () => {
  const {
    EMAIL_CAPABILITIES,
    WHATSAPP_CAPABILITIES,
    listChannels,
    registerChannel,
  } = await importFreshChannelRegistryModules();

  registerChannel({
    kind: 'email',
    id: 'ops@example.com',
    capabilities: EMAIL_CAPABILITIES,
  });
  registerChannel({
    kind: 'whatsapp',
    id: 'whatsapp',
    capabilities: WHATSAPP_CAPABILITIES,
  });

  const registeredKinds = listChannels().map((channel) => channel.kind);
  expect(registeredKinds).toEqual(['email', 'whatsapp']);
});

test('capability presets match expected defaults', async () => {
  const {
    DISCORD_CAPABILITIES,
    EMAIL_CAPABILITIES,
    SYSTEM_CAPABILITIES,
    TUI_CAPABILITIES,
    WHATSAPP_CAPABILITIES,
  } = await importFreshChannelRegistryModules();

  expect(DISCORD_CAPABILITIES.maxMessageLength).toBe(2_000);
  expect(DISCORD_CAPABILITIES.typing).toBe(true);
  expect(WHATSAPP_CAPABILITIES.attachments).toBe(true);
  expect(WHATSAPP_CAPABILITIES.threads).toBe(false);
  expect(TUI_CAPABILITIES).toBe(SYSTEM_CAPABILITIES);
  expect(EMAIL_CAPABILITIES.attachments).toBe(true);
  expect(EMAIL_CAPABILITIES.reactions).toBe(false);
});
