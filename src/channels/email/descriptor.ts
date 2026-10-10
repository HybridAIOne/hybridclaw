/**
 * Email channel facts are defined here for target and lifecycle dispatch.
 * Unlike the runtime, this descriptor stays cheap to import and never starts
 * a channel merely because a caller classifies a target.
 */

import { resolveConfiguredDefaultAgentId } from '../../agents/agent-types.js';
import type { ChannelDescriptor } from '../channel-descriptor.js';
import { emailRuntimeLoader } from '../channel-runtime-loaders.js';
import { isEmailAddress } from './allowlist.js';

export const descriptor = {
  kind: 'email',
  matchesTarget: isEmailAddress,
  supportsProactive: true,
  sendProactive: async (...args) =>
    (await import('./proactive.js')).sendProactive(...args),
  start: async () => (await import('./gateway.js')).startEmailIntegration(),
  stop: emailRuntimeLoader.stop,
  // Accounts without an agentId are bound to the default agent at start.
  configChanged: (next, prev) =>
    JSON.stringify(next.email) !== JSON.stringify(prev.email) ||
    resolveConfiguredDefaultAgentId(next.agents) !==
      resolveConfiguredDefaultAgentId(prev.agents),
} satisfies ChannelDescriptor;
