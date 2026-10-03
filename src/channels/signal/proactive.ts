/**
 * signal proactive delivery reports transport failures to the gateway.
 * Target validation and quiet-hour queues belong to proactive-dispatch;
 * this sender neither reclassifies targets nor falls back to a local inbox.
 */
import { getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import type { ArtifactMetadata } from '../../types/execution.js';
import type { ProactiveDeliveryOutcome } from '../channel-descriptor.js';
import { sendToSignalChat } from './runtime.js';

export async function sendProactive(
  channelId: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
): Promise<ProactiveDeliveryOutcome> {
  const artifactCount = artifacts?.length ?? 0;
  const signalConfig = getConfigSnapshot().signal;
  if (
    !signalConfig.enabled ||
    !signalConfig.daemonUrl ||
    !signalConfig.account
  ) {
    return { status: 'failed', reason: 'Signal channel is not configured' };
  }

  if (text.trim()) {
    await sendToSignalChat(channelId, text);
  }
  if (artifactCount > 0) {
    logger.warn(
      { source, channelId, artifactCount },
      'Signal channel does not yet support proactive attachments; dropping artifacts',
    );
  }
  return { status: 'delivered' };
}
