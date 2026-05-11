import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { listAgents } from '../agents/agent-registry.js';
import type { AgentA2AExposure, AgentConfig } from '../agents/agent-types.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  getRuntimeAssetRevisionState,
  listRuntimeAssetRevisionStates,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { resolveLocalInstanceId } from '../identity/agent-id.js';
import { parseSecretInput, type SecretRef } from '../security/secret-refs.js';
import { writeFileAtomicExclusive } from '../utils/atomic-file.js';
import type { A2AAgentCard } from './a2a-json-rpc.js';
import { A2AEnvelopeValidationError, classifyA2AAgentId } from './envelope.js';
import { resolveA2AAgentId } from './identity.js';
import { isRecord, normalizePositiveInteger } from './utils.js';
import {
  WEBHOOK_BODY_VERSION,
  WEBHOOK_REPLAY_WINDOW_MS,
  WEBHOOK_SIGNATURE_HEADER,
} from './webhook-outbound.js';

export const A2A_TRUST_LEDGER_DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;
export const A2A_AGENT_CARD_STREAMING_SUPPORTED = false;
export const A2A_POLICY_AUTHORITY_KINDS = [
  'platform',
  'org_admin',
  'security_team',
] as const;
export type A2APolicyAuthorityKind =
  (typeof A2A_POLICY_AUTHORITY_KINDS)[number];

const TRUSTED_WEBHOOK_PEER_SCHEMA_VERSION = 1;
const TRUSTED_A2A_PEER_SCHEMA_VERSION = 1;
const TRUSTED_WEBHOOK_PEER_ASSET_PREFIX = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'a2a',
  'trust-ledger',
  'webhook',
);
const TRUSTED_A2A_PEER_ASSET_PREFIX = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'a2a',
  'trust-ledger',
  'a2a',
);
const TRUSTED_PUBLIC_KEY_PEER_SCHEMA_VERSION = 1;
const INSTANCE_KEYPAIR_SCHEMA_VERSION = 1;
const INSTANCE_KEYPAIR_PATH = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'a2a',
  'identity-keypair.json',
);
const TRUSTED_PUBLIC_KEY_PEER_ASSET_PREFIX = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'a2a',
  'trust-ledger',
  'public-key',
);
const A2A_TRUST_LEDGER_LAST_SEEN_REFRESH_MS = 60_000;
export const A2A_TRUST_LEDGER_DEFAULT_REVOKE_REASON = 'operator revocation';
const PEER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EPOCH_ISO = new Date(0).toISOString();
const TOFU_AUDIT_SESSION_ID = 'a2a:trust-ledger';

let trustedA2APeersBySenderCache: Map<string, A2ATrustedA2APeer> | null = null;
let trustedA2APeersByPublicKeyCache: Map<string, A2ATrustedA2APeer> | null =
  null;
let cachedInstanceKeypair: A2AInstanceKeypair | null = null;
let cachedInstancePrivateKey: KeyObject | null = null;
let cachedInstancePublicKey: KeyObject | null = null;

export interface A2ATrustedWebhookPeer {
  schemaVersion: typeof TRUSTED_WEBHOOK_PEER_SCHEMA_VERSION;
  peerId: string;
  senderAgentId: string;
  policyAuthority?: A2APolicyAuthorityKind;
  capabilities: string[];
  secretRef: SecretRef;
  signatureHeader: string;
  version: string;
  replayWindowMs: number;
  rateLimitPerMinute: number;
  createdAt: string;
  updatedAt: string;
}

export interface A2AInstanceKeypair {
  schemaVersion: typeof INSTANCE_KEYPAIR_SCHEMA_VERSION;
  instanceId: string;
  algorithm: 'Ed25519';
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
  publicKeyFingerprint: string;
  createdAt: string;
}

export type A2APublicKeyTrustStatus = 'trusted' | 'revoked';
export type A2AAgentCardTrustLevel = 'public' | 'trusted';

// TOFU trust records persist until operator revocation; key changes fail closed
// and emit mismatch audit events.
export interface A2ATrustedPublicKeyPeer {
  schemaVersion: typeof TRUSTED_PUBLIC_KEY_PEER_SCHEMA_VERSION;
  peerId: string;
  agentCardUrl: string;
  deliveryUrl: string;
  publicKeyJwk: JsonWebKey | null;
  publicKeyFingerprint: string;
  status: A2APublicKeyTrustStatus;
  trustedAt: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  revokedAt?: string;
  revokedReason?: string;
  lastMismatchAt?: string;
  lastMismatchFingerprint?: string;
}

export interface A2APeerPublicKeyMaterial {
  peerId: string;
  publicKeyJwk: JsonWebKey;
  publicKeyFingerprint: string;
}

