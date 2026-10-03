/**
 * slack-webhook proactive delivery reports transport failures to the gateway.
 * Target validation and quiet-hour queues belong to proactive-dispatch;
 * this sender neither reclassifies targets nor falls back to a local inbox.
 */
import { getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import type { ArtifactMetadata } from '../../types/execution.js';
import type { ProactiveDeliveryOutcome } from '../channel-descriptor.js';
import { hasSlackWebhookTargets, sendToSlackWebhookTarget } from './runtime.js';

export async function sendProactive(
  channelId: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
): Promise<ProactiveDeliveryOutcome> {
  const artifactCount = artifacts?.length ?? 0;
  const config = getConfigSnapshot().slackWebhook;
  if (!config.enabled || !hasSlackWebhookTargets()) {
    return {
      status: 'failed',
      reason: 'Slack webhook channel is not configured',
    };
  }

  if (artifactCount > 0) {
    logger.warn(
      { source, channelId, artifactCount },
      'Slack webhook channel does not support proactive attachments; dropping artifacts',
    );
  }
  if (text.trim()) {
    await sendToSlackWebhookTarget(channelId, text);
  }
  return { status: 'delivered' };
}
