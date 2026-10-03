/**
 * Discord channel facts are defined here for target and lifecycle dispatch.
 * Unlike the runtime, this descriptor stays cheap to import and never starts
 * a channel merely because a caller classifies a target.
 */
import type { ChannelDescriptor } from '../channel-descriptor.js';
import { discordRuntimeLoader } from '../channel-runtime-loaders.js';

export function isDiscordChannelId(target: string): boolean {
  return /^\d{16,22}$/.test(target);
}

export const descriptor = {
  kind: 'discord',
  matchesTarget: isDiscordChannelId,
  supportsProactive: true,
  sendProactive: async (...args) =>
    (await import('./proactive.js')).sendProactive(...args),
  start: async () => (await import('./gateway.js')).startDiscordIntegration(),
  stop: discordRuntimeLoader.stop,
  configChanged: () => false,
} satisfies ChannelDescriptor;
