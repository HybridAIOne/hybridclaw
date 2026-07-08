import { listAgents } from '../agents/agent-registry.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { getGatewayAdminTunnelStatus } from '../gateway/gateway-tunnel-service.js';
import {
  DnsIdentityResolverBackend,
  IdentityNotFoundError,
  type IdentityResolution,
  IdentityResolver,
  type IdentityResolverBackend,
  IdentityResolverError,
  normalizeIdentityUrl,
  parseCanonicalIdentity,
} from '../identity/resolver.js';
import { isLocalA2AAgentId, resolveA2AAgentId } from './identity.js';
import { registerA2AIdentityResolverInvalidator } from './identity-resolver-invalidation.js';
import {
  A2APeerUntrustedError,
  ensureA2AInstanceKeypair,
  getA2ATrustedPublicKeyPeer,
} from './trust-ledger.js';

export const A2A_IDENTITY_DISCOVERY_ZONE_ENV =
  'HYBRIDCLAW_IDENTITY_DISCOVERY_ZONE';

function configuredIdentityDiscoveryZone(): string | null {
  return process.env[A2A_IDENTITY_DISCOVERY_ZONE_ENV]?.trim() || null;
}

function agentCardBaseUrl(agentCardUrl: string): string {
  const url = new URL(agentCardUrl);
  return normalizeIdentityUrl(url.origin);
}

function publicKeyAsResolverValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function localDeploymentPublicUrl(): string {
  const tunnelStatus = getGatewayAdminTunnelStatus();
  const publicUrl =
    tunnelStatus.publicUrl || getRuntimeConfig().deployment.public_url;
  if (!publicUrl) {
    throw new IdentityResolverError(
      'Local identity resolution requires deployment.public_url or an active tunnel public URL',
    );
  }
  return normalizeIdentityUrl(publicUrl);
}

class LocalDeploymentA2AIdentityResolverBackend
  implements IdentityResolverBackend
{
  private cachedAgentKey = '';
  private cachedCanonicalAgentIds = new Set<string>();

  private localCanonicalAgentIds(): Set<string> {
    const agents = listAgents();
    const key = [
      ...agents.map(
        (agent) =>
          `${agent.id}\0${agent.canonicalId || ''}\0${agent.owner || ''}\0${agent.ownerUserId || ''}`,
      ),
    ].join('\n');
    if (key === this.cachedAgentKey) return this.cachedCanonicalAgentIds;

    const canonicalAgentIds = new Set<string>();
    for (const agent of agents) {
      try {
        canonicalAgentIds.add(resolveA2AAgentId(agent.id));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new IdentityResolverError(
          `Local A2A identity resolution failed for agent ${agent.id}: ${reason}`,
        );
      }
    }
    this.cachedAgentKey = key;
    this.cachedCanonicalAgentIds = canonicalAgentIds;
    return canonicalAgentIds;
  }

  async lookup(canonicalId: string): Promise<IdentityResolution | null> {
    const parsed = parseCanonicalIdentity(canonicalId);
    if (parsed.kind !== 'agent') return null;
    if (!isLocalA2AAgentId(parsed.id)) return null;
    if (!this.localCanonicalAgentIds().has(parsed.id)) return null;

    return {
      url: localDeploymentPublicUrl(),
      publicKey: JSON.stringify(ensureA2AInstanceKeypair().publicKeyJwk),
    };
  }
}

class TrustedPeerA2AIdentityResolverBackend implements IdentityResolverBackend {
  async lookup(canonicalId: string): Promise<IdentityResolution | null> {
    const parsed = parseCanonicalIdentity(canonicalId);
    if (parsed.kind !== 'agent') return null;

    const peer = getA2ATrustedPublicKeyPeer(parsed.parsed.instanceId);
    if (!peer) return null;
    if (peer.status !== 'trusted') {
      throw new A2APeerUntrustedError(peer.peerId);
    }
    const reachableUrl = peer.deliveryUrl || peer.agentCardUrl;
    if (!reachableUrl) return null;
    return {
      url: agentCardBaseUrl(reachableUrl),
      publicKey: publicKeyAsResolverValue(
        peer.publicKeyJwk ?? peer.publicKeyFingerprint,
      ),
    };
  }
}

class DefaultA2AIdentityResolverBackend implements IdentityResolverBackend {
  private readonly localBackend =
    new LocalDeploymentA2AIdentityResolverBackend();
  private readonly trustedPeerBackend =
    new TrustedPeerA2AIdentityResolverBackend();
  private dnsZone: string | null = null;
  private dnsBackend: DnsIdentityResolverBackend | null = null;

  async lookup(canonicalId: string): Promise<IdentityResolution | null> {
    const local = await this.localBackend.lookup(canonicalId);
    if (local) return local;

    const trustedPeer = await this.trustedPeerBackend.lookup(canonicalId);
    if (trustedPeer) return trustedPeer;

    const zone = configuredIdentityDiscoveryZone();
    if (!zone) return null;
    if (zone !== this.dnsZone) {
      this.dnsZone = zone;
      this.dnsBackend = new DnsIdentityResolverBackend({ zone });
    }
    return this.dnsBackend?.lookup(canonicalId) ?? null;
  }
}

let cachedDefaultA2AIdentityResolver: IdentityResolver | null = null;

registerA2AIdentityResolverInvalidator((canonicalId) => {
  cachedDefaultA2AIdentityResolver?.invalidate(canonicalId);
});

export function getDefaultA2AIdentityResolver(): IdentityResolver {
  cachedDefaultA2AIdentityResolver ??= new IdentityResolver({
    backend: new DefaultA2AIdentityResolverBackend(),
  });
  return cachedDefaultA2AIdentityResolver;
}

export async function resolveA2AIdentity(
  canonicalId: string,
): Promise<IdentityResolution> {
  try {
    return await getDefaultA2AIdentityResolver().resolve(canonicalId);
  } catch (error) {
    if (error instanceof IdentityNotFoundError) {
      throw new IdentityResolverError(
        `No A2A identity resolution found for ${error.canonicalId}; configure ${A2A_IDENTITY_DISCOVERY_ZONE_ENV} or trust the peer public key first.`,
      );
    }
    throw error;
  }
}
