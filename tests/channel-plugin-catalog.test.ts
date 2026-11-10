import { afterEach, expect, it } from 'vitest';
import { getPluginChannelCoreFacts } from '../src/channels/channel-plugin-catalog.js';
import { unregisterChannelTransport } from '../src/channels/channel-transport.js';
import { PLUGIN_CHANNEL_DESCRIPTORS } from '../src/channels/plugin-channel/descriptor.js';

// Without its plugin, core keeps classifying the WhatsApp ids sessions store
// and the message-tool syntax the plugin claims, so absence never reroutes
// them. The table mirrors hybridclaw-whatsapp's matchesTarget/normalizeTarget.
const whatsapp = getPluginChannelCoreFacts('whatsapp');

afterEach(() => {
  unregisterChannelTransport('whatsapp');
});

it.each([
  ['491701234567@s.whatsapp.net', true, true],
  ['491701234567:7@s.whatsapp.net', true, true],
  ['whatsapp:491701234567@s.whatsapp.net', true, true],
  ['WhatsApp: 491701234567@s.whatsapp.net', true, true],
  ['123456@lid', true, true],
  ['123456:3@hosted.lid', true, true],
  ['123456-789@g.us', true, true],
  ['whatsapp:123456-789@g.us', true, true],
  ['1::2@s.whatsapp.net', false, false],
  ['abc@s.whatsapp.net', false, false],
  ['491701234567@c.us', false, false],
  ['user@example.com', false, false],
  ['line:uaaaa', false, false],
  ['+491701234567', false, true],
  ['+49 170 1234567', false, true],
  ['(+49) 170-123-4567', false, true],
  ['491701234567', false, true],
  ['whatsapp:+491701234567', false, true],
  ['0170 1234567', false, false],
  ['12345', false, false],
  ['signal:+491701234567', false, false],
  ['telegram:123456789', false, false],
  ['tui', false, false],
  // Malformed `whatsapp:` targets still fail with the install hint.
  ['whatsapp:not-a-number', false, true],
] as const)('without the plugin, %s is stored=%s and claimed=%s', (id, stored, claimed) => {
  expect(PLUGIN_CHANNEL_DESCRIPTORS.whatsapp.matchesTarget(id)).toBe(stored);
  expect(whatsapp.isStoredTarget(id)).toBe(stored);
  expect(whatsapp.claimsToolTarget(id)).toBe(claimed);
});
