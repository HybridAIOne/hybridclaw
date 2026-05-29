import type { JsonWebKey } from 'node:crypto';
import { createHash } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  getRuntimeAssetRevisionState,
  listRuntimeAssetRevisionStates,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { readRequestBody, sendJson } from '../gateway/gateway-http-utils.js';
import {
  createSuspendedSession,
  emitInteractionNeededEvent,
} from '../gateway/interactive-escalation.js';
import { fetchA2AAgentCard } from './a2a-agent-card.js';
import type { A2AAgentCard } from './a2a-json-rpc.js';
import {
  A2A_IDENTITY_DISCOVERY_ZONE_ENV,
  resolveA2AIdentity,
} from './identity-resolver.js';
import { normalizePeerDescriptor } from './peer-descriptor.js';
import {
  type A2APeerPublicKeyMaterial,
  ensureA2AInstanceKeypair,
  extractA2APeerPublicKey,
  fingerprintA2APublicKey,
  getA2ATrustedPublicKeyPeer,
  normalizeA2APeerId,
  normalizePublicKeyFingerprint,
  upsertA2ATrustedPublicKeyPeer,
} from './trust-ledger.js';
import { isA2AAllowedHttpUrl, isRecord } from './utils.js';

export const A2A_PAIRING_REQUEST_PATH = '/a2a/pairing/requests';
const A2A_PAIRING_REQUEST_SCHEMA_VERSION = 1;
const A2A_PAIRING_REQUEST_ASSET_PREFIX = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'a2a',
  'pairing',
  'requests',
);
const A2A_PAIRING_AUDIT_SESSION_ID = 'a2a:pairing';
const A2A_PAIRING_MAX_BODY_BYTES = 64 * 1024;

export type A2APairingRequestStatus = 'pending' | 'approved' | 'declined';
export type A2APairingRemoteNotificationStatus =
  | 'not_requested'
  | 'sent'
  | 'failed';

export interface A2APairingProposal {
  peerId: string;
  agentCardUrl: string;
  deliveryUrl: string;
  publicKeyJwk: JsonWebKey;
  publicKeyFingerprint: string;
  name: string | null;
}

export interface A2AIncomingPairingRequest extends A2APairingProposal {
  schemaVersion: typeof A2A_PAIRING_REQUEST_SCHEMA_VERSION;
  requestId: string;
  status: A2APairingRequestStatus;
  pairingId: string | null;
  requestedBy: string | null;
  requestedAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: string;
  declinedAt?: string;
  declinedBy?: string;
  reason?: string;
}

export interface StartA2APairingInput {
  peerUrl?: string;
  canonicalId?: string;
  reason?: string;
  notifyPeer?: boolean;
  actor?: string;
  localBaseUrl?: string | null;
  fetchImpl?: typeof fetch;
  now?: Date;
}

export interface StartA2APairingResult {
  proposal: A2APairingProposal;
  trustedPeer: ReturnType<typeof upsertA2ATrustedPublicKeyPeer>;
  remoteNotification: {
    status: A2APairingRemoteNotificationStatus;
    url: string | null;
    error: string | null;
  };
}

function pairingRequestAssetPath(requestId: string): string {
  return path.join(
    A2A_PAIRING_REQUEST_ASSET_PREFIX,
    `${encodeURIComponent(requestId)}.json`,
  );
}

function recordPairingAudit(event: Record<string, unknown> & { type: string }) {
  recordAuditEvent({
    sessionId: A2A_PAIRING_AUDIT_SESSION_ID,
    runId: makeAuditRunId('a2a-pairing'),
    event,
  });
}

function normalizePairingUrl(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new GatewayRequestError(400, `${label} is required.`);
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new GatewayRequestError(400, `${label} must be a valid URL.`);
  }
  if (!isA2AAllowedHttpUrl(url.toString())) {
    throw new GatewayRequestError(
      400,
      `${label} must use https unless targeting loopback.`,
    );
  }
  return url.toString();
}

