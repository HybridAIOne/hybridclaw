/**
 * WhatsApp channel facts are defined here for target and lifecycle dispatch.
 * Unlike the runtime, this descriptor stays cheap to import and never starts
 * a channel merely because a caller classifies a target.
 */

import type { RuntimeConfig } from '../../config/runtime-config.js';
import { equalStringSets } from '../../utils/string-list-equality.js';
import type { ChannelDescriptor } from '../channel-descriptor.js';
import { isWhatsAppJid } from './phone.js';

function hasWhatsAppConfigChanged(
  next: RuntimeConfig['whatsapp'],
  prev: RuntimeConfig['whatsapp'],
): boolean {
  return (
    next.dmPolicy !== prev.dmPolicy ||
    next.groupPolicy !== prev.groupPolicy ||
    !equalStringSets(next.allowFrom, prev.allowFrom) ||
    !equalStringSets(next.groupAllowFrom, prev.groupAllowFrom) ||
    next.debounceMs !== prev.debounceMs ||
    next.ackReaction !== prev.ackReaction ||
    next.textChunkLimit !== prev.textChunkLimit ||
    next.mediaMaxMb !== prev.mediaMaxMb ||
    next.sendReadReceipts !== prev.sendReadReceipts
  );
}

export const descriptor = {
  kind: 'whatsapp',
  matchesTarget: isWhatsAppJid,
  supportsProactive: true,
  sendProactive: async (...args) =>
    (await import('./proactive.js')).sendProactive(...args),
  start: async () => (await import('./gateway.js')).startWhatsAppIntegration(),
  stop: async () => (await import('./runtime.js')).shutdownWhatsApp(),
  configChanged: (next, prev) =>
    hasWhatsAppConfigChanged(next.whatsapp, prev.whatsapp),
} satisfies ChannelDescriptor;
