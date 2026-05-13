import { getConfigSnapshot } from '../../config/config.js';
import { SLACK_WEBHOOK_DEFAULT_TARGET } from './target.js';

type SlackWebhookConfig = ReturnType<typeof getConfigSnapshot>['slackWebhook'];

export function resolveSlackWebhookConfig(options?: {
  requireDefaultTarget?: boolean;
  requireEnabled?: boolean;
}): SlackWebhookConfig {
  const config = getConfigSnapshot().slackWebhook;
  if (options?.requireEnabled && !config.enabled) {
    throw new Error('Slack webhook channel is disabled.');
  }
  if (
    options?.requireDefaultTarget &&
    !config.webhooks[SLACK_WEBHOOK_DEFAULT_TARGET]?.webhookUrl
  ) {
    throw new Error('Slack webhook default target is not configured.');
  }
  return config;
}
