/**
 * threema proactive delivery reports transport failures to the gateway.
 * Target validation and quiet-hour queues belong to proactive-dispatch;
 * this sender neither reclassifies targets nor falls back to a local inbox.
 */
import { getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import type { ArtifactMetadata } from '../../types/execution.js';
import type { ProactiveDeliveryOutcome } from '../channel-descriptor.js';
import { hasThreemaGatewaySecret, sendToThreemaChat } from './runtime.js';

export async function sendProactive(
  channelId: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
): Promise<ProactiveDeliveryOutcome> {
  const artifactCount = artifacts?.length ?? 0;
  const threemaConfig = getConfigSnapshot().threema;
  const hasSecret = hasThreemaGatewaySecret();
  if (
    !threemaConfig.enabled ||
    threemaConfig.dmPolicy === 'disabled' ||
    !threemaConfig.identity ||
    !hasSecret
  ) {
    return {
      status: 'failed',
      reason: 'Threema channel is not configured or is disabled',
    };
  }

  if (text.trim()) {
    await sendToThreemaChat(channelId, text);
  }
  if (artifactCount > 0) {
    logger.warn(
      { source, channelId, artifactCount },
      'Threema channel does not support proactive attachments; dropping artifacts',
    );
  }
  return { status: 'delivered' };
}