export interface UpsertA2ATrustedPublicKeyPeerInput {
  peerId: string;
  agentCardUrl?: string;
  deliveryUrl?: string;
  publicKeyJwk?: unknown;
  publicKeyFingerprint?: string;
  reason?: string;
}

export interface UpsertA2ATrustedWebhookPeerInput {
  peerId: string;
  senderAgentId: string;
  policyAuthority?: string;
  capabilities?: string[];
  secretRef: SecretRef;
  signatureHeader?: string;
  version?: string;
  replayWindowMs?: number;
  rateLimitPerMinute?: number;
}

export interface BuildLocalA2AAgentCardOptions {
  peerTrustLevel?: A2AAgentCardTrustLevel;
  peerId?: string;
}

export interface A2ATrustedA2APeer {
  schemaVersion: typeof TRUSTED_A2A_PEER_SCHEMA_VERSION;
  peerId: string;
  senderAgentId: string;
  publicKeyPem: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertA2ATrustedA2APeerInput {
  peerId: string;
  senderAgentId: string;
  publicKeyPem: string;
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

function trustedWebhookPeerAssetPath(peerId: string): string {
  return path.join(
    TRUSTED_WEBHOOK_PEER_ASSET_PREFIX,
    `${encodeURIComponent(normalizeA2APeerId(peerId))}.json`,
  );
}

function trustedA2APeerAssetPath(peerId: string): string {
  return path.join(
    TRUSTED_A2A_PEER_ASSET_PREFIX,
    `${encodeURIComponent(normalizeA2APeerId(peerId))}.json`,
  );
}

function trustedPublicKeyPeerAssetPath(peerId: string): string {
  return path.join(
    TRUSTED_PUBLIC_KEY_PEER_ASSET_PREFIX,
    `${encodeURIComponent(normalizeA2APeerId(peerId))}.json`,
  );
}

export function fingerprintA2APublicKey(publicKeyJwk: JsonWebKey): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kty: publicKeyJwk.kty,
        crv: publicKeyJwk.crv,
        x: publicKeyJwk.x,
      }),
    )
    .digest('base64url');
}

function normalizePublicKeyFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new A2AEnvelopeValidationError(['publicKeyFingerprint is required']);
  }
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(normalized)) {
    throw new A2AEnvelopeValidationError([
      'publicKeyFingerprint must be a sha256 base64url fingerprint',
    ]);
  }
  return normalized;
}

function normalizePublicKeyJwk(value: unknown): JsonWebKey {
  if (!isRecord(value)) {
    throw new A2AEnvelopeValidationError(['publicKeyJwk must be an object']);
  }
  const jwk = { ...value } as JsonWebKey;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new A2AEnvelopeValidationError([
      'publicKeyJwk must be an Ed25519 public JWK',
    ]);
  }
  if ('d' in jwk) {
    throw new A2AEnvelopeValidationError([
      'publicKeyJwk must not include private key material',
    ]);
  }
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: jwk.x,
    ...(typeof jwk.kid === 'string' && jwk.kid.trim()
      ? { kid: jwk.kid.trim() }
      : {}),
  };
}

function normalizePrivateKeyJwk(value: unknown): JsonWebKey {
  if (!isRecord(value)) {
    throw new A2AEnvelopeValidationError(['privateKeyJwk must be an object']);
  }
  const jwk = { ...value } as JsonWebKey;
  if (
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string' ||
    typeof jwk.d !== 'string'
  ) {
    throw new A2AEnvelopeValidationError([
      'privateKeyJwk must be an Ed25519 private JWK',
    ]);
  }
  return jwk;
}

function normalizeOptionalUrl(value: unknown, field: string): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    throw new A2AEnvelopeValidationError([`${field} must be a string`]);
  }
  const normalized = value.trim();
  if (!normalized) return '';
  try {
    new URL(normalized);
  } catch {
    throw new A2AEnvelopeValidationError([`${field} must be a valid URL`]);
  }
  return normalized;
}

function readKeypairState(): A2AInstanceKeypair | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(INSTANCE_KEYPAIR_PATH, 'utf-8'),
    ) as A2AInstanceKeypair;
    if (parsed.schemaVersion !== INSTANCE_KEYPAIR_SCHEMA_VERSION) return null;
    const publicKeyJwk = normalizePublicKeyJwk(parsed.publicKeyJwk);
    const privateKeyJwk = normalizePrivateKeyJwk(parsed.privateKeyJwk);
    const fingerprint = fingerprintA2APublicKey(publicKeyJwk);
    return {
      schemaVersion: INSTANCE_KEYPAIR_SCHEMA_VERSION,
      instanceId: normalizeA2APeerId(parsed.instanceId),
      algorithm: 'Ed25519',
      publicKeyJwk,
      privateKeyJwk,
      publicKeyFingerprint: fingerprint,
      createdAt:
        typeof parsed.createdAt === 'string' && parsed.createdAt
          ? parsed.createdAt
          : new Date(0).toISOString(),
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return null;
    throw error;
  }
}

