/**
 * discord proactive delivery reports transport failures to the gateway.
 * Target validation and quiet-hour queues belong to proactive-dispatch;
 * this sender neither reclassifies targets nor falls back to a local inbox.
 */
import { DISCORD_TOKEN } from '../../config/config.js';
import { buildArtifactAttachments } from '../../gateway/channel-message.js';
import type { ArtifactMetadata } from '../../types/execution.js';
import type { ProactiveDeliveryOutcome } from '../channel-descriptor.js';
import { discordRuntimeLoader } from '../channel-runtime-loaders.js';

export async function sendProactive(
  channelId: string,
  text: string,
  _source: string,
  artifacts?: ArtifactMetadata[],
): Promise<ProactiveDeliveryOutcome> {
  if (!DISCORD_TOKEN) {
    return { status: 'failed', reason: 'Discord is not configured' };
  }

  await (await discordRuntimeLoader.load()).sendToChannel(
    channelId,
    text,
    await buildArtifactAttachments(artifacts),
  );
  return { status: 'delivered' };
}
