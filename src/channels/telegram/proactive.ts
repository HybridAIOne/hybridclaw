/**
 * telegram proactive delivery reports transport failures to the gateway.
 * Target validation and quiet-hour queues belong to proactive-dispatch;
 * this sender neither reclassifies targets nor falls back to a local inbox.
 */
import { getConfigSnapshot } from '../../config/config.js';
import type { ArtifactMetadata } from '../../types/execution.js';
import type { ProactiveDeliveryOutcome } from '../channel-descriptor.js';
import {
  hasTelegramBotToken,
  sendTelegramMediaToChat,
  sendToTelegramChat,
} from './runtime.js';

export async function sendProactive(
  channelId: string,
  text: string,
  _source: string,
  artifacts?: ArtifactMetadata[],
): Promise<ProactiveDeliveryOutcome> {
  const telegramConfig = getConfigSnapshot().telegram;
  const hasBotToken = hasTelegramBotToken();
  if (!telegramConfig.enabled || !hasBotToken) {
    return { status: 'failed', reason: 'Telegram channel is not configured' };
  }

  if (text.trim()) {
    await sendToTelegramChat(channelId, text);
  }
  for (const artifact of artifacts || []) {
    await sendTelegramMediaToChat({
      target: channelId,
      filePath: artifact.path,
      mimeType: artifact.mimeType,
      filename: artifact.filename,
    });
  }
  return { status: 'delivered' };
}