function deriveAgentCardUrl(peerUrl: string): string {
  const url = new URL(peerUrl);
  if (url.pathname === '/.well-known/agent.json') return url.toString();
  return new URL('/.well-known/agent.json', url.origin).toString();
}

function publicKeyFingerprintFromDiscovery(publicKey: string): string | null {
  const normalized = publicKey.trim();
  try {
    return normalizePublicKeyFingerprint(normalized);
  } catch {
    // Continue below; discovery may have returned a serialized JWK.
  }

  try {
    const parsed = JSON.parse(normalized) as JsonWebKey;
    if (
      parsed.kty !== 'OKP' ||
      parsed.crv !== 'Ed25519' ||
      typeof parsed.x !== 'string'
    ) {
      return null;
    }
    return fingerprintA2APublicKey(parsed);
  } catch {
    return null;
  }
}

function requestIdFor(key: A2APeerPublicKeyMaterial): string {
  return createHash('sha256')
    .update(`${key.peerId}\0${key.publicKeyFingerprint}`)
    .digest('base64url')
    .slice(0, 32);
}

function pairingIdFor(params: {
  localPeerId: string;
  localPublicKeyFingerprint: string;
  remotePeerId: string;
  remotePublicKeyFingerprint: string;
}): string {
  const pairKey = [
    params.localPeerId,
    params.localPublicKeyFingerprint,
    params.remotePeerId,
    params.remotePublicKeyFingerprint,
  ]
    .sort()
    .join('\0');
  return createHash('sha256').update(pairKey).digest('base64url').slice(0, 32);
}

function parseStoredPairingRequest(
  content: string,
): A2AIncomingPairingRequest | null {
  try {
    const parsed = JSON.parse(content) as A2AIncomingPairingRequest;
    if (parsed.schemaVersion !== A2A_PAIRING_REQUEST_SCHEMA_VERSION) {
      return null;
    }
    if (
      parsed.status !== 'pending' &&
      parsed.status !== 'approved' &&
      parsed.status !== 'declined'
    ) {
      return null;
    }
    const key = extractA2APeerPublicKey({
      url: parsed.deliveryUrl,
      hybridclaw: {
        instanceId: parsed.peerId,
        publicKeyJwk: parsed.publicKeyJwk,
      },
    });
    if (!key || key.publicKeyFingerprint !== parsed.publicKeyFingerprint) {
      return null;
    }
    return {
      schemaVersion: A2A_PAIRING_REQUEST_SCHEMA_VERSION,
      requestId: String(parsed.requestId || '').trim(),
      status: parsed.status,
      pairingId:
        typeof parsed.pairingId === 'string' && parsed.pairingId.trim()
          ? parsed.pairingId.trim()
          : null,
      peerId: key.peerId,
      agentCardUrl: normalizePairingUrl(parsed.agentCardUrl, 'agentCardUrl'),
      deliveryUrl: normalizePairingUrl(parsed.deliveryUrl, 'deliveryUrl'),
      publicKeyJwk: key.publicKeyJwk,
      publicKeyFingerprint: key.publicKeyFingerprint,
      name: typeof parsed.name === 'string' ? parsed.name : null,
      requestedBy:
        typeof parsed.requestedBy === 'string' && parsed.requestedBy.trim()
          ? parsed.requestedBy.trim()
          : null,
      requestedAt:
        typeof parsed.requestedAt === 'string' && parsed.requestedAt
          ? parsed.requestedAt
          : new Date(0).toISOString(),
      updatedAt:
        typeof parsed.updatedAt === 'string' && parsed.updatedAt
          ? parsed.updatedAt
          : new Date(0).toISOString(),
      ...(typeof parsed.approvedAt === 'string' && parsed.approvedAt
        ? { approvedAt: parsed.approvedAt }
        : {}),
      ...(typeof parsed.approvedBy === 'string' && parsed.approvedBy
        ? { approvedBy: parsed.approvedBy }
        : {}),
      ...(typeof parsed.declinedAt === 'string' && parsed.declinedAt
        ? { declinedAt: parsed.declinedAt }
        : {}),
      ...(typeof parsed.declinedBy === 'string' && parsed.declinedBy
        ? { declinedBy: parsed.declinedBy }
        : {}),
      ...(typeof parsed.reason === 'string' && parsed.reason
        ? { reason: parsed.reason }
        : {}),
    };
  } catch {
    return null;
  }
}

