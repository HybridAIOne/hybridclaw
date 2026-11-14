import { afterEach, expect, it } from 'vitest';
import { getPluginChannelCoreFacts } from '../src/channels/channel-plugin-catalog.js';
import {
  registerChannelTransport,
  unregisterChannelTransport,
} from '../src/channels/channel-transport.js';
import { PLUGIN_CHANNEL_DESCRIPTORS } from '../src/channels/plugin-channel/descriptor.js';
import { fakeWhatsAppRegistration } from './helpers/fake-channel-transport.js';

const whatsapp = getPluginChannelCoreFacts('whatsapp');
const registration = fakeWhatsAppRegistration();

afterEach(() => {
  unregisterChannelTransport('whatsapp');
});

it.each([
  ['491701234567@s.whatsapp.net', true, true],
  ['491701234567:7@s.whatsapp.net', true, true],
  ['WhatsApp: 491701234567@s.whatsapp.net', true, true],
  ['123456@lid', true, true],
  ['123456:3@hosted.lid', true, true],
  ['123456-789@g.us', true, true],
  ['whatsapp:123456-789@g.us', true, true],
  ['+49 170 1234567', false, true],
  ['(+49) 170-123-4567', false, true],
  ['491701234567', false, true],
  ['whatsapp:not-a-number', false, true],
  ['1::2@s.whatsapp.net', false, false],
  ['abc@s.whatsapp.net', false, false],
  ['491701234567@c.us', false, false],
  ['user@example.com', false, false],
  ['0170 1234567', false, false],
  ['12345', false, false],
  ['signal:+491701234567', false, false],
  ['telegram:123456789', false, false],
  ['tui', false, false],
] as const)(
  'routes %s when the plugin is absent',
  (target, stored, claimed) => {
    expect(PLUGIN_CHANNEL_DESCRIPTORS.whatsapp.matchesTarget(target)).toBe(
      stored,
    );
    expect(whatsapp.claimsToolTarget(target)).toBe(claimed);
  },
);

it('uses the registered transport to classify stored targets', () => {
  registerChannelTransport({
    ...registration,
    matchesTarget: (id) => id === 'fixture-target',
  });
  expect(
    PLUGIN_CHANNEL_DESCRIPTORS.whatsapp.matchesTarget('fixture-target'),
  ).toBe(true);
  expect(PLUGIN_CHANNEL_DESCRIPTORS.whatsapp.matchesTarget('123456@lid')).toBe(
    false,
  );
});
