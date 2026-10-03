/**
 * DiscordWebhook channel facts are defined here for target and lifecycle dispatch.
 * Unlike the runtime, this descriptor stays cheap to import and never starts
 * a channel merely because a caller classifies a target.
 */

import type { RuntimeConfig } from '../../config/runtime-config.js';
import { equalStringSets } from '../../utils/string-list-equality.js';
import type { ChannelDescriptor } from '../channel-descriptor.js';
import { isDiscordWebhookChannelTarget } from './target.js';

function hasDiscordWebhookConfigChanged(
  next: RuntimeConfig['discordWebhook'],
  prev: RuntimeConfig['discordWebhook'],
): boolean {
  if (next.enabled !== prev.enabled) return true;
  const nextTargets = Object.keys(next.webhooks);
  const prevTargets = Object.keys(prev.webhooks);
  if (!equalStringSets(nextTargets, prevTargets)) return true;

  for (const target of nextTargets) {
    const nextWebhook = next.webhooks[target];
    const prevWebhook = prev.webhooks[target];
    if (!nextWebhook || !prevWebhook) return true;
    if (
      nextWebhook.webhookUrl !== prevWebhook.webhookUrl ||
      nextWebhook.defaultUsername !== prevWebhook.defaultUsername ||
      nextWebhook.defaultAvatarUrl !== prevWebhook.defaultAvatarUrl
    ) {
      return true;
    }
  }
  return false;
}

export const descriptor = {
  kind: 'discord_webhook',
  matchesTarget: isDiscordWebhookChannelTarget,
  supportsProactive: true,
  sendProactive: async (...args) =>
    (await import('./proactive.js')).sendProactive(...args),
  start: async () =>
    (await import('./gateway.js')).startDiscordWebhookIntegration(),
  stop: async () => (await import('./runtime.js')).shutdownDiscordWebhook(),
  configChanged: (next, prev) =>
    hasDiscordWebhookConfigChanged(next.discordWebhook, prev.discordWebhook),
} satisfies ChannelDescriptor;
