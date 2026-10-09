import { afterEach, expect, it } from 'vitest';
import { getPluginChannelCoreFacts } from '../src/channels/channel-plugin-catalog.js';
import {
  registerChannelTransport,
  unregisterChannelTransport,
} from '../src/channels/channel-transport.js';
import { PLUGIN_CHANNEL_DESCRIPTORS } from '../src/channels/plugin-channel/descriptor.js';
import { adaptLegacyWhatsAppRegistration } from '../src/channels/whatsapp/legacy-registration.js';

// Without its plugin, core must classify WhatsApp targets exactly as the
// released plugin's adapted registration does, so absence never reroutes them.
const whatsapp = getPluginChannelCoreFacts('whatsapp');
const legacyWhatsApp = adaptLegacyWhatsAppRegistration({
  kind: 'whatsapp',
  create: () => {
    throw new Error('unused');
  },
});

afterEach(() => {
  unregisterChannelTransport('whatsapp');
});

const CANDIDATES = [
  '491701234567@s.whatsapp.net',
  '491701234567:7@s.whatsapp.net',
  'whatsapp:491701234567@s.whatsapp.net',
  'WhatsApp: 491701234567@s.whatsapp.net',
  '123456@lid',
  '123456:3@hosted.lid',
  '123456-789@g.us',
  'whatsapp:123456-789@g.us',
  '1::2@s.whatsapp.net',
  'abc@s.whatsapp.net',
  '491701234567@c.us',
  'user@example.com',
  'line:uaaaa',
  '+491701234567',
  '+49 170 1234567',
  '(+49) 170-123-4567',
  '491701234567',
  'whatsapp:+491701234567',
  '0170 1234567',
  '12345',
  'signal:+491701234567',
  'telegram:123456789',
  'tui',
];

it.each(
  CANDIDATES,
)('the descriptor classifies %s the same with and without the plugin', (id) => {
  const descriptor = PLUGIN_CHANNEL_DESCRIPTORS.whatsapp;
  const absent = descriptor.matchesTarget(id);
  registerChannelTransport(legacyWhatsApp);
  expect(absent).toBe(descriptor.matchesTarget(id));
  expect(whatsapp.isStoredTarget(id)).toBe(absent);
});

it.each(
  CANDIDATES,
)('without the plugin, the message tool claims %s exactly when the plugin would', (target) => {
  expect(whatsapp.claimsToolTarget(target)).toBe(
    legacyWhatsApp.normalizeTarget(target) !== null,
  );
});

it('still claims malformed whatsapp: targets so they fail with the install hint', () => {
  expect(legacyWhatsApp.normalizeTarget('whatsapp:not-a-number')).toBeNull();
  expect(whatsapp.claimsToolTarget('whatsapp:not-a-number')).toBe(true);
});
