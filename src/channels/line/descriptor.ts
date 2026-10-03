/**
 * Line channel facts are defined here for target and lifecycle dispatch.
 * Unlike the runtime, this descriptor stays cheap to import and never starts
 * a channel merely because a caller classifies a target.
 */

import type { RuntimeConfig } from '../../config/runtime-config.js';
import type { ChannelDescriptor } from '../channel-descriptor.js';
import { isLineChannelId } from './target.js';

function hasLineConfigChanged(
  next: RuntimeConfig['line'],
  prev: RuntimeConfig['line'],
): boolean {
  return (
    next.enabled !== prev.enabled || next.textChunkLimit !== prev.textChunkLimit
  );
}

export const descriptor = {
  kind: 'line',
  matchesTarget: isLineChannelId,
  supportsProactive: true,
  sendProactive: async (...args) =>
    (await import('./proactive.js')).sendProactive(...args),
  start: async () => (await import('./gateway.js')).startLineIntegration(),
  stop: async () => (await import('./runtime.js')).shutdownLine(),
  configChanged: (next, prev) => hasLineConfigChanged(next.line, prev.line),
} satisfies ChannelDescriptor;
