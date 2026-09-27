import { expect, it, vi } from 'vitest';
import { WHATSAPP_SELF_CHAT_ADVISORY } from '../src/channels/whatsapp/self-chat.js';
import { useCleanMocks } from './test-utils.js';

const state = vi.hoisted(() => ({
  linked: true,
  installed: true,
  dmPolicy: 'disabled',
  heartbeat: { enabled: true, channel: '' },
  lastChannel: null as string | null,
}));

vi.mock('../src/config/config.js', () => ({
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
    heartbeat: state.heartbeat,
  }),
}));
vi.mock('../src/channels/whatsapp/auth.js', () => ({
  getWhatsAppAuthStatus: async () => ({ linked: state.linked }),
}));
vi.mock('../src/channels/whatsapp/runtime.js', () => ({
  isWhatsAppTransportInstalled: () => state.installed,
}));
vi.mock('../src/plugins/plugin-manager.js', () => ({
  ensurePluginManagerInitialized: async () => ({}),
}));
vi.mock('../src/memory/db.js', () => ({
  getMostRecentSessionChannelId: () => state.lastChannel,
}));

useCleanMocks();

it.each([
  [true, 'disabled', true, '1234567@s.whatsapp.net', null, true],
  [true, 'disabled', true, '', 'whatsapp:1234567@s.whatsapp.net', true],
  [true, 'disabled', false, '', '1234567@s.whatsapp.net', true],
  [true, 'disabled', true, 'tui', '1234567@s.whatsapp.net', false],
  [true, 'disabled', true, '', 'tui', false],
  [true, 'disabled', true, '', null, false],
  [false, 'disabled', true, '1234567@s.whatsapp.net', null, false],
  [true, 'allowlist', true, '1234567@s.whatsapp.net', null, false],
] as const)(
  'advises for linked=%s policy=%s heartbeat=%s target=%s recent=%s',
  async (linked, dmPolicy, enabled, channel, lastChannel, warn) => {
    Object.assign(state, {
      linked,
      dmPolicy,
      heartbeat: { enabled, channel },
      lastChannel,
    });
    const { checkChannels } = await import('../src/doctor/checks/channels.js');
    const [result] = await checkChannels();
    expect(result.severity).toBe(warn ? 'warn' : 'ok');
    expect(result.message.includes(WHATSAPP_SELF_CHAT_ADVISORY)).toBe(warn);
    expect(result.fixable).toBeFalsy();
  },
);
