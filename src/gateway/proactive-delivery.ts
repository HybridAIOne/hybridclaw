import { isDiscordWebhookChannelTarget } from '../channels/discord-webhook/target.js';
import { isEmailAddress as isNormalizedEmailAddress } from '../channels/email/allowlist.js';
import { isIMessageHandle } from '../channels/imessage/handle.js';
import { isLineChannelId } from '../channels/line/target.js';
import { isSlackChannelTarget } from '../channels/slack/target.js';
import { isSlackWebhookChannelTarget } from '../channels/slack-webhook/target.js';
import { isTelegramChannelId } from '../channels/telegram/target.js';
import { isThreemaChannelId } from '../channels/threema/target.js';
import { isWhatsAppJid } from '../channels/whatsapp/phone.js';
import type { QueuedProactiveMessage } from '../memory/db.js';

const DISCORD_CHANNEL_ID_RE = /^\d{16,22}$/;
const LOCAL_PROACTIVE_PULL_CHANNEL_IDS = new Set(['tui']);

export function isLocalProactivePullChannelId(channelId: string): boolean {
  return LOCAL_PROACTIVE_PULL_CHANNEL_IDS.has(channelId.trim());
}

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
  if (isLineChannelId(trimmed)) return true;
  if (isIMessageHandle(trimmed)) return true;
  if (isDiscordWebhookChannelTarget(trimmed)) return true;
  if (isSlackWebhookChannelTarget(trimmed)) return true;
  if (isSlackChannelTarget(trimmed)) return true;
  if (isTelegramChannelId(trimmed)) return true;
  if (isThreemaChannelId(trimmed)) return true;
  if (isEmailAddress(trimmed)) return true;
  return isLocalProactivePullChannelId(trimmed);
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
