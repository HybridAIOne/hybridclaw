/**
 * Telegram channel facts are defined here for target and lifecycle dispatch.
 * Unlike the runtime, this descriptor stays cheap to import and never starts
 * a channel merely because a caller classifies a target.
 */

import type { RuntimeConfig } from '../../config/runtime-config.js';
import { equalStringLists } from '../../utils/string-list-equality.js';
import type { ChannelDescriptor } from '../channel-descriptor.js';
import { isTelegramChannelId } from './target.js';

function hasTelegramConfigChanged(
  next: RuntimeConfig['telegram'],
  prev: RuntimeConfig['telegram'],
): boolean {
  return (
    next.enabled !== prev.enabled ||
    next.botToken !== prev.botToken ||
    next.dmPolicy !== prev.dmPolicy ||
    next.groupPolicy !== prev.groupPolicy ||
    !equalStringLists(next.allowFrom, prev.allowFrom) ||
    !equalStringLists(next.groupAllowFrom, prev.groupAllowFrom) ||
    next.requireMention !== prev.requireMention ||
    next.pollIntervalMs !== prev.pollIntervalMs ||
    next.textChunkLimit !== prev.textChunkLimit ||
    next.mediaMaxMb !== prev.mediaMaxMb
  );
}

export const descriptor = {
  kind: 'telegram',
  matchesTarget: isTelegramChannelId,
  supportsProactive: true,
  sendProactive: async (...args) =>
    (await import('./proactive.js')).sendProactive(...args),
  start: async () => (await import('./gateway.js')).startTelegramIntegration(),
  stop: async () => (await import('./runtime.js')).shutdownTelegram(),
  configChanged: (next, prev) =>
    hasTelegramConfigChanged(next.telegram, prev.telegram),
} satisfies ChannelDescriptor;
