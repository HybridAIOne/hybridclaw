/**
 * whatsapp proactive delivery reports transport failures to the gateway.
 * Target validation and quiet-hour queues belong to proactive-dispatch;
 * this sender neither reclassifies targets nor falls back to a local inbox.
 */
import { logger } from '../../logger.js';
import type { ArtifactMetadata } from '../../types/execution.js';
import type { ProactiveDeliveryOutcome } from '../channel-descriptor.js';
import { getWhatsAppAuthStatus } from './auth.js';
import {
  isWhatsAppTransportInstalled,
  sendToWhatsAppChat,
  WHATSAPP_PLUGIN_INSTALL_HINT,
} from './runtime.js';

export async function sendProactive(
  channelId: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
): Promise<ProactiveDeliveryOutcome> {
  const artifactCount = artifacts?.length ?? 0;
  if (!isWhatsAppTransportInstalled()) {
    logger.warn(
      { source, channelId },
      `Proactive WhatsApp message suppressed: transport plugin is not installed. ${WHATSAPP_PLUGIN_INSTALL_HINT}`,
    );
    return { status: 'failed', reason: 'transport plugin is not installed' };
  }
  const whatsappAuth = await getWhatsAppAuthStatus();
  if (!whatsappAuth.linked) {
    return { status: 'failed', reason: 'WhatsApp not linked' };
  }
  if (artifactCount > 0) {
    logger.warn(
      { source, channelId, artifactCount },
      'Proactive WhatsApp delivery currently sends text only',
    );
  }
  await sendToWhatsAppChat(channelId, text);
  return { status: 'delivered' };
}
