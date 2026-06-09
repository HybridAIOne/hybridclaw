import {
  type A2ATrustedPublicKeyPeer,
  deleteA2ATrustedPublicKeyPeer,
  ensureA2AInstanceKeypair,
  listA2ATrustedPublicKeyPeers,
  upsertA2ATrustedPublicKeyPeer,
} from '../a2a/trust-ledger.js';
import { isA2AAllowedHttpUrl, isRecord } from '../a2a/utils.js';
import { APP_VERSION } from '../config/app-version.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import type {
  GatewayAdminFleetTopologyInstance,
  GatewayAdminFleetTopologyResponse,
  GatewayAdminFleetTopologyUpsertRequest,
} from './gateway-types.js';

const DEFAULT_FLEET_STATUS_TIMEOUT_MS = 2_000;

function normalizeStringInput(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GatewayRequestError(400, `Expected string \`${label}\`.`);
  }
  return value.trim();
}

function normalizeOptionalStringInput(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new GatewayRequestError(400, `Expected string \`${label}\`.`);
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function readAgentCardVersion(card: unknown): string | null {
  if (!isRecord(card)) return null;
  if (typeof card.version === 'string' && card.version.trim()) {
    return card.version.trim();
  }
  const metadata = isRecord(card.hybridclaw) ? card.hybridclaw : null;
  if (typeof metadata?.version === 'string' && metadata.version.trim()) {
    return metadata.version.trim();
  }
  return null;
}

async function checkFleetPeerStatus(
  peer: A2ATrustedPublicKeyPeer,
  params: {
    fetchImpl: typeof fetch;
    timeoutMs: number;
  },
): Promise<
  Pick<
    GatewayAdminFleetTopologyInstance,
    'status' | 'latencyMs' | 'version' | 'error'
  >
> {
  if (peer.status === 'revoked') {
    return {
      status: 'revoked',
      latencyMs: null,
      version: null,
      error: peer.revokedReason || 'Trust revoked.',
    };
  }
  if (!peer.agentCardUrl) {
    return {
      status: 'unconfigured',
      latencyMs: null,
      version: null,
      error: 'Agent Card URL is not configured.',
    };
  }
  if (!isA2AAllowedHttpUrl(peer.agentCardUrl)) {
    return {
      status: 'unreachable',
      latencyMs: null,
      version: null,
      error: 'Agent Card URL must use https unless targeting loopback.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  const started = Date.now();
  try {
    const response = await params.fetchImpl(peer.agentCardUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, Date.now() - started);
    if (!response.ok) {
      return {
        status: 'unreachable',
        latencyMs,
        version: null,
        error: `Agent Card HTTP ${response.status}`,
      };
    }
    const card = (await response.json()) as unknown;
    return {
      status: 'online',
      latencyMs,
      version: readAgentCardVersion(card),
      error: null,
    };
  } catch (error) {
    return {
      status: 'unreachable',
      latencyMs: Math.max(0, Date.now() - started),
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function mapFleetPeer(
  peer: A2ATrustedPublicKeyPeer,
  params: {
    fetchImpl: typeof fetch;
    timeoutMs: number;
  },
): Promise<GatewayAdminFleetTopologyInstance> {
  const status = await checkFleetPeerStatus(peer, params);
  return {
    peerId: peer.peerId,
    agentCardUrl: peer.agentCardUrl,
    deliveryUrl: peer.deliveryUrl,
    publicKeyFingerprint: peer.publicKeyFingerprint,
    trustStatus: peer.status,
    trustedAt: peer.trustedAt,
    createdAt: peer.createdAt,
    updatedAt: peer.updatedAt,
    lastSeenAt: peer.lastSeenAt,
    revokedAt: peer.revokedAt || null,
    revokedReason: peer.revokedReason || null,
    ...status,
  };
}

export async function getGatewayAdminFleetTopology(
  params: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GatewayAdminFleetTopologyResponse> {
  const identity = ensureA2AInstanceKeypair();
  const fetchImpl = params.fetchImpl ?? fetch;
  const timeoutMs = Math.max(
    1,
    Math.floor(params.timeoutMs ?? DEFAULT_FLEET_STATUS_TIMEOUT_MS),
  );
  const instances = await Promise.all(
    listA2ATrustedPublicKeyPeers().map((peer) =>
      mapFleetPeer(peer, { fetchImpl, timeoutMs }),
    ),
  );
  return {
    hq: {
      instanceId: identity.instanceId,
      publicKeyFingerprint: identity.publicKeyFingerprint,
      version: APP_VERSION,
      status: 'local',
      latencyMs: 0,
      lastSeenAt: new Date().toISOString(),
    },
    instances,
  };
}

export async function upsertGatewayAdminFleetTopologyInstance(
  input: GatewayAdminFleetTopologyUpsertRequest,
  params: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<GatewayAdminFleetTopologyResponse> {
  upsertA2ATrustedPublicKeyPeer({
    peerId: normalizeStringInput(input.peerId, 'peerId'),
    agentCardUrl: normalizeOptionalStringInput(
      input.agentCardUrl,
      'agentCardUrl',
    ),
    deliveryUrl: normalizeOptionalStringInput(input.deliveryUrl, 'deliveryUrl'),
    publicKeyFingerprint: normalizeOptionalStringInput(
      input.publicKeyFingerprint,
      'publicKeyFingerprint',
    ),
    publicKeyJwk: input.publicKeyJwk,
    reason: normalizeOptionalStringInput(input.reason, 'reason'),
  });
  return getGatewayAdminFleetTopology(params);
}

export async function deleteGatewayAdminFleetTopologyInstance(params: {
  peerId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<GatewayAdminFleetTopologyResponse> {
  deleteA2ATrustedPublicKeyPeer(params.peerId);
  return getGatewayAdminFleetTopology(params);
}
