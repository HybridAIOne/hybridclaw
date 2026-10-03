/**
 * line proactive delivery reports transport failures to the gateway.
 * Target validation and quiet-hour queues belong to proactive-dispatch;
 * this sender neither reclassifies targets nor falls back to a local inbox.
 */
import { logger } from '../../logger.js';
import type { ArtifactMetadata } from '../../types/execution.js';
import type { ProactiveDeliveryOutcome } from '../channel-descriptor.js';
import { getLineAuthStatus } from './auth.js';
import {
  isLineTransportInstalled,
  LINE_PLUGIN_INSTALL_HINT,
  sendToLineSelfChat,
} from './runtime.js';

export async function sendProactive(
  channelId: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
): Promise<ProactiveDeliveryOutcome> {
  const artifactCount = artifacts?.length ?? 0;
  if (!isLineTransportInstalled()) {
    logger.warn(
      { source, channelId },
      `Proactive LINE message suppressed: transport plugin is not installed. ${LINE_PLUGIN_INSTALL_HINT}`,
    );
    return { status: 'failed', reason: 'transport plugin is not installed' };
  }
  const lineAuth = await getLineAuthStatus();
  if (!lineAuth.linked) {
    return { status: 'failed', reason: 'LINE not linked' };
  }
  if (artifactCount > 0) {
    logger.warn(
      { source, channelId, artifactCount },
      'Proactive LINE delivery currently sends text only',
    );
  }
  await sendToLineSelfChat(channelId, text);
  return { status: 'delivered' };
}
