/**
 * Threema channel facts are defined here for target and lifecycle dispatch.
 * Unlike the runtime, this descriptor stays cheap to import and never starts
 * a channel merely because a caller classifies a target.
 */

import type { RuntimeConfig } from '../../config/runtime-config.js';
import { equalStringSets } from '../../utils/string-list-equality.js';
import type { ChannelDescriptor } from '../channel-descriptor.js';
import { isThreemaChannelId } from './target.js';

function hasThreemaConfigChanged(
  next: RuntimeConfig['threema'],
  prev: RuntimeConfig['threema'],
): boolean {
  return (
    next.enabled !== prev.enabled ||
    next.apiBaseUrl !== prev.apiBaseUrl ||
    next.identity !== prev.identity ||
    next.secret !== prev.secret ||
    next.dmPolicy !== prev.dmPolicy ||
    !equalStringSets(next.allowFrom, prev.allowFrom) ||
    next.textChunkLimit !== prev.textChunkLimit ||
    next.outboundDelayMs !== prev.outboundDelayMs
  );
}

export const descriptor = {
  kind: 'threema',
  matchesTarget: isThreemaChannelId,
  supportsProactive: true,
  sendProactive: async (...args) =>
    (await import('./proactive.js')).sendProactive(...args),
  start: async () => (await import('./gateway.js')).startThreemaIntegration(),
  stop: async () => (await import('./runtime.js')).shutdownThreema(),
  configChanged: (next, prev) =>
    hasThreemaConfigChanged(next.threema, prev.threema),
} satisfies ChannelDescriptor;