function writeNewKeypairState(state: A2AInstanceKeypair): void {
  writeFileAtomicExclusive(
    INSTANCE_KEYPAIR_PATH,
    `${JSON.stringify(state, null, 2)}\n`,
    {
      tempPrefix: 'identity-keypair',
      dirMode: 0o700,
      fileMode: 0o600,
    },
  );
}

function cacheInstanceKeypair(state: A2AInstanceKeypair): A2AInstanceKeypair {
  cachedInstanceKeypair = state;
  cachedInstancePrivateKey = null;
  cachedInstancePublicKey = null;
  return state;
}

export function ensureA2AInstanceKeypair(now = new Date()): A2AInstanceKeypair {
  if (cachedInstanceKeypair) return cachedInstanceKeypair;

  const existing = readKeypairState();
  if (existing) return cacheInstanceKeypair(existing);

  const generated = generateKeyPairSync('ed25519');
  const publicKeyJwk = normalizePublicKeyJwk(
    generated.publicKey.export({ format: 'jwk' }),
  );
  const privateKeyJwk = normalizePrivateKeyJwk(
    generated.privateKey.export({ format: 'jwk' }),
  );
  const publicKeyFingerprint = fingerprintA2APublicKey(publicKeyJwk);
  const state: A2AInstanceKeypair = {
    schemaVersion: INSTANCE_KEYPAIR_SCHEMA_VERSION,
    instanceId: resolveLocalInstanceId(),
    algorithm: 'Ed25519',
    publicKeyJwk: {
      ...publicKeyJwk,
      kid: publicKeyJwk.kid || publicKeyFingerprint,
    },
    privateKeyJwk,
    publicKeyFingerprint,
    createdAt: now.toISOString(),
  };

  try {
    writeNewKeypairState(state);
    return cacheInstanceKeypair(state);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== 'EEXIST') throw error;
    const racedState = readKeypairState();
    if (racedState) return cacheInstanceKeypair(racedState);
    throw error;
  }
}

export function getA2AInstancePrivateKey(): KeyObject {
  if (cachedInstancePrivateKey) return cachedInstancePrivateKey;
  cachedInstancePrivateKey = createPrivateKey({
    key: ensureA2AInstanceKeypair().privateKeyJwk,
    format: 'jwk',
  });
  return cachedInstancePrivateKey;
}

export function getA2AInstancePublicKey(): KeyObject {
  if (cachedInstancePublicKey) return cachedInstancePublicKey;
  cachedInstancePublicKey = createPublicKey({
    key: ensureA2AInstanceKeypair().publicKeyJwk,
    format: 'jwk',
  });
  return cachedInstancePublicKey;
}

function exposureVisibleTo(
  exposure: AgentA2AExposure | undefined,
  trustLevel: A2AAgentCardTrustLevel,
): boolean {
  const normalized = exposure || 'public';
  if (normalized === 'private') return false;
  if (normalized === 'trusted') return trustLevel === 'trusted';
  return true;
}

function agentDisplayName(agent: AgentConfig): string {
  return agent.displayName || agent.name || agent.id;
}

function agentDescription(agent: AgentConfig): string {
  return agent.cv?.summary || agent.role || 'HybridClaw agent';
}

function visibleAgentSkills(
  agent: AgentConfig,
  trustLevel: A2AAgentCardTrustLevel,
): string[] {
  return (agent.skills ?? []).filter((skill) =>
    exposureVisibleTo(agent.a2a?.skillExposure?.[skill], trustLevel),
  );
}

function buildAgentCardAgentEntry(
  agent: AgentConfig,
  canonicalAgentId: string,
  skills: string[],
): Record<string, unknown> {
  return {
    id: canonicalAgentId,
    name: agentDisplayName(agent),
    description: agentDescription(agent),
    skills,
    metadata: {
      hybridclaw: {
        localAgentId: agent.id,
        owner: agent.owner || null,
        exposure: agent.a2a?.exposure || 'public',
      },
    },
  };
}

function buildAgentCardSkillEntries(
  agent: AgentConfig,
  canonicalAgentId: string,
  skills: string[],
): Record<string, unknown>[] {
  return skills.map((skill) => ({
    id: `${canonicalAgentId}:skill:${skill}`,
    name: skill,
    agentId: canonicalAgentId,
    metadata: {
      hybridclaw: {
        localAgentId: agent.id,
        skill,
        exposure: agent.a2a?.skillExposure?.[skill] || 'public',
      },
    },
  }));
}

function visibleA2AAgents(trustLevel: A2AAgentCardTrustLevel): AgentConfig[] {
  return listAgents().filter((agent) =>
    exposureVisibleTo(agent.a2a?.exposure, trustLevel),
  );
}

