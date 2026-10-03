/**
 * Signal channel facts are defined here for target and lifecycle dispatch.
 * Unlike the runtime, this descriptor stays cheap to import and never starts
 * a channel merely because a caller classifies a target.
 */

import type { RuntimeConfig } from '../../config/runtime-config.js';
import { equalStringSets } from '../../utils/string-list-equality.js';
import type { ChannelDescriptor } from '../channel-descriptor.js';
import { isSignalChannelId } from './target.js';

function hasSignalConfigChanged(
  next: RuntimeConfig['signal'],
  prev: RuntimeConfig['signal'],
): boolean {
  return (
    next.enabled !== prev.enabled ||
    next.daemonUrl !== prev.daemonUrl ||
    next.account !== prev.account ||
    next.dmPolicy !== prev.dmPolicy ||
    next.groupPolicy !== prev.groupPolicy ||
    !equalStringSets(next.allowFrom, prev.allowFrom) ||
    !equalStringSets(next.groupAllowFrom, prev.groupAllowFrom) ||
    next.textChunkLimit !== prev.textChunkLimit ||
    next.reconnectIntervalMs !== prev.reconnectIntervalMs ||
    next.outboundDelayMs !== prev.outboundDelayMs
  );
}

export const descriptor = {
  kind: 'signal',
  matchesTarget: isSignalChannelId,
  supportsProactive: true,
  sendProactive: async (...args) =>
    (await import('./proactive.js')).sendProactive(...args),
  start: async () => (await import('./gateway.js')).startSignalIntegration(),
  stop: async () => (await import('./runtime.js')).shutdownSignal(),
  configChanged: (next, prev) =>
    hasSignalConfigChanged(next.signal, prev.signal),
} satisfies ChannelDescriptor;