function persistPairingRequest(request: A2AIncomingPairingRequest): void {
  syncRuntimeAssetRevisionState(
    'a2a',
    pairingRequestAssetPath(request.requestId),
    {
      route: `a2a.pairing.request#${request.requestId}`,
      source: 'a2a-pairing',
    },
    {
      exists: true,
      content: JSON.stringify(request),
    },
  );
}

function getIncomingPairingRequest(
  requestId: string,
): A2AIncomingPairingRequest | null {
  const state = getRuntimeAssetRevisionState(
    'a2a',
    pairingRequestAssetPath(requestId),
  );
  return state ? parseStoredPairingRequest(state.content) : null;
}

function promptPeerOperator(request: A2AIncomingPairingRequest): void {
  const session = createSuspendedSession({
    sessionId: `a2a:pairing:${request.requestId}`,
    approvalId: `a2a-pairing-${request.requestId}`,
    prompt: [
      'A peer instance requested A2A pairing.',
      `Peer: ${request.peerId}`,
      `Agent Card: ${request.agentCardUrl}`,
      `Delivery URL: ${request.deliveryUrl}`,
      `Fingerprint: ${request.publicKeyFingerprint}`,
      'Approve this from /admin/a2a-trust to trust the peer public key.',
    ].join('\n'),
    userId: 'operator',
    modality: 'push',
    expectedReturnKinds: ['approved', 'declined', 'timeout'],
    frameSnapshot: {
      url: 'hybridclaw://a2a/pairing',
      title: 'A2A pairing request',
    },
    context: {
      host: 'a2a.pairing',
      pageTitle: 'A2A pairing request',
    },
    skillId: 'a2a.pairing',
  });
  emitInteractionNeededEvent({ session });
}

export async function fetchA2APairingProposal(
  input: Pick<StartA2APairingInput, 'peerUrl' | 'canonicalId' | 'fetchImpl'> & {
    now?: Date;
  },
): Promise<A2APairingProposal> {
  let agentCardUrl = input.peerUrl
    ? deriveAgentCardUrl(normalizePairingUrl(input.peerUrl, 'peerUrl'))
    : '';
  let expectedFingerprint: string | null = null;

  if (!agentCardUrl && input.canonicalId?.trim()) {
    const resolution = await resolveA2APairingCanonicalTarget(
      input.canonicalId.trim(),
    );
    expectedFingerprint = resolution.publicKey
      ? publicKeyFingerprintFromDiscovery(resolution.publicKey)
      : null;
    if (!expectedFingerprint) {
      throw new GatewayRequestError(
        400,
        'Canonical identity discovery returned an unsupported public key.',
      );
    }
    const descriptor = normalizePeerDescriptor({
      transport: 'a2a',
      url: resolution.url,
      expectPublicKey: true,
    });
    if (
      descriptor.transport !== 'a2a' ||
      !('agentCardUrl' in descriptor) ||
      !descriptor.agentCardUrl
    ) {
      throw new GatewayRequestError(
        400,
        'Canonical identity discovery did not resolve to an A2A peer.',
      );
    }
    agentCardUrl = descriptor.agentCardUrl;
  }

  if (!agentCardUrl) {
    throw new GatewayRequestError(400, 'Expected `peerUrl` or `canonicalId`.');
  }

  const card = await fetchA2AAgentCard({
    agentCardUrl,
    fetchImpl: input.fetchImpl,
    now: input.now ?? new Date(),
  });
  const key = extractA2APeerPublicKey(card);
  if (!key) {
    throw new GatewayRequestError(
      400,
      'Peer Agent Card does not advertise HybridClaw public key material.',
    );
  }
  if (expectedFingerprint && expectedFingerprint !== key.publicKeyFingerprint) {
    throw new GatewayRequestError(
      400,
      'Canonical identity public key does not match peer Agent Card.',
    );
  }
  return {
    peerId: key.peerId,
    agentCardUrl,
    deliveryUrl: card.url,
    publicKeyJwk: key.publicKeyJwk,
    publicKeyFingerprint: key.publicKeyFingerprint,
    name: typeof card.name === 'string' && card.name.trim() ? card.name : null,
  };
}

