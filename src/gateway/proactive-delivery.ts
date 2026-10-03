import { getChannelDescriptorForTarget } from '../channels/channel-descriptors.js';
import { isEmailAddress as isNormalizedEmailAddress } from '../channels/email/allowlist.js';
import type { QueuedProactiveMessage } from '../memory/db.js';

export { isDiscordChannelId } from '../channels/discord/descriptor.js';

const LOCAL_PROACTIVE_PULL_CHANNEL_IDS = new Set(['tui']);

export function isLocalProactivePullChannelId(channelId: string): boolean {
  return LOCAL_PROACTIVE_PULL_CHANNEL_IDS.has(channelId.trim());
}

export function isEmailAddress(channelId: string): boolean {
  return isNormalizedEmailAddress(channelId.trim());
}

export function isSupportedProactiveChannelId(channelId: string): boolean {
  return (
    isLocalProactivePullChannelId(channelId) ||
    (getChannelDescriptorForTarget(channelId)?.supportsProactive ?? false)
  );
}

export function hasQueuedProactiveDeliveryPath(
  item: Pick<QueuedProactiveMessage, 'channel_id'>,
): boolean {
  return isSupportedProactiveChannelId(item.channel_id);
}

export function hasImmediateProactiveDeliveryPath(
  item: Pick<QueuedProactiveMessage, 'channel_id'>,
): boolean {
  return (
    isSupportedProactiveChannelId(item.channel_id) &&
    !isLocalProactivePullChannelId(item.channel_id)
  );
}

export function resolveHeartbeatDeliveryChannelId(params: {
  explicitChannelId: string;
  lastUsedChannelId: string | null;
}): string | null {
  const explicitChannelId = params.explicitChannelId.trim();
  if (explicitChannelId) return explicitChannelId;
  return params.lastUsedChannelId;
}

export function isHeartbeatOkText(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/[^a-z]/gi, '')
    .toUpperCase();
  return normalized === 'HEARTBEATOK' || normalized.startsWith('HEARTBEATOK');
}

export function shouldSuppressProactiveMessage(
  item: Pick<QueuedProactiveMessage, 'source' | 'text'>,
): boolean {
  return item.source === 'heartbeat' && isHeartbeatOkText(item.text);
}

export function shouldDropQueuedProactiveMessage(
  item: Pick<QueuedProactiveMessage, 'channel_id' | 'source'> &
    Partial<Pick<QueuedProactiveMessage, 'text'>>,
): boolean {
  if (!hasQueuedProactiveDeliveryPath(item)) return true;
  if (
    item.text != null &&
    shouldSuppressProactiveMessage({ source: item.source, text: item.text })
  )
    return true;
  return item.source === 'heartbeat' && item.channel_id === 'heartbeat';
}