export function buildLocalA2AAgentCard(
  baseUrl: string,
  options: BuildLocalA2AAgentCardOptions = {},
): A2AAgentCard {
  const url = new URL(baseUrl);
  const identity = ensureA2AInstanceKeypair();
  const peerTrustLevel = options.peerTrustLevel || 'public';
  const agents = visibleA2AAgents(peerTrustLevel).map((agent) => ({
    agent,
    canonicalAgentId: resolveA2AAgentId(agent.id),
    skills: visibleAgentSkills(agent, peerTrustLevel),
  }));
  return {
    name: 'HybridClaw',
    url: new URL('/a2a', url.origin).toString(),
    capabilities: {
      messageSend: true,
      tasksSend: true,
      streaming: A2A_AGENT_CARD_STREAMING_SUPPORTED,
    },
    agents: agents.map(({ agent, canonicalAgentId, skills }) =>
      buildAgentCardAgentEntry(agent, canonicalAgentId, skills),
    ),
    skills: agents.flatMap(({ agent, canonicalAgentId, skills }) =>
      buildAgentCardSkillEntries(agent, canonicalAgentId, skills),
    ),
    hybridclaw: {
      instanceId: identity.instanceId,
      peerTrustLevel,
      peerId: options.peerId || null,
      // This TOFU identity key identifies Agent Cards; delegation JWT verification
      // uses delegation-token.ts until key distribution is unified.
      publicKeyJwk: identity.publicKeyJwk,
      publicKeyFingerprint: identity.publicKeyFingerprint,
      trustModel: 'tofu-ed25519-v1',
    },
  };
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

function normalizeCanonicalSenderAgentId(senderAgentId: string): string {
  const normalized = normalizeSenderAgentId(senderAgentId);
  if (classifyA2AAgentId(normalized) !== 'canonical') {
    throw new A2AEnvelopeValidationError([
      'senderAgentId must be a canonical agent id (agent-slug@user@instance-id)',
    ]);
  }
  return normalized.toLowerCase();
}

function normalizePublicKeyPem(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new A2AEnvelopeValidationError(['publicKeyPem is required']);
  }
  try {
    return createPublicKey(value)
      .export({ format: 'pem', type: 'spki' })
      .toString();
  } catch {
    throw new A2AEnvelopeValidationError([
      'publicKeyPem must be a valid public key',
    ]);
  }
}