async function resolveA2APairingCanonicalTarget(
  value: string,
): Promise<{ url: string; publicKey: string }> {
  if (value.includes('@')) return resolveA2AIdentity(value);

  const instanceId = normalizeA2APeerId(value);
  const trusted = getA2ATrustedPublicKeyPeer(instanceId);
  if (trusted?.status === 'trusted' && trusted.agentCardUrl) {
    return {
      url: new URL(trusted.agentCardUrl).origin,
      publicKey: trusted.publicKeyJwk
        ? JSON.stringify(trusted.publicKeyJwk)
        : trusted.publicKeyFingerprint,
    };
  }

  const zone = process.env[A2A_IDENTITY_DISCOVERY_ZONE_ENV]?.trim();
  if (!zone) {
    throw new GatewayRequestError(
      400,
      `No identity discovery zone configured for instance ${instanceId}.`,
    );
  }
  const idHash = createHash('sha256').update(instanceId).digest('base64url');
  const recordName = `_hybridclaw-instance.${idHash}.${zone
    .toLowerCase()
    .replace(/\.+$/u, '')}`;
  const records = await resolveTxt(recordName);
  for (const record of records) {
    const parsed = JSON.parse(record.join('')) as Record<string, unknown>;
    if (parsed.instanceId !== instanceId) continue;
    if (
      typeof parsed.url !== 'string' ||
      typeof parsed.publicKey !== 'string'
    ) {
      continue;
    }
    return {
      url: normalizePairingUrl(parsed.url, 'canonicalInstanceId.url'),
      publicKey: parsed.publicKey.trim(),
    };
  }
  throw new GatewayRequestError(
    404,
    `No identity discovery record found for instance ${instanceId}.`,
  );
}

