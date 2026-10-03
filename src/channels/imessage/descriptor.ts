/**
 * IMessage channel facts are defined here for target and lifecycle dispatch.
 * Unlike the runtime, this descriptor stays cheap to import and never starts
 * a channel merely because a caller classifies a target.
 */

import type { ChannelDescriptor } from '../channel-descriptor.js';
import { isIMessageHandle } from './handle.js';

export const descriptor = {
  kind: 'imessage',
  matchesTarget: isIMessageHandle,
  supportsProactive: true,
  sendProactive: async (...args) =>
    (await import('./proactive.js')).sendProactive(...args),
  start: async () => (await import('./gateway.js')).startIMessageIntegration(),
  stop: async () => (await import('./runtime.js')).shutdownIMessage(),
  configChanged: () => false,
} satisfies ChannelDescriptor;
