/**
 * imessage proactive delivery reports transport failures to the gateway.
 * Target validation and quiet-hour queues belong to proactive-dispatch;
 * this sender neither reclassifies targets nor falls back to a local inbox.
 */
import { getConfigSnapshot } from '../../config/config.js';
import type { ArtifactMetadata } from '../../types/execution.js';
import type { ProactiveDeliveryOutcome } from '../channel-descriptor.js';
import { sendIMessageMediaToChat, sendToIMessageChat } from './runtime.js';

export async function sendProactive(
  channelId: string,
  text: string,
  _source: string,
  artifacts?: ArtifactMetadata[],
): Promise<ProactiveDeliveryOutcome> {
  if (!getConfigSnapshot().imessage.enabled) {
    return { status: 'failed', reason: 'iMessage channel is not configured' };
  }
  if (artifacts && artifacts.length > 0) {
    await sendIMessageMediaToChat({
      target: channelId,
      filePath: artifacts[0].path,
      mimeType: artifacts[0].mimeType,
      filename: artifacts[0].filename,
      caption: text,
    });
    for (let index = 1; index < artifacts.length; index += 1) {
      await sendIMessageMediaToChat({
        target: channelId,
        filePath: artifacts[index].path,
        mimeType: artifacts[index].mimeType,
        filename: artifacts[index].filename,
      });
    }
    return { status: 'delivered' };
  }

  await sendToIMessageChat(channelId, text);
  return { status: 'delivered' };
}
