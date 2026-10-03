/**
 * MSTeams channel facts are defined here for target and lifecycle dispatch.
 * Unlike the runtime, this descriptor stays cheap to import and never starts
 * a channel merely because a caller classifies a target.
 */
import { isDeepStrictEqual } from 'node:util';
import type { ChannelDescriptor } from '../channel-descriptor.js';

function isMSTeamsTarget(target: string): boolean {
  return (
    target.startsWith('19:') ||
    target.startsWith('a:') ||
    target.startsWith('teams:') ||
    /^[^:@]+@thread\.(?:v2|tacv2)(?:;messageid=\d+)?$/.test(target)
  );
}

export const descriptor = {
  kind: 'msteams',
  matchesTarget: isMSTeamsTarget,
  supportsProactive: false,

  start: async () => (await import('./gateway.js')).startMSTeamsIntegration(),
  // Shared HTTP ingress checks enabled config per request and local-mode policy.
  stop: async () => undefined,
  configChanged: (next, prev) => !isDeepStrictEqual(next.msteams, prev.msteams),
} satisfies ChannelDescriptor;