function normalizePublicKeyPemText(value: string): string {
  return value.trim().replace(/\r\n/g, '\n');
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

function parseTimestampOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((entry) =>
          String(entry || '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ].sort();
}

function normalizePolicyAuthority(
  value: unknown,
): A2APolicyAuthorityKind | undefined {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (
    A2A_POLICY_AUTHORITY_KINDS.includes(normalized as A2APolicyAuthorityKind)
  ) {
    return normalized as A2APolicyAuthorityKind;
  }
  return undefined;
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
    const policyAuthority = normalizePolicyAuthority(parsed.policyAuthority);
    return {
      schemaVersion: TRUSTED_WEBHOOK_PEER_SCHEMA_VERSION,
      peerId: normalizeA2APeerId(parsed.peerId),
      senderAgentId: normalizeSenderAgentId(parsed.senderAgentId),
      ...(policyAuthority ? { policyAuthority } : {}),
      capabilities: normalizeCapabilities(parsed.capabilities),
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
      createdAt: parseTimestampOr(parsed.createdAt, EPOCH_ISO),
      updatedAt: parseTimestampOr(parsed.updatedAt, EPOCH_ISO),
    };
  } catch {
    return null;
  }
}

function parseTrustedA2APeer(raw: string): A2ATrustedA2APeer | null {
  try {
    const parsed = JSON.parse(raw) as A2ATrustedA2APeer;
    if (parsed.schemaVersion !== TRUSTED_A2A_PEER_SCHEMA_VERSION) {
      return null;
    }
    return {
      schemaVersion: TRUSTED_A2A_PEER_SCHEMA_VERSION,
      peerId: normalizeA2APeerId(parsed.peerId),
      senderAgentId: normalizeCanonicalSenderAgentId(parsed.senderAgentId),
      publicKeyPem: normalizePublicKeyPem(parsed.publicKeyPem),
      createdAt: parseTimestampOr(parsed.createdAt, EPOCH_ISO),
      updatedAt: parseTimestampOr(parsed.updatedAt, EPOCH_ISO),
    };
  } catch {
    return null;
  }
}

function normalizeTrustStatus(value: unknown): A2APublicKeyTrustStatus {
  return value === 'revoked' ? 'revoked' : 'trusted';
}

function parseTrustedPublicKeyPeer(
  raw: string,
): A2ATrustedPublicKeyPeer | null {
  try {
    const parsed = JSON.parse(raw) as A2ATrustedPublicKeyPeer;
    if (parsed.schemaVersion !== TRUSTED_PUBLIC_KEY_PEER_SCHEMA_VERSION) {
      return null;
    }
    const publicKeyJwk =
      parsed.publicKeyJwk === null || parsed.publicKeyJwk === undefined
        ? null
        : normalizePublicKeyJwk(parsed.publicKeyJwk);
    const fingerprint = publicKeyJwk
      ? fingerprintA2APublicKey(publicKeyJwk)
      : normalizePublicKeyFingerprint(parsed.publicKeyFingerprint);
    return {
      schemaVersion: TRUSTED_PUBLIC_KEY_PEER_SCHEMA_VERSION,
      peerId: normalizeA2APeerId(parsed.peerId),
      agentCardUrl:
        typeof parsed.agentCardUrl === 'string' ? parsed.agentCardUrl : '',
      deliveryUrl:
        typeof parsed.deliveryUrl === 'string' ? parsed.deliveryUrl : '',
      publicKeyJwk,
      publicKeyFingerprint: fingerprint,
      status: normalizeTrustStatus(parsed.status),
      trustedAt: parseTimestampOr(parsed.trustedAt, EPOCH_ISO),
      createdAt: parseTimestampOr(parsed.createdAt, EPOCH_ISO),
      updatedAt: parseTimestampOr(parsed.updatedAt, EPOCH_ISO),
      lastSeenAt: parseTimestampOr(parsed.lastSeenAt, EPOCH_ISO),
      ...(typeof parsed.revokedAt === 'string' && parsed.revokedAt
        ? { revokedAt: parsed.revokedAt }
        : {}),
      ...(typeof parsed.revokedReason === 'string' && parsed.revokedReason
        ? { revokedReason: parsed.revokedReason }
        : {}),
      ...(typeof parsed.lastMismatchAt === 'string' && parsed.lastMismatchAt
        ? { lastMismatchAt: parsed.lastMismatchAt }
        : {}),
      ...(typeof parsed.lastMismatchFingerprint === 'string' &&
      parsed.lastMismatchFingerprint
        ? { lastMismatchFingerprint: parsed.lastMismatchFingerprint }
        : {}),
    };
  } catch {
    return null;
  }
}

function shouldRefreshTrustedPublicKeyPeer(
  peer: A2ATrustedPublicKeyPeer,
  params: { agentCardUrl: string; deliveryUrl: string; now: Date },
): boolean {
  if (
    peer.agentCardUrl !== params.agentCardUrl ||
    peer.deliveryUrl !== params.deliveryUrl
  ) {
    return true;
  }
  const lastSeenMs = Date.parse(peer.lastSeenAt);
  if (!Number.isFinite(lastSeenMs)) return true;
  return (
    params.now.getTime() - lastSeenMs >= A2A_TRUST_LEDGER_LAST_SEEN_REFRESH_MS
  );
}

function persistTrustedPublicKeyPeer(peer: A2ATrustedPublicKeyPeer): void {
  syncRuntimeAssetRevisionState(
    'a2a',
    trustedPublicKeyPeerAssetPath(peer.peerId),
    {
      route: `a2a.trust-ledger.public-key#${peer.peerId}`,
      source: 'a2a-trust-ledger',
    },
    {
      exists: true,
      content: JSON.stringify(peer),
    },
  );
}

function resolveOperatorPublicKeyInput(
  input: UpsertA2ATrustedPublicKeyPeerInput,
): { publicKeyJwk: JsonWebKey | null; publicKeyFingerprint: string } {
  const publicKeyJwk =
    input.publicKeyJwk === undefined || input.publicKeyJwk === null
      ? null
      : normalizePublicKeyJwk(input.publicKeyJwk);
  const derivedFingerprint = publicKeyJwk
    ? fingerprintA2APublicKey(publicKeyJwk)
    : null;
  const providedFingerprint =
    input.publicKeyFingerprint === undefined ||
    input.publicKeyFingerprint === null
      ? null
      : normalizePublicKeyFingerprint(input.publicKeyFingerprint);
  if (!derivedFingerprint && !providedFingerprint) {
    throw new A2AEnvelopeValidationError([
      'publicKeyJwk or publicKeyFingerprint is required',
    ]);
  }
  if (
    derivedFingerprint &&
    providedFingerprint &&
    derivedFingerprint !== providedFingerprint
  ) {
    throw new A2AEnvelopeValidationError([
      'publicKeyFingerprint does not match publicKeyJwk',
    ]);
  }
  return {
    publicKeyJwk,
    publicKeyFingerprint: providedFingerprint || derivedFingerprint || '',
  };
}

function recordTrustAudit(params: {
  runId?: string;
  event: Record<string, unknown> & { type: string };
}): void {
  recordAuditEvent({
    sessionId: TOFU_AUDIT_SESSION_ID,
    runId: params.runId || makeAuditRunId('a2a-trust'),
    event: params.event,
  });
}

function readHybridClawCardMetadata(
  card: A2AAgentCard,
): Record<string, unknown> {
  return isRecord(card.hybridclaw) ? card.hybridclaw : {};
}

function normalizePeerIdFromAgentCard(card: A2AAgentCard): string {
  const metadata = readHybridClawCardMetadata(card);
  const candidate =
    typeof metadata.instanceId === 'string' && metadata.instanceId
      ? metadata.instanceId
      : new URL(card.url).host;
  return normalizeA2APeerId(candidate);
}

export function extractA2APeerPublicKey(
  card: A2AAgentCard,
): A2APeerPublicKeyMaterial | null {
  const metadata = readHybridClawCardMetadata(card);
  if (!metadata.publicKeyJwk) return null;
  const publicKeyJwk = normalizePublicKeyJwk(metadata.publicKeyJwk);
  return {
    peerId: normalizePeerIdFromAgentCard(card),
    publicKeyJwk,
    publicKeyFingerprint: fingerprintA2APublicKey(publicKeyJwk),
  };
}

export function getA2ATrustedPublicKeyPeer(
  peerId: string,
): A2ATrustedPublicKeyPeer | null {
  const state = getRuntimeAssetRevisionState(
    'a2a',
    trustedPublicKeyPeerAssetPath(peerId),
  );
  return state ? parseTrustedPublicKeyPeer(state.content) : null;
}

export function listA2ATrustedPublicKeyPeers(): A2ATrustedPublicKeyPeer[] {
  return listRuntimeAssetRevisionStates('a2a', {
    assetPathPrefix: TRUSTED_PUBLIC_KEY_PEER_ASSET_PREFIX,
  })
    .map((state) => parseTrustedPublicKeyPeer(state.content))
    .filter((peer): peer is A2ATrustedPublicKeyPeer => peer !== null)
    .sort((left, right) => left.peerId.localeCompare(right.peerId));
}

export function assertA2APeerPublicKeyTrust(params: {
  agentCardUrl: string;
  deliveryUrl: string;
  key: A2APeerPublicKeyMaterial;
  runId?: string;
  now?: Date;
}): A2ATrustedPublicKeyPeer {
  const now = params.now ?? new Date();
  const timestamp = now.toISOString();
  const existing = getA2ATrustedPublicKeyPeer(params.key.peerId);
  if (!existing) {
    const trusted: A2ATrustedPublicKeyPeer = {
      schemaVersion: TRUSTED_PUBLIC_KEY_PEER_SCHEMA_VERSION,
      peerId: params.key.peerId,
      agentCardUrl: params.agentCardUrl,
      deliveryUrl: params.deliveryUrl,
      publicKeyJwk: params.key.publicKeyJwk,
      publicKeyFingerprint: params.key.publicKeyFingerprint,
      status: 'trusted',
      trustedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
    };
    persistTrustedPublicKeyPeer(trusted);
    recordTrustAudit({
      runId: params.runId,
      event: {
        type: 'a2a.trust.granted',
        peerId: trusted.peerId,
        agentCardUrl: trusted.agentCardUrl,
        deliveryUrl: trusted.deliveryUrl,
        publicKeyFingerprint: trusted.publicKeyFingerprint,
        grant: 'tofu',
      },
    });
    return trusted;
  }

  if (existing.publicKeyFingerprint !== params.key.publicKeyFingerprint) {
    const mismatch: A2ATrustedPublicKeyPeer = {
      ...existing,
      agentCardUrl: params.agentCardUrl,
      deliveryUrl: params.deliveryUrl,
      updatedAt: timestamp,
      lastMismatchAt: timestamp,
      lastMismatchFingerprint: params.key.publicKeyFingerprint,
    };
    persistTrustedPublicKeyPeer(mismatch);
    recordTrustAudit({
      runId: params.runId,
      event: {
        type: 'a2a.trust.mismatch',
        peerId: existing.peerId,
        agentCardUrl: params.agentCardUrl,
        deliveryUrl: params.deliveryUrl,
        expectedPublicKeyFingerprint: existing.publicKeyFingerprint,
        observedPublicKeyFingerprint: params.key.publicKeyFingerprint,
        severity: 'high',
      },
    });
    throw new Error(
      `A2A peer public key mismatch for ${existing.peerId}; refusing delivery`,
    );
  }

  if (existing.status === 'revoked') {
    throw new Error(`A2A peer trust has been revoked for ${existing.peerId}`);
  }

  if (!existing.publicKeyJwk) {
    const hydrated: A2ATrustedPublicKeyPeer = {
      ...existing,
      agentCardUrl: params.agentCardUrl,
      deliveryUrl: params.deliveryUrl,
      publicKeyJwk: params.key.publicKeyJwk,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
    };
    persistTrustedPublicKeyPeer(hydrated);
    recordTrustAudit({
      runId: params.runId,
      event: {
        type: 'a2a.trust.pin_matched',
        peerId: hydrated.peerId,
        agentCardUrl: hydrated.agentCardUrl,
        deliveryUrl: hydrated.deliveryUrl,
        publicKeyFingerprint: hydrated.publicKeyFingerprint,
      },
    });
    return hydrated;
  }

  if (
    !shouldRefreshTrustedPublicKeyPeer(existing, {
      agentCardUrl: params.agentCardUrl,
      deliveryUrl: params.deliveryUrl,
      now,
    })
  ) {
    return existing;
  }

  const refreshed: A2ATrustedPublicKeyPeer = {
    ...existing,
    agentCardUrl: params.agentCardUrl,
    deliveryUrl: params.deliveryUrl,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
  };
  persistTrustedPublicKeyPeer(refreshed);
  return refreshed;
}

export function revokeA2ATrustedPublicKeyPeer(
  peerId: string,
  params: { reason?: string; runId?: string; now?: Date } = {},
): A2ATrustedPublicKeyPeer {
  const normalizedPeerId = normalizeA2APeerId(peerId);
  const existing = getA2ATrustedPublicKeyPeer(normalizedPeerId);
  if (!existing) {
    throw new A2AEnvelopeValidationError([
      `trusted public-key peer not found: ${normalizedPeerId}`,
    ]);
  }
  const timestamp = (params.now ?? new Date()).toISOString();
  const revoked: A2ATrustedPublicKeyPeer = {
    ...existing,
    status: 'revoked',
    updatedAt: timestamp,
    revokedAt: timestamp,
    revokedReason:
      params.reason?.trim() || A2A_TRUST_LEDGER_DEFAULT_REVOKE_REASON,
  };
  persistTrustedPublicKeyPeer(revoked);
  recordTrustAudit({
    runId: params.runId,
    event: {
      type: 'a2a.trust.revoked',
      peerId: revoked.peerId,
      agentCardUrl: revoked.agentCardUrl,
      deliveryUrl: revoked.deliveryUrl,
      publicKeyFingerprint: revoked.publicKeyFingerprint,
      reason: revoked.revokedReason,
    },
  });
  return revoked;
}

export function upsertA2ATrustedPublicKeyPeer(
  input: UpsertA2ATrustedPublicKeyPeerInput,
  now = new Date(),
): A2ATrustedPublicKeyPeer {
  const peerId = normalizeA2APeerId(input.peerId);
  const existing = getA2ATrustedPublicKeyPeer(peerId);
  const key = resolveOperatorPublicKeyInput(input);
  const timestamp = now.toISOString();
  const peer: A2ATrustedPublicKeyPeer = {
    schemaVersion: TRUSTED_PUBLIC_KEY_PEER_SCHEMA_VERSION,
    peerId,
    agentCardUrl:
      normalizeOptionalUrl(input.agentCardUrl, 'agentCardUrl') ||
      existing?.agentCardUrl ||
      '',
    deliveryUrl:
      normalizeOptionalUrl(input.deliveryUrl, 'deliveryUrl') ||
      existing?.deliveryUrl ||
      '',
    publicKeyJwk:
      key.publicKeyJwk ||
      (existing?.publicKeyFingerprint === key.publicKeyFingerprint
        ? existing.publicKeyJwk
        : null),
    publicKeyFingerprint: key.publicKeyFingerprint,
    status: 'trusted',
    trustedAt: timestamp,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
  };
  persistTrustedPublicKeyPeer(peer);
  recordTrustAudit({
    event: {
      type: 'a2a.trust.operator_override',
      peerId: peer.peerId,
      agentCardUrl: peer.agentCardUrl,
      deliveryUrl: peer.deliveryUrl,
      publicKeyFingerprint: peer.publicKeyFingerprint,
      previousStatus: existing?.status || null,
      previousPublicKeyFingerprint: existing?.publicKeyFingerprint || null,
      reason: input.reason?.trim() || null,
      publicKeyMaterial: peer.publicKeyJwk ? 'jwk' : 'fingerprint',
    },
  });
  return peer;
}

export function deleteA2ATrustedPublicKeyPeer(peerId: string): void {
  const normalizedPeerId = normalizeA2APeerId(peerId);
  const existing = getA2ATrustedPublicKeyPeer(normalizedPeerId);
  syncRuntimeAssetRevisionState(
    'a2a',
    trustedPublicKeyPeerAssetPath(normalizedPeerId),
    {
      route: `a2a.trust-ledger.public-key#${normalizedPeerId}`,
      source: 'a2a-trust-ledger',
    },
    { exists: false, content: null },
  );
  if (existing) {
    recordTrustAudit({
      event: {
        type: 'a2a.trust.deleted',
        peerId: existing.peerId,
        publicKeyFingerprint: existing.publicKeyFingerprint,
        previousStatus: existing.status,
      },
    });
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
  const policyAuthority = normalizePolicyAuthority(input.policyAuthority);
  const peer: A2ATrustedWebhookPeer = {
    schemaVersion: TRUSTED_WEBHOOK_PEER_SCHEMA_VERSION,
    peerId,
    senderAgentId: normalizeSenderAgentId(input.senderAgentId),
    ...(policyAuthority ? { policyAuthority } : {}),
    capabilities: normalizeCapabilities(input.capabilities),
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

export function upsertA2ATrustedA2APeer(
  input: UpsertA2ATrustedA2APeerInput,
  now = new Date(),
): A2ATrustedA2APeer {
  const peerId = normalizeA2APeerId(input.peerId);
  const existing = getA2ATrustedA2APeer(peerId);
  const updatedAt = now.toISOString();
  const peer: A2ATrustedA2APeer = {
    schemaVersion: TRUSTED_A2A_PEER_SCHEMA_VERSION,
    peerId,
    senderAgentId: normalizeCanonicalSenderAgentId(input.senderAgentId),
    publicKeyPem: normalizePublicKeyPem(input.publicKeyPem),
    createdAt: existing?.createdAt || updatedAt,
    updatedAt,
  };
  syncRuntimeAssetRevisionState(
    'a2a',
    trustedA2APeerAssetPath(peerId),
    {
      route: `a2a.trust-ledger.a2a#${peerId}`,
      source: 'a2a-trust-ledger',
    },
    {
      exists: true,
      content: JSON.stringify(peer),
    },
  );
  trustedA2APeersBySenderCache = null;
  trustedA2APeersByPublicKeyCache = null;
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

export function getA2ATrustedA2APeer(peerId: string): A2ATrustedA2APeer | null {
  const state = getRuntimeAssetRevisionState(
    'a2a',
    trustedA2APeerAssetPath(peerId),
  );
  return state ? parseTrustedA2APeer(state.content) : null;
}

export function listA2ATrustedWebhookPeers(): A2ATrustedWebhookPeer[] {
  return listRuntimeAssetRevisionStates('a2a', {
    assetPathPrefix: TRUSTED_WEBHOOK_PEER_ASSET_PREFIX,
  })
    .map((state) => parseTrustedWebhookPeer(state.content))
    .filter((peer): peer is A2ATrustedWebhookPeer => peer !== null)
    .sort((left, right) => left.peerId.localeCompare(right.peerId));
}

export function listA2ATrustedA2APeers(): A2ATrustedA2APeer[] {
  return listRuntimeAssetRevisionStates('a2a', {
    assetPathPrefix: TRUSTED_A2A_PEER_ASSET_PREFIX,
  })
    .map((state) => parseTrustedA2APeer(state.content))
    .filter((peer): peer is A2ATrustedA2APeer => peer !== null)
    .sort((left, right) => left.peerId.localeCompare(right.peerId));
}

function trustedA2APeersBySender(): Map<string, A2ATrustedA2APeer> {
  if (trustedA2APeersBySenderCache) return trustedA2APeersBySenderCache;
  trustedA2APeersBySenderCache = new Map(
    listA2ATrustedA2APeers().map((peer) => [peer.senderAgentId, peer]),
  );
  return trustedA2APeersBySenderCache;
}

function trustedA2APeersByPublicKey(): Map<string, A2ATrustedA2APeer> {
  if (trustedA2APeersByPublicKeyCache) return trustedA2APeersByPublicKeyCache;
  trustedA2APeersByPublicKeyCache = new Map();
  for (const peer of listA2ATrustedA2APeers()) {
    const publicKey = normalizePublicKeyPemText(peer.publicKeyPem);
    if (!trustedA2APeersByPublicKeyCache.has(publicKey)) {
      trustedA2APeersByPublicKeyCache.set(publicKey, peer);
    }
  }
  return trustedA2APeersByPublicKeyCache;
}

export function getA2ATrustedA2APeerBySender(
  senderAgentId: string,
): A2ATrustedA2APeer | null {
  const normalizedSenderAgentId =
    normalizeCanonicalSenderAgentId(senderAgentId);
  return trustedA2APeersBySender().get(normalizedSenderAgentId) ?? null;
}

export function getA2ATrustedA2APeerByPublicKeyPem(
  publicKeyPem: string,
): A2ATrustedA2APeer | null {
  return (
    trustedA2APeersByPublicKey().get(normalizePublicKeyPemText(publicKeyPem)) ??
    null
  );
}
