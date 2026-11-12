import { beforeEach, expect, it, vi } from 'vitest';
import {
  hasChannelTransport,
  registerChannelTransport,
  unregisterChannelTransport,
} from '../src/channels/channel-transport.js';
import { fakeWhatsAppRegistration } from './helpers/fake-channel-transport.js';
import { useCleanMocks } from './test-utils.js';

const state = vi.hoisted(() => ({
  doctorChecks: vi.fn(async () => [
    { severity: 'warn' as const, message: 'fixture advisory' },
  ]),
  dmPolicy: 'disabled',
  groupPolicy: 'disabled',
  heartbeat: { enabled: true, channel: '' },
  lastChannel: null as string | null,
  pluginLoads: 0,
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
    whatsapp: { dmPolicy: state.dmPolicy, groupPolicy: state.groupPolicy },
    line: { enabled: false },
    heartbeat: state.heartbeat,
  }),
}));
// Loading plugins is what registers the installed WhatsApp transport, so the
// advisory only appears when doctor decides to load them.
vi.mock('../src/plugins/plugin-manager.js', () => ({
  ensurePluginManagerInitialized: async () => {
    state.pluginLoads += 1;
    if (!hasChannelTransport('whatsapp')) {
      registerChannelTransport({
        ...fakeWhatsAppRegistration(),
        doctorChecks: state.doctorChecks,
      });
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
});

it.each([
  [true, '1234567@s.whatsapp.net', null, '1234567@s.whatsapp.net'],
  [
    true,
    '',
    'whatsapp:1234567@s.whatsapp.net',
    'whatsapp:1234567@s.whatsapp.net',
  ],
  [false, 'tui', '123456-789@g.us', '123456-789@g.us'],
] as const)(
  'forwards the delivery target to the plugin for heartbeat=%s channel=%s recent=%s',
  async (enabled, channel, lastChannel, target) => {
    Object.assign(state, {
      dmPolicy: 'disabled',
      groupPolicy: 'disabled',
      heartbeat: { enabled, channel },
      lastChannel,
    });
    const { checkChannels } = await import('../src/doctor/checks/channels.js');
    const [result] = await checkChannels();
    expect(state.doctorChecks).toHaveBeenCalledWith({
      enabled: false,
      deliveryTarget: target,
    });
    expect(result.severity).toBe('warn');
    expect(result.message).toContain('fixture advisory');
  },
);

it('does not load plugins when nothing points at a plugin channel', async () => {
  Object.assign(state, {
    dmPolicy: 'disabled',
    groupPolicy: 'disabled',
    heartbeat: { enabled: true, channel: 'tui' },
    lastChannel: '1234567@s.whatsapp.net',
  });
  const { checkChannels } = await import('../src/doctor/checks/channels.js');
  await checkChannels();
  expect(state.pluginLoads).toBe(0);
});
