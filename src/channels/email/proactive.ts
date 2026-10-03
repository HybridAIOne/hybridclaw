/**
 * email proactive delivery reports transport failures to the gateway.
 * Target validation and quiet-hour queues belong to proactive-dispatch;
 * this sender neither reclassifies targets nor falls back to a local inbox.
 */
import { EMAIL_PASSWORD, getConfigSnapshot } from '../../config/config.js';
import type { ArtifactMetadata } from '../../types/execution.js';
import type { ProactiveDeliveryOutcome } from '../channel-descriptor.js';
import { emailRuntimeLoader } from '../channel-runtime-loaders.js';

export async function sendProactive(
  channelId: string,
  text: string,
  _source: string,
  artifacts?: ArtifactMetadata[],
): Promise<ProactiveDeliveryOutcome> {
  if (
    !getConfigSnapshot().email.enabled ||
    !String(EMAIL_PASSWORD || '').trim()
  ) {
    return { status: 'failed', reason: 'email channel is not configured' };
  }

  const email = await emailRuntimeLoader.load();
  if (artifacts && artifacts.length > 0) {
    await email.sendEmailAttachmentTo({
      to: channelId,
      filePath: artifacts[0].path,
      body: text,
      mimeType: artifacts[0].mimeType,
      filename: artifacts[0].filename,
    });
    for (let index = 1; index < artifacts.length; index += 1) {
      await email.sendEmailAttachmentTo({
        to: channelId,
        filePath: artifacts[index].path,
        mimeType: artifacts[index].mimeType,
        filename: artifacts[index].filename,
      });
    }
    return { status: 'delivered' };
  }

  await email.sendToEmail(channelId, text);
  return { status: 'delivered' };
}
