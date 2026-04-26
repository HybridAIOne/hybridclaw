import { timingSafeEqual } from 'node:crypto';

import { PEERS_CONFIG } from '../config/config.js';
import type {
  PeerInboundTokenConfig,
  PeerOutboundConfig,
} from './peer-types.js';

export function arePeersEnabled(): boolean {
  return Boolean(PEERS_CONFIG.enabled);
}

export function getInstanceId(): string {
  return PEERS_CONFIG.instanceId.trim();
}

export function getInstanceName(): string {
  return PEERS_CONFIG.instanceName.trim();
}

export function listOutboundPeers(): PeerOutboundConfig[] {
  if (!arePeersEnabled()) return [];
  return [...PEERS_CONFIG.outbound];
}

export function getOutboundPeer(id: string): PeerOutboundConfig | null {
  if (!arePeersEnabled()) return null;
  const trimmed = String(id || '').trim();
  if (!trimmed) return null;
  return PEERS_CONFIG.outbound.find((entry) => entry.id === trimmed) || null;
}

function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Match an inbound bearer token against the configured `inboundTokens` list.
 * Returns the matching entry (so callers can record the peer id in audit) or
 * `null` if the token is unknown. Comparison is timing-safe.
 */
export function matchInboundToken(
  token: string,
): PeerInboundTokenConfig | null {
  if (!arePeersEnabled()) return null;
  const trimmed = String(token || '').trim();
  if (!trimmed) return null;
  for (const entry of PEERS_CONFIG.inboundTokens) {
    if (safeEqualString(trimmed, entry.token)) {
      return entry;
    }
  }
  return null;
}

export function getInboundMaxConcurrent(): number {
  return Math.max(1, PEERS_CONFIG.inboundMaxConcurrent);
}

export function getDefaultOutboundTimeoutMs(): number {
  return Math.max(1_000, PEERS_CONFIG.defaultOutboundTimeoutMs);
}

/**
 * Throws if the peer rejects this agentId via `allowedAgentIds`.
 */
export function ensureOutboundAgentAllowed(
  peer: PeerOutboundConfig,
  agentId: string | null | undefined,
): void {
  if (!peer.allowedAgentIds || peer.allowedAgentIds.length === 0) return;
  const trimmed = String(agentId || '').trim();
  if (!trimmed) {
    throw new Error(
      `Peer "${peer.id}" requires an explicit agentId (allowedAgentIds is set).`,
    );
  }
  if (!peer.allowedAgentIds.includes(trimmed)) {
    throw new Error(
      `agentId "${trimmed}" is not allowed for peer "${peer.id}".`,
    );
  }
}

export function ensureInboundAgentAllowed(
  inbound: PeerInboundTokenConfig,
  agentId: string | null | undefined,
): void {
  if (!inbound.allowedAgentIds || inbound.allowedAgentIds.length === 0) return;
  const trimmed = String(agentId || '').trim();
  if (!trimmed) {
    throw new Error(
      `Inbound peer "${inbound.id}" must specify an agentId (allowedAgentIds is set).`,
    );
  }
  if (!inbound.allowedAgentIds.includes(trimmed)) {
    throw new Error(
      `agentId "${trimmed}" is not allowed for inbound peer "${inbound.id}".`,
    );
  }
}
