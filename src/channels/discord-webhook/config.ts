import { getConfigSnapshot } from '../../config/config.js';
import { DISCORD_WEBHOOK_DEFAULT_TARGET } from './target.js';

type DiscordWebhookConfig = ReturnType<
  typeof getConfigSnapshot
>['discordWebhook'];

export function resolveDiscordWebhookConfig(options?: {
  requireDefaultTarget?: boolean;
  requireEnabled?: boolean;
}): DiscordWebhookConfig {
  const config = getConfigSnapshot().discordWebhook;
  if (options?.requireEnabled && !config.enabled) {
    throw new Error('Discord webhook channel is disabled.');
  }
  if (
    options?.requireDefaultTarget &&
    !config.webhooks[DISCORD_WEBHOOK_DEFAULT_TARGET]?.webhookUrl
  ) {
    throw new Error('Discord webhook default target is not configured.');
  }
  return config;
}
