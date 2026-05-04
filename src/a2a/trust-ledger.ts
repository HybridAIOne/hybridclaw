import path from 'node:path';

import {
  listRuntimeAssetRevisionStates,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import type { SecretRef } from '../security/secret-refs.js';
import { A2AEnvelopeValidationError, validateA2AEnvelope } from './envelope.js';
import {
  normalizePeerDescriptor,
  type WebhookPeerDescriptor,
} from './peer-descriptor.js';
import {
  WEBHOOK_BODY_VERSION,
  WEBHOOK_REPLAY_WINDOW_MS,
  WEBHOOK_SIGNATURE_HEADER,
} from './webhook-outbound.js';

export const A2A_TRUST_LEDGER_DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;

const TRUSTED_WEBHOOK_PEER_SCHEMA_VERSION = 1;
const TRUSTED_WEBHOOK_PEER_ASSET_PREFIX = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'a2a',
  'trust-ledger',
  'webhook',
);
const PEER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface A2ATrustedWebhookPeer {
  schemaVersion: typeof TRUSTED_WEBHOOK_PEER_SCHEMA_VERSION;
  peerId: string;
  senderAgentId: string;
  secretRef: SecretRef;
  signatureHeader: string;
  version: string;
  replayWindowMs: number;
  rateLimitPerMinute: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertA2ATrustedWebhookPeerInput {
  peerId: string;
  senderAgentId: string;
  secretRef: SecretRef;
  signatureHeader?: string;
  version?: string;
  replayWindowMs?: number;
  rateLimitPerMinute?: number;
}

export function normalizeA2APeerId(peerId: string): string {
  const normalized = peerId.trim();
  if (!PEER_ID_PATTERN.test(normalized)) {
    throw new A2AEnvelopeValidationError([
      'peerId must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/',
    ]);
  }
  return normalized;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function trustedWebhookPeerAssetPath(peerId: string): string {
  return path.join(
    TRUSTED_WEBHOOK_PEER_ASSET_PREFIX,
    `${encodeURIComponent(normalizeA2APeerId(peerId))}.json`,
  );
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function normalizeSenderAgentId(senderAgentId: string): string {
  return validateA2AEnvelope({
    id: 'peer-validation',
    sender_agent_id: senderAgentId,
    recipient_agent_id: 'main',
    thread_id: 'peer-validation',
    intent: 'chat',
    content: '',
    created_at: '2026-05-01T00:00:00.000Z',
  }).sender_agent_id;
}

function normalizeWebhookDescriptor(params: {
  secretRef: SecretRef;
  signatureHeader?: string;
  version?: string;
}): WebhookPeerDescriptor {
  const descriptor = normalizePeerDescriptor({
    transport: 'webhook',
    url: 'http://127.0.0.1/a2a',
    secretRef: params.secretRef,
    ...(params.signatureHeader
      ? { signatureHeader: params.signatureHeader }
      : {}),
    ...(params.version ? { version: params.version } : {}),
  });
  if (descriptor.transport !== 'webhook') {
    throw new A2AEnvelopeValidationError(['peer must use webhook transport']);
  }
  return descriptor as WebhookPeerDescriptor;
}

function parseTrustedWebhookPeer(raw: string): A2ATrustedWebhookPeer | null {
  try {
    const parsed = JSON.parse(raw) as A2ATrustedWebhookPeer;
    if (parsed.schemaVersion !== TRUSTED_WEBHOOK_PEER_SCHEMA_VERSION) {
      return null;
    }
    const descriptor = normalizeWebhookDescriptor({
      secretRef: parsed.secretRef,
      signatureHeader: parsed.signatureHeader,
      version: parsed.version,
    });
    return {
      schemaVersion: TRUSTED_WEBHOOK_PEER_SCHEMA_VERSION,
      peerId: normalizeA2APeerId(parsed.peerId),
      senderAgentId: normalizeSenderAgentId(parsed.senderAgentId),
      secretRef: descriptor.secretRef,
      signatureHeader: descriptor.signatureHeader || WEBHOOK_SIGNATURE_HEADER,
      version: descriptor.version || WEBHOOK_BODY_VERSION,
      replayWindowMs: normalizePositiveInteger(
        parsed.replayWindowMs,
        WEBHOOK_REPLAY_WINDOW_MS,
      ),
      rateLimitPerMinute: normalizePositiveInteger(
        parsed.rateLimitPerMinute,
        A2A_TRUST_LEDGER_DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE,
      ),
      createdAt:
        typeof parsed.createdAt === 'string' && parsed.createdAt
          ? parsed.createdAt
          : new Date(0).toISOString(),
      updatedAt:
        typeof parsed.updatedAt === 'string' && parsed.updatedAt
          ? parsed.updatedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function upsertA2ATrustedWebhookPeer(
  input: UpsertA2ATrustedWebhookPeerInput,
  now = new Date(),
): A2ATrustedWebhookPeer {
  const peerId = normalizeA2APeerId(input.peerId);
  const descriptor = normalizeWebhookDescriptor(input);
  const existing = getA2ATrustedWebhookPeer(peerId);
  const peer: A2ATrustedWebhookPeer = {
    schemaVersion: TRUSTED_WEBHOOK_PEER_SCHEMA_VERSION,
    peerId,
    senderAgentId: normalizeSenderAgentId(input.senderAgentId),
    secretRef: descriptor.secretRef,
    signatureHeader: descriptor.signatureHeader || WEBHOOK_SIGNATURE_HEADER,
    version: descriptor.version || WEBHOOK_BODY_VERSION,
    replayWindowMs: normalizePositiveInteger(
      input.replayWindowMs,
      WEBHOOK_REPLAY_WINDOW_MS,
    ),
    rateLimitPerMinute: normalizePositiveInteger(
      input.rateLimitPerMinute,
      A2A_TRUST_LEDGER_DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE,
    ),
    createdAt: existing?.createdAt || nowIso(now),
    updatedAt: nowIso(now),
  };
  syncRuntimeAssetRevisionState(
    'a2a',
    trustedWebhookPeerAssetPath(peerId),
    {
      route: `a2a.trust-ledger.webhook#${peerId}`,
      source: 'a2a-trust-ledger',
    },
    {
      exists: true,
      content: JSON.stringify(peer),
    },
  );
  return peer;
}

export function getA2ATrustedWebhookPeer(
  peerId: string,
): A2ATrustedWebhookPeer | null {
  const state = listRuntimeAssetRevisionStates('a2a', {
    assetPathPrefix: TRUSTED_WEBHOOK_PEER_ASSET_PREFIX,
  }).find((entry) => entry.assetPath === trustedWebhookPeerAssetPath(peerId));
  return state ? parseTrustedWebhookPeer(state.content) : null;
}

export function listA2ATrustedWebhookPeers(): A2ATrustedWebhookPeer[] {
  return listRuntimeAssetRevisionStates('a2a', {
    assetPathPrefix: TRUSTED_WEBHOOK_PEER_ASSET_PREFIX,
  })
    .map((state) => parseTrustedWebhookPeer(state.content))
    .filter((peer): peer is A2ATrustedWebhookPeer => peer !== null)
    .sort((left, right) => left.peerId.localeCompare(right.peerId));
}
