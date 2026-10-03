/**
 * discord-webhook gateway integration preserves transport-specific replies and proactive delivery.
 * The descriptor selects targets and lifecycle; this module connects the runtime
 * to execution without starting it on import or owning queue policy.
 */
import { getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import { hasDiscordWebhookTargets, initDiscordWebhook } from './runtime.js';

export async function startDiscordWebhookIntegration(): Promise<boolean> {
  const config = getConfigSnapshot().discordWebhook;

  if (!config.enabled) {
    logger.info(
      'Discord webhook channel disabled: discordWebhook.enabled=false',
    );
    return false;
  }
  if (!hasDiscordWebhookTargets()) {
    logger.info(
      'Discord webhook channel disabled: discordWebhook.webhooks.default is not configured',
    );
    return false;
  }

  try {
    await initDiscordWebhook();
  } catch (error) {
    logger.warn({ error }, 'Discord webhook channel failed to start');
    return false;
  }

  logger.info('Discord webhook channel started inside gateway');
  return true;
}
