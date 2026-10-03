/**
 * Voice channel facts are defined here for target and lifecycle dispatch.
 * Unlike the runtime, this descriptor stays cheap to import and never starts
 * a channel merely because a caller classifies a target.
 */

import type { RuntimeConfig } from '../../config/runtime-config.js';
import type { ChannelDescriptor } from '../channel-descriptor.js';
import { isVoiceChannelId } from './channel-id.js';

function hasVoiceConfigChanged(
  next: RuntimeConfig['voice'],
  prev: RuntimeConfig['voice'],
): boolean {
  return (
    next.enabled !== prev.enabled ||
    next.provider !== prev.provider ||
    next.twilio.accountSid !== prev.twilio.accountSid ||
    next.twilio.fromNumber !== prev.twilio.fromNumber ||
    next.relay.ttsProvider !== prev.relay.ttsProvider ||
    next.relay.voice !== prev.relay.voice ||
    next.relay.transcriptionProvider !== prev.relay.transcriptionProvider ||
    next.relay.language !== prev.relay.language ||
    next.relay.interruptible !== prev.relay.interruptible ||
    next.relay.welcomeGreeting !== prev.relay.welcomeGreeting ||
    next.webhookPath !== prev.webhookPath ||
    next.maxConcurrentCalls !== prev.maxConcurrentCalls
  );
}

export const descriptor = {
  kind: 'voice',
  matchesTarget: isVoiceChannelId,
  supportsProactive: false,

  start: async () => (await import('./gateway.js')).startVoiceIntegration(),
  stop: async (options) =>
    (await import('./runtime.js')).shutdownVoice(options),
  configChanged: (next, prev) => hasVoiceConfigChanged(next.voice, prev.voice),
} satisfies ChannelDescriptor;