async function notifyRemotePairingRequest(params: {
  proposal: A2APairingProposal;
  localBaseUrl: string | null | undefined;
  actor?: string;
  fetchImpl?: typeof fetch;
}): Promise<StartA2APairingResult['remoteNotification']> {
  if (!params.localBaseUrl) {
    return {
      status: 'failed',
      url: null,
      error: 'local public URL unavailable',
    };
  }
  const localBaseUrl = normalizePairingUrl(params.localBaseUrl, 'localBaseUrl');
  const identityUrl = new URL(
    '/.well-known/agent.json',
    localBaseUrl,
  ).toString();
  const identity = ensureA2AInstanceKeypair();
  const pairingId = pairingIdFor({
    localPeerId: identity.instanceId,
    localPublicKeyFingerprint: identity.publicKeyFingerprint,
    remotePeerId: params.proposal.peerId,
    remotePublicKeyFingerprint: params.proposal.publicKeyFingerprint,
  });

  const endpoint = new URL(
    A2A_PAIRING_REQUEST_PATH,
    params.proposal.deliveryUrl,
  );
  try {
    const response = await (params.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        peerId: identity.instanceId,
        agentCardUrl: identityUrl,
        deliveryUrl: new URL('/a2a', localBaseUrl).toString(),
        publicKeyJwk: identity.publicKeyJwk,
        publicKeyFingerprint: identity.publicKeyFingerprint,
        pairingId,
        requestedBy: params.actor || null,
      }),
      redirect: 'error',
    });
    if (!response.ok) {
      return {
        status: 'failed',
        url: endpoint.toString(),
        error: `HTTP ${response.status}`,
      };
    }
    return { status: 'sent', url: endpoint.toString(), error: null };
  } catch (error) {
    return {
      status: 'failed',
      url: endpoint.toString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function startA2APairing(
  input: StartA2APairingInput,
): Promise<StartA2APairingResult> {
  const now = input.now ?? new Date();
  const proposal = await fetchA2APairingProposal(input);
  const trustedPeer = upsertA2ATrustedPublicKeyPeer(
    {
      peerId: proposal.peerId,
      agentCardUrl: proposal.agentCardUrl,
      deliveryUrl: proposal.deliveryUrl,
      publicKeyJwk: proposal.publicKeyJwk,
      publicKeyFingerprint: proposal.publicKeyFingerprint,
      reason: input.reason || 'operator pairing',
      actor: input.actor,
    },
    now,
  );
  const remoteNotification =
    input.notifyPeer === false
      ? { status: 'not_requested' as const, url: null, error: null }
      : await notifyRemotePairingRequest({
          proposal,
          localBaseUrl: input.localBaseUrl,
          actor: input.actor,
          fetchImpl: input.fetchImpl,
        });

  recordPairingAudit({
    type: 'a2a.pairing.started',
    peerId: proposal.peerId,
    actor: input.actor || null,
    agentCardUrl: proposal.agentCardUrl,
    deliveryUrl: proposal.deliveryUrl,
    publicKeyFingerprint: proposal.publicKeyFingerprint,
    remoteNotification,
  });
  return { proposal, trustedPeer, remoteNotification };
}

export function listIncomingA2APairingRequests(): A2AIncomingPairingRequest[] {
  return listRuntimeAssetRevisionStates('a2a', {
    assetPathPrefix: A2A_PAIRING_REQUEST_ASSET_PREFIX,
  })
    .map((state) => parseStoredPairingRequest(state.content))
    .filter((request): request is A2AIncomingPairingRequest => request !== null)
    .sort((left, right) => {
      if (left.status !== right.status)
        return left.status === 'pending' ? -1 : 1;
      return right.requestedAt.localeCompare(left.requestedAt);
    });
}

export function createIncomingA2APairingRequest(
  input: unknown,
  now = new Date(),
): A2AIncomingPairingRequest {
  if (!isRecord(input)) {
    throw new GatewayRequestError(
      400,
      'Pairing request body must be an object.',
    );
  }
  const card: A2AAgentCard = {
    url: normalizePairingUrl(String(input.deliveryUrl || ''), 'deliveryUrl'),
    name: typeof input.name === 'string' ? input.name : undefined,
    hybridclaw: {
      instanceId: input.peerId,
      publicKeyJwk: input.publicKeyJwk,
    },
  };
  const key = extractA2APeerPublicKey(card);
  if (!key) {
    throw new GatewayRequestError(
      400,
      'Pairing request public key is invalid.',
    );
  }
  const providedFingerprint =
    typeof input.publicKeyFingerprint === 'string'
      ? normalizePublicKeyFingerprint(input.publicKeyFingerprint)
      : key.publicKeyFingerprint;
  if (providedFingerprint !== key.publicKeyFingerprint) {
    throw new GatewayRequestError(
      400,
      'publicKeyFingerprint does not match publicKeyJwk.',
    );
  }
  const requestId = requestIdFor(key);
  const existing = getIncomingPairingRequest(requestId);
  const timestamp = now.toISOString();
  const request: A2AIncomingPairingRequest = {
    schemaVersion: A2A_PAIRING_REQUEST_SCHEMA_VERSION,
    requestId,
    status: existing?.status || 'pending',
    pairingId:
      typeof input.pairingId === 'string' && input.pairingId.trim()
        ? input.pairingId.trim()
        : existing?.pairingId || null,
    peerId: key.peerId,
    agentCardUrl: normalizePairingUrl(
      String(input.agentCardUrl || ''),
      'agentCardUrl',
    ),
    deliveryUrl: card.url,
    publicKeyJwk: key.publicKeyJwk,
    publicKeyFingerprint: key.publicKeyFingerprint,
    name:
      typeof input.name === 'string' && input.name.trim() ? input.name : null,
    requestedBy:
      typeof input.requestedBy === 'string' && input.requestedBy.trim()
        ? input.requestedBy.trim()
        : null,
    requestedAt: existing?.requestedAt || timestamp,
    updatedAt: timestamp,
    ...(existing?.approvedAt ? { approvedAt: existing.approvedAt } : {}),
    ...(existing?.approvedBy ? { approvedBy: existing.approvedBy } : {}),
    ...(existing?.declinedAt ? { declinedAt: existing.declinedAt } : {}),
    ...(existing?.declinedBy ? { declinedBy: existing.declinedBy } : {}),
  };
  persistPairingRequest(request);
  if (request.status === 'pending' && existing?.status !== 'pending') {
    promptPeerOperator(request);
  }
  recordPairingAudit({
    type: 'a2a.pairing.requested',
    requestId,
    pairingId: request.pairingId,
    peerId: request.peerId,
    requestedBy: request.requestedBy,
    publicKeyFingerprint: request.publicKeyFingerprint,
    status: request.status,
  });
  return request;
}

export function approveIncomingA2APairingRequest(params: {
  requestId: string;
  actor?: string;
  reason?: string;
  now?: Date;
}): A2AIncomingPairingRequest {
  const request = getIncomingPairingRequest(params.requestId);
  if (!request) {
    throw new GatewayRequestError(404, 'A2A pairing request not found.');
  }
  const now = params.now ?? new Date();
  const timestamp = now.toISOString();
  const approved: A2AIncomingPairingRequest = {
    ...request,
    status: 'approved',
    updatedAt: timestamp,
    approvedAt: timestamp,
    approvedBy: params.actor?.trim() || 'operator',
    reason: params.reason?.trim() || 'operator approved pairing',
  };
  upsertA2ATrustedPublicKeyPeer(
    {
      peerId: approved.peerId,
      agentCardUrl: approved.agentCardUrl,
      deliveryUrl: approved.deliveryUrl,
      publicKeyJwk: approved.publicKeyJwk,
      publicKeyFingerprint: approved.publicKeyFingerprint,
      reason: approved.reason,
      actor: approved.approvedBy,
    },
    now,
  );
  persistPairingRequest(approved);
  recordPairingAudit({
    type: 'a2a.pairing.approved',
    requestId: approved.requestId,
    pairingId: approved.pairingId,
    peerId: approved.peerId,
    actor: approved.approvedBy,
    publicKeyFingerprint: approved.publicKeyFingerprint,
  });
  return approved;
}

export function declineIncomingA2APairingRequest(params: {
  requestId: string;
  actor?: string;
  reason?: string;
  now?: Date;
}): A2AIncomingPairingRequest {
  const request = getIncomingPairingRequest(params.requestId);
  if (!request) {
    throw new GatewayRequestError(404, 'A2A pairing request not found.');
  }
  const timestamp = (params.now ?? new Date()).toISOString();
  const declined: A2AIncomingPairingRequest = {
    ...request,
    status: 'declined',
    updatedAt: timestamp,
    declinedAt: timestamp,
    declinedBy: params.actor?.trim() || 'operator',
    reason: params.reason?.trim() || 'operator declined pairing',
  };
  persistPairingRequest(declined);
  recordPairingAudit({
    type: 'a2a.pairing.declined',
    requestId: declined.requestId,
    pairingId: declined.pairingId,
    peerId: declined.peerId,
    actor: declined.declinedBy,
    publicKeyFingerprint: declined.publicKeyFingerprint,
    reason: declined.reason,
  });
  return declined;
}

export async function handleA2APairingRequestInbound(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (url.pathname !== A2A_PAIRING_REQUEST_PATH) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }
  try {
    const body = (
      await readRequestBody(req, A2A_PAIRING_MAX_BODY_BYTES)
    ).toString('utf-8');
    const request = createIncomingA2APairingRequest(JSON.parse(body));
    sendJson(res, 202, {
      requestId: request.requestId,
      status: request.status,
    });
  } catch (error) {
    sendJson(
      res,
      error instanceof GatewayRequestError ? error.statusCode : 400,
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
}
