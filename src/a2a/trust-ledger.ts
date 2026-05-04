import path from 'node:path';

import {
  getRuntimeAssetRevisionState,
  listRuntimeAssetRevisionStates,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { parseSecretInput, type SecretRef } from '../security/secret-refs.js';
import { A2AEnvelopeValidationError, classifyA2AAgentId } from './envelope.js';
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

function normalizeSenderAgentId(senderAgentId: string): string {
  const normalized = senderAgentId.trim();
  const kind = classifyA2AAgentId(normalized);
  if (kind === 'canonical') return normalized.toLowerCase();
  if (kind === 'local') return normalized;
  throw new A2AEnvelopeValidationError([
    'senderAgentId must be a local agent id or canonical agent id (agent-slug@user@instance-id)',
  ]);
}

function normalizeSecretRef(value: unknown): SecretRef {
  const parsed = parseSecretInput(value);
  if (parsed.kind === 'invalid') {
    throw new A2AEnvelopeValidationError([`secretRef ${parsed.reason}`]);
  }
  if (parsed.kind === 'plain') {
    throw new A2AEnvelopeValidationError([
      'secretRef must be a secret reference',
    ]);
  }
  return parsed.ref;
}

function normalizeOptionalHttpHeaderName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new A2AEnvelopeValidationError([
      'signatureHeader must be a string when provided',
    ]);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new A2AEnvelopeValidationError([
      'signatureHeader must not be empty when provided',
    ]);
  }
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(normalized)) {
    throw new A2AEnvelopeValidationError([
      'signatureHeader must be a valid HTTP header name',
    ]);
  }
  return normalized;
}

function normalizeWebhookVersion(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new A2AEnvelopeValidationError([
      'version must be a string when provided',
    ]);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new A2AEnvelopeValidationError([
      'version must not be empty when provided',
    ]);
  }
  if (normalized !== WEBHOOK_BODY_VERSION) {
    throw new A2AEnvelopeValidationError([
      `version must be ${WEBHOOK_BODY_VERSION} when provided`,
    ]);
  }
  return normalized;
}

function normalizeTrustedWebhookPeerConfig(params: {
  secretRef: unknown;
  signatureHeader?: unknown;
  version?: unknown;
}): Pick<A2ATrustedWebhookPeer, 'secretRef' | 'signatureHeader' | 'version'> {
  return {
    secretRef: normalizeSecretRef(params.secretRef),
    signatureHeader:
      normalizeOptionalHttpHeaderName(params.signatureHeader) ||
      WEBHOOK_SIGNATURE_HEADER,
    version: normalizeWebhookVersion(params.version) || WEBHOOK_BODY_VERSION,
  };
}

function parseTrustedWebhookPeer(raw: string): A2ATrustedWebhookPeer | null {
  try {
    const parsed = JSON.parse(raw) as A2ATrustedWebhookPeer;
    if (parsed.schemaVersion !== TRUSTED_WEBHOOK_PEER_SCHEMA_VERSION) {
      return null;
    }
    const webhookConfig = normalizeTrustedWebhookPeerConfig({
      secretRef: parsed.secretRef,
      signatureHeader: parsed.signatureHeader,
      version: parsed.version,
    });
    return {
      schemaVersion: TRUSTED_WEBHOOK_PEER_SCHEMA_VERSION,
      peerId: normalizeA2APeerId(parsed.peerId),
      senderAgentId: normalizeSenderAgentId(parsed.senderAgentId),
      secretRef: webhookConfig.secretRef,
      signatureHeader: webhookConfig.signatureHeader,
      version: webhookConfig.version,
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
  const webhookConfig = normalizeTrustedWebhookPeerConfig(input);
  const existing = getA2ATrustedWebhookPeer(peerId);
  const updatedAt = now.toISOString();
  const peer: A2ATrustedWebhookPeer = {
    schemaVersion: TRUSTED_WEBHOOK_PEER_SCHEMA_VERSION,
    peerId,
    senderAgentId: normalizeSenderAgentId(input.senderAgentId),
    secretRef: webhookConfig.secretRef,
    signatureHeader: webhookConfig.signatureHeader,
    version: webhookConfig.version,
    replayWindowMs: normalizePositiveInteger(
      input.replayWindowMs,
      WEBHOOK_REPLAY_WINDOW_MS,
    ),
    rateLimitPerMinute: normalizePositiveInteger(
      input.rateLimitPerMinute,
      A2A_TRUST_LEDGER_DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE,
    ),
    createdAt: existing?.createdAt || updatedAt,
    updatedAt,
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
  const state = getRuntimeAssetRevisionState(
    'a2a',
    trustedWebhookPeerAssetPath(peerId),
  );
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
