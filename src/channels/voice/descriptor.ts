/**
 * Voice channel facts are defined here for target classification only.
 *
 * Phone calls arrive through transport plugins (`twilio-voice`,
 * `vonage-voice`) that register their own webhooks and stop with the plugin
 * runtime, so core starts and stops nothing here. `voice:<call-id>` targets
 * still classify as the `voice` channel for prompts, capabilities, and
 * channel instructions. Not a proactive delivery path: calls cannot be
 * messaged after they end.
 */

import type { ChannelDescriptor } from '../channel-descriptor.js';

const VOICE_CHANNEL_PREFIX = 'voice:';

export const descriptor = {
  kind: 'voice',
  matchesTarget: (target) => target.trim().startsWith(VOICE_CHANNEL_PREFIX),
  supportsProactive: false,

  start: async () =>
    (
      await import('./twilio-plugin-notice.js')
    ).warnIfTwilioVoicePluginMissing(),
  stop: async () => {},
  configChanged: () => false,
} satisfies ChannelDescriptor;
