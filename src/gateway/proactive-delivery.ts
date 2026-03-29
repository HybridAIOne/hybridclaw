import { isEmailAddress as isNormalizedEmailAddress } from '../channels/email/allowlist.js';
import { isIMessageHandle } from '../channels/imessage/handle.js';
import { isWhatsAppJid } from '../channels/whatsapp/phone.js';
import type { QueuedProactiveMessage } from '../memory/db.js';

const DISCORD_CHANNEL_ID_RE = /^\d{16,22}$/;
const LOCAL_PROACTIVE_PULL_CHANNEL_IDS = new Set(['tui']);

export function isDiscordChannelId(channelId: string): boolean {
  return DISCORD_CHANNEL_ID_RE.test(channelId);
}

export function isEmailAddress(channelId: string): boolean {
  return isNormalizedEmailAddress(channelId.trim());
}

export function isSupportedProactiveChannelId(channelId: string): boolean {
  const trimmed = channelId.trim();
  if (!trimmed) return false;
  if (isDiscordChannelId(trimmed)) return true;
  if (isWhatsAppJid(trimmed)) return true;
  if (isIMessageHandle(trimmed)) return true;
  if (isEmailAddress(trimmed)) return true;
  return LOCAL_PROACTIVE_PULL_CHANNEL_IDS.has(trimmed);
}

export function hasQueuedProactiveDeliveryPath(
  item: Pick<QueuedProactiveMessage, 'channel_id'>,
): boolean {
  return isSupportedProactiveChannelId(item.channel_id);
}

export function resolveHeartbeatDeliveryChannelId(params: {
  explicitChannelId: string;
  lastUsedChannelId: string | null;
}): string | null {
  const explicitChannelId = params.explicitChannelId.trim();
  if (explicitChannelId) return explicitChannelId;
  return params.lastUsedChannelId;
}

export function shouldDropQueuedProactiveMessage(
  item: Pick<QueuedProactiveMessage, 'channel_id' | 'source'>,
): boolean {
  if (!hasQueuedProactiveDeliveryPath(item)) return true;
  return item.source === 'heartbeat' && item.channel_id === 'heartbeat';
}
