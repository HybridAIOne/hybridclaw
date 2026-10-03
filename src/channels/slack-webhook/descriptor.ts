/**
 * SlackWebhook channel facts are defined here for target and lifecycle dispatch.
 * Unlike the runtime, this descriptor stays cheap to import and never starts
 * a channel merely because a caller classifies a target.
 */

import type { RuntimeConfig } from '../../config/runtime-config.js';
import { equalStringSets } from '../../utils/string-list-equality.js';
import type { ChannelDescriptor } from '../channel-descriptor.js';
import { isSlackWebhookChannelTarget } from './target.js';

function hasSlackWebhookConfigChanged(
  next: RuntimeConfig['slackWebhook'],
  prev: RuntimeConfig['slackWebhook'],
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
      nextWebhook.defaultIconEmoji !== prevWebhook.defaultIconEmoji ||
      nextWebhook.defaultIconUrl !== prevWebhook.defaultIconUrl
    ) {
      return true;
    }
  }
  return false;
}

export const descriptor = {
  kind: 'slack_webhook',
  matchesTarget: isSlackWebhookChannelTarget,
  supportsProactive: true,
  sendProactive: async (...args) =>
    (await import('./proactive.js')).sendProactive(...args),
  start: async () =>
    (await import('./gateway.js')).startSlackWebhookIntegration(),
  stop: async () => (await import('./runtime.js')).shutdownSlackWebhook(),
  configChanged: (next, prev) =>
    hasSlackWebhookConfigChanged(next.slackWebhook, prev.slackWebhook),
} satisfies ChannelDescriptor;
