/**
 * slack-webhook gateway integration preserves transport-specific replies and proactive delivery.
 * The descriptor selects targets and lifecycle; this module connects the runtime
 * to execution without starting it on import or owning queue policy.
 */
import { getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import { hasSlackWebhookTargets, initSlackWebhook } from './runtime.js';

export async function startSlackWebhookIntegration(): Promise<boolean> {
  const config = getConfigSnapshot().slackWebhook;

  if (!config.enabled) {
    logger.info('Slack webhook channel disabled: slackWebhook.enabled=false');
    return false;
  }
  if (!hasSlackWebhookTargets()) {
    logger.info(
      'Slack webhook channel disabled: slackWebhook.webhooks.default is not configured',
    );
    return false;
  }

  try {
    await initSlackWebhook();
  } catch (error) {
    logger.warn({ error }, 'Slack webhook channel failed to start');
    return false;
  }

  logger.info('Slack webhook channel started inside gateway');
  return true;
}
