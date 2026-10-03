/**
 * Channel descriptors declare target and lifecycle contracts without live state.
 * Unlike the runtime registry, a descriptor exists even when a channel is off;
 * supporting a target does not grant permission or guarantee configured delivery.
 */
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { ArtifactMetadata } from '../types/execution.js';
import type { ChannelKind } from './channel.js';

export interface ProactiveDeliveryOutcome {
  status: 'delivered' | 'queued' | 'suppressed' | 'failed';
  reason?: string;
}

export type ExternalChannelKind = Exclude<
  ChannelKind,
  'heartbeat' | 'scheduler' | 'tui'
>;

export interface ChannelDescriptor {
  kind: ExternalChannelKind;
  matchesTarget: (target: string) => boolean;
  supportsProactive: boolean;
  sendProactive?: (
    target: string,
    text: string,
    source: string,
    artifacts?: ArtifactMetadata[],
  ) => Promise<ProactiveDeliveryOutcome>;
  start: () => Promise<boolean>;
  stop: (options?: { drain?: boolean }) => Promise<void>;
  configChanged: (next: RuntimeConfig, prev: RuntimeConfig) => boolean;
}

export function proactiveDeliveryFailed(
  reason: unknown,
): ProactiveDeliveryOutcome {
  return {
    status: 'failed',
    reason:
      reason instanceof Error
        ? reason.message
        : String(reason ?? 'Delivery failed'),
  };
}
