/**
 * Slack channel facts are defined here for target and lifecycle dispatch.
 * Unlike the runtime, this descriptor stays cheap to import and never starts
 * a channel merely because a caller classifies a target.
 */

import type { RuntimeConfig } from '../../config/runtime-config.js';
import { equalStringSets } from '../../utils/string-list-equality.js';
import type { ChannelDescriptor } from '../channel-descriptor.js';
import { slackRuntimeLoader } from '../channel-runtime-loaders.js';
import { isSlackChannelTarget } from './target.js';

function hasSlackConfigChanged(
  next: RuntimeConfig['slack'],
  prev: RuntimeConfig['slack'],
): boolean {
  return (
    next.enabled !== prev.enabled ||
    next.dmPolicy !== prev.dmPolicy ||
    next.groupPolicy !== prev.groupPolicy ||
    !equalStringSets(next.allowFrom, prev.allowFrom) ||
    !equalStringSets(next.groupAllowFrom, prev.groupAllowFrom) ||
    next.requireMention !== prev.requireMention ||
    next.textChunkLimit !== prev.textChunkLimit ||
    next.replyStyle !== prev.replyStyle ||
    next.mediaMaxMb !== prev.mediaMaxMb
  );
}

export const descriptor = {
  kind: 'slack',
  matchesTarget: isSlackChannelTarget,
  supportsProactive: true,
  sendProactive: async (...args) =>
    (await import('./proactive.js')).sendProactive(...args),
  start: async () => (await import('./gateway.js')).startSlackIntegration(),
  stop: slackRuntimeLoader.stop,
  configChanged: (next, prev) => hasSlackConfigChanged(next.slack, prev.slack),
} satisfies ChannelDescriptor;
