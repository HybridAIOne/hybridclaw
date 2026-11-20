import { beforeEach, expect, it, type Mock, vi } from 'vitest';
import {
  type ChannelTransportRegistration,
  hasChannelTransport,
  registerChannelTransport,
  unregisterChannelTransport,
} from '../src/channels/channel-transport.js';
import {
  createFakeTransportInstance,
  fakeWhatsAppRegistration,
} from './helpers/fake-channel-transport.js';
import { useCleanMocks } from './test-utils.js';

const state = vi.hoisted(() => ({
  dmPolicy: 'disabled',
  heartbeat: { enabled: true, channel: '' },
  lastChannel: null as string | null,
  pluginLoads: 0,
  doctorChecks: null as unknown as Mock<
    NonNullable<ChannelTransportRegistration['doctorChecks']>
  >,
}));

vi.mock('../src/config/config.js', () => ({
  // Any existing file: the session DB read itself is mocked below.
  DB_PATH: process.execPath,
  DISCORD_TOKEN: '',
  EMAIL_PASSWORD: '',
  MSTEAMS_APP_ID: '',
  MSTEAMS_APP_PASSWORD: '',
  TELEGRAM_BOT_TOKEN: '',
  THREEMA_GATEWAY_SECRET: '',
  getConfigSnapshot: () => ({
    discord: { guilds: {} },
    msteams: { enabled: false },
    email: { enabled: false },
    whatsapp: { dmPolicy: state.dmPolicy, groupPolicy: 'disabled' },
    line: { enabled: false },
    heartbeat: state.heartbeat,
  }),
}));
// Loading plugins is what registers the installed WhatsApp transport.
vi.mock('../src/plugins/plugin-manager.js', () => ({
  ensurePluginManagerInitialized: async () => {
    state.pluginLoads += 1;
    if (!hasChannelTransport('whatsapp')) {
      registerChannelTransport(
        fakeWhatsAppRegistration(createFakeTransportInstance(), {
          doctorChecks: state.doctorChecks,
        }),
      );
    }
    return {};
  },
}));
vi.mock('../src/memory/db.js', () => ({
  getMostRecentSessionChannelId: () => state.lastChannel,
}));

useCleanMocks();
beforeEach(() => {
  unregisterChannelTransport('whatsapp');
  state.pluginLoads = 0;
  state.doctorChecks = vi.fn(async () => [
    { severity: 'ok', message: 'WhatsApp linked' },
  ]);
});

it.each([
  [true, '1234567@s.whatsapp.net', null, '1234567@s.whatsapp.net'],
  [true, '', 'whatsapp:1234567@s.whatsapp.net', 'whatsapp:1234567@s.whatsapp.net'],
  [false, '1234567@s.whatsapp.net', '123456-789@g.us', '123456-789@g.us'],
  [true, '  1234567@s.whatsapp.net  ', 'tui', '1234567@s.whatsapp.net'],
] as const)(
  'passes the WhatsApp plugin heartbeat=%s target=%s recent=%s as %s',
  async (enabled, channel, lastChannel, deliveryTarget) => {
    Object.assign(state, { heartbeat: { enabled, channel }, lastChannel });
    const { checkChannels } = await import('../src/doctor/checks/channels.js');
    await checkChannels();
    expect(state.pluginLoads).toBe(1);
    expect(state.doctorChecks).toHaveBeenCalledWith({
      enabled: false,
      deliveryTarget,
    });
  },
);

it.each([
  [true, 'tui', '1234567@s.whatsapp.net'],
  [true, '', 'tui'],
  [true, '', null],
] as const)(
  'does not load plugins when heartbeat=%s target=%s recent=%s points elsewhere',
  async (enabled, channel, lastChannel) => {
    Object.assign(state, { heartbeat: { enabled, channel }, lastChannel });
    const { checkChannels } = await import('../src/doctor/checks/channels.js');
    await checkChannels();
    expect(state.pluginLoads).toBe(0);
    expect(state.doctorChecks).not.toHaveBeenCalled();
  },
);
