/**
 * MSTeams channel facts are defined here for target and lifecycle dispatch.
 * Unlike the runtime, this descriptor stays cheap to import and never starts
 * a channel merely because a caller classifies a target.
 */
import type { ChannelDescriptor } from '../channel-descriptor.js';

function isMSTeamsTarget(target: string): boolean {
  return (
    target.startsWith('19:') ||
    target.startsWith('a:') ||
    target.startsWith('teams:') ||
    target.includes('@thread.')
  );
}

export const descriptor = {
  kind: 'msteams',
  matchesTarget: isMSTeamsTarget,
  supportsProactive: false,

  start: async () => (await import('./gateway.js')).startMSTeamsIntegration(),
  // Teams shares the gateway HTTP server; ingress policy blocks it in local mode.
  stop: async () => undefined,
  configChanged: (next, prev) =>
    JSON.stringify(next.msteams) !== JSON.stringify(prev.msteams),
} satisfies ChannelDescriptor;
