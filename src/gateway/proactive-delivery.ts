import { getChannelDescriptorForTarget } from '../channels/channel-descriptors.js';
import { isEmailAddress as isNormalizedEmailAddress } from '../channels/email/allowlist.js';
import type { QueuedProactiveMessage } from '../memory/db.js';

export { isDiscordChannelId } from '../channels/discord/descriptor.js';

const LOCAL_PROACTIVE_PULL_CHANNEL_IDS = new Set(['tui']);

export function isLocalProactivePullChannelId(channelId: string): boolean {
  return LOCAL_PROACTIVE_PULL_CHANNEL_IDS.has(channelId.trim());
}

// A2A has no proactive sender (#1462, 2026-11-26): schedule creation rejects
// these targets up front and dispatch fails them like any other target without
// one. Delivering to the peer instead is deferred until a peer-push path exists.
export function isA2ADeliveryTarget(channelId: string): boolean {
  const normalized = channelId.trim().toLowerCase();
  return normalized === 'a2a' || normalized.startsWith('a2a:');
}

export function isEmailAddress(channelId: string): boolean {
  return isNormalizedEmailAddress(channelId.trim());
}

function hasProactiveSender(channelId: string): boolean {
  return (
    isLocalProactivePullChannelId(channelId) ||
    (getChannelDescriptorForTarget(channelId)?.supportsProactive ?? false)
  );
}

// Targets an escalation route, a browser interaction, or the message tool may
// name. Teams is left out (#1462, 2026-11-26): only validated schedule targets
// and a session's own replies reach a Teams conversation, so a turn can never
// post into another one. Dispatch and the queue flush still deliver to Teams.
export function isSupportedProactiveChannelId(channelId: string): boolean {
  return (
    hasProactiveSender(channelId) &&
    getChannelDescriptorForTarget(channelId)?.kind !== 'msteams'
  );
}

// A bare `web` target is delivered by dispatch straight into the default
// agent's main chat (`web-scheduled-delivery.ts`). It is never queued: queue
// rows carry no agent or chat, and other writers queue `web` for chats of any
// agent, so a flushed `web` row has no safe destination and is dropped.
export function isWebProactiveTarget(channelId: string): boolean {
  return channelId.trim() === 'web';
}

export function hasQueuedProactiveDeliveryPath(
  item: Pick<QueuedProactiveMessage, 'channel_id'>,
): boolean {
  return hasProactiveSender(item.channel_id);
}

export function hasImmediateProactiveDeliveryPath(
  item: Pick<QueuedProactiveMessage, 'channel_id'>,
): boolean {
  return (
    hasQueuedProactiveDeliveryPath(item) &&
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
