import type { QueuedProactiveMessage } from '../memory/db.js';

const DISCORD_CHANNEL_ID_RE = /^\d{16,22}$/;

export function isDiscordChannelId(channelId: string): boolean {
  return DISCORD_CHANNEL_ID_RE.test(channelId);
}

export function resolveHeartbeatDeliveryChannelId(params: {
  explicitChannelId: string;
  lastUsedDiscordChannelId: string | null;
}): string | null {
  const explicitChannelId = params.explicitChannelId.trim();
  if (explicitChannelId) return explicitChannelId;
  return params.lastUsedDiscordChannelId;
}

export function shouldDropQueuedProactiveMessage(
  item: Pick<QueuedProactiveMessage, 'channel_id' | 'source'>,
): boolean {
  return item.source === 'heartbeat' && item.channel_id === 'heartbeat';
}
