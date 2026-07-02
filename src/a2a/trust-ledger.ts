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
import { APP_VERSION } from '../config/app-version.js';
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
import { getOrCreateA2ADelegationTokenKeyPair } from './delegation-token.js';
import { A2AEnvelopeValidationError, classifyA2AAgentId } from './envelope.js';
import { resolveA2AAgentId } from './identity.js';
import { invalidateA2AIdentityResolvers } from './identity-resolver-invalidation.js';
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
const SHARED_TRUSTED_PEER_SCHEMA_VERSION = 1;
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
const SHARED_TRUSTED_PEER_ASSET_PREFIX = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'a2a',
  'trust-ledger',
  'peers',
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
export const SHARED_TRUSTED_PEER_TRANSPORT_KINDS = ['a2a', 'webhook'] as const;
export type SharedTrustedPeerTransportKind =
  (typeof SHARED_TRUSTED_PEER_TRANSPORT_KINDS)[number];
export type SharedTrustedPeerTrustMode = 'operator' | 'tofu';
export type SharedTrustedPeerAuditOrigin =
  | 'operator'
  | 'legacy-a2a'
  | 'legacy-webhook'
  | 'tofu';

export class A2APeerUntrustedError extends Error {
  readonly code = 'peer-untrusted';

  constructor(peerId: string) {
    super(`peer-untrusted: A2A peer trust has been revoked for ${peerId}`);
    this.name = 'A2APeerUntrustedError';
  }
}

let trustedA2APeersBySenderCache: Map<
  string,
  SharedTrustedA2AJsonRpcPeer
> | null = null;
let trustedA2APeersByPublicKeyCache: Map<
  string,
  SharedTrustedA2AJsonRpcPeer
> | null = null;
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

export interface SharedTrustedPeerTrustMetadata {
  mode: SharedTrustedPeerTrustMode;
  establishedAt: string;
  updatedAt: string;
}

export interface SharedTrustedPeerAuditLineage {
  source: 'a2a-trust-ledger';
  origin: SharedTrustedPeerAuditOrigin;
  legacyAssetPath?: string;
  migratedAt?: string;
}

interface SharedTrustedPeerBase {
  schemaVersion: typeof SHARED_TRUSTED_PEER_SCHEMA_VERSION;
  transport: SharedTrustedPeerTransportKind;
  peerId: string;
  senderAgentId?: string;
  trust: SharedTrustedPeerTrustMetadata;
  auditLineage: SharedTrustedPeerAuditLineage;
  createdAt: string;
  updatedAt: string;
}

export interface SharedTrustedWebhookPeer extends SharedTrustedPeerBase {
  transport: 'webhook';
  senderAgentId: string;
  policyAuthority?: A2APolicyAuthorityKind;
  capabilities: string[];
  webhook: {
    secretRef: SecretRef;
    signatureHeader: string;
    version: string;
    replayWindowMs: number;
    rateLimitPerMinute: number;
  };
}

export interface SharedTrustedA2APeer extends SharedTrustedPeerBase {
  transport: 'a2a';
  a2a: {
    publicKeyPem?: string;
    bearerTokenRef?: SecretRef;
    agentCardUrl?: string;
    deliveryUrl?: string;
    publicKeyJwk?: JsonWebKey | null;
    publicKeyFingerprint?: string;
    publicKeyStatus?: A2APublicKeyTrustStatus;
    trustedAt?: string;
    lastSeenAt?: string;
    revokedAt?: string;
    revokedReason?: string;
    lastMismatchAt?: string;
    lastMismatchFingerprint?: string;
  };
}

export type SharedTrustedA2AJsonRpcPeer = SharedTrustedA2APeer & {
  senderAgentId: string;
  a2a: SharedTrustedA2APeer['a2a'] & { publicKeyPem: string };
};

export type SharedTrustedPeer = SharedTrustedWebhookPeer | SharedTrustedA2APeer;

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
  actor?: string;
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
  bearerTokenRef?: SecretRef;
  agentCardUrl?: string;
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

function sharedTrustedPeerTransportAssetPrefix(
  transport: SharedTrustedPeerTransportKind,
): string {
  return path.join(SHARED_TRUSTED_PEER_ASSET_PREFIX, transport);
}

function sharedTrustedPeerAssetPath(
  transport: SharedTrustedPeerTransportKind,
  peerId: string,
): string {
  return path.join(
    sharedTrustedPeerTransportAssetPrefix(transport),
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

export function normalizePublicKeyFingerprint(value: unknown): string {
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
  const delegationKey = getOrCreateA2ADelegationTokenKeyPair();
  const peerTrustLevel = options.peerTrustLevel || 'public';
  const agents = visibleA2AAgents(peerTrustLevel).map((agent) => ({
    agent,
    canonicalAgentId: resolveA2AAgentId(agent.id),
    skills: visibleAgentSkills(agent, peerTrustLevel),
  }));
  return {
    name: 'HybridClaw',
    version: APP_VERSION,
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
      // The TOFU identity key pins Agent Cards; the delegation key verifies
      // signed A2A bearer tokens after pairing approval.
      publicKeyJwk: identity.publicKeyJwk,
      publicKeyFingerprint: identity.publicKeyFingerprint,
      delegation: {
        algorithm: delegationKey.algorithm,
        keyId: delegationKey.keyId,
        publicKeyPem: delegationKey.publicKeyPem,
        senderAgentIds: agents.map(({ canonicalAgentId }) => canonicalAgentId),
      },
      version: APP_VERSION,
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

function normalizeSharedTrustMode(value: unknown): SharedTrustedPeerTrustMode {
  return value === 'tofu' ? 'tofu' : 'operator';
}

function normalizeSharedAuditOrigin(
  value: unknown,
): SharedTrustedPeerAuditOrigin {
  if (
    value === 'legacy-a2a' ||
    value === 'legacy-webhook' ||
    value === 'tofu'
  ) {
    return value;
  }
  return 'operator';
}

function normalizeSharedTrustMetadata(
  value: unknown,
  fallback: { createdAt: string; updatedAt: string },
): SharedTrustedPeerTrustMetadata {
  const record = isRecord(value) ? value : {};
  return {
    mode: normalizeSharedTrustMode(record.mode),
    establishedAt: parseTimestampOr(record.establishedAt, fallback.createdAt),
    updatedAt: parseTimestampOr(record.updatedAt, fallback.updatedAt),
  };
}

function normalizeSharedAuditLineage(
  value: unknown,
  fallbackOrigin: SharedTrustedPeerAuditOrigin,
): SharedTrustedPeerAuditLineage {
  const record = isRecord(value) ? value : {};
  return {
    source: 'a2a-trust-ledger',
    origin: normalizeSharedAuditOrigin(record.origin || fallbackOrigin),
    ...(typeof record.legacyAssetPath === 'string' && record.legacyAssetPath
      ? { legacyAssetPath: record.legacyAssetPath }
      : {}),
    ...(typeof record.migratedAt === 'string' && record.migratedAt
      ? { migratedAt: record.migratedAt }
      : {}),
  };
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

function normalizeSharedTrustedWebhookConfig(
  value: unknown,
): SharedTrustedWebhookPeer['webhook'] {
  if (!isRecord(value)) {
    throw new A2AEnvelopeValidationError(['webhook must be an object']);
  }
  const webhookConfig = normalizeTrustedWebhookPeerConfig({
    secretRef: value.secretRef,
    signatureHeader: value.signatureHeader,
    version: value.version,
  });
  return {
    secretRef: webhookConfig.secretRef,
    signatureHeader: webhookConfig.signatureHeader,
    version: webhookConfig.version,
    replayWindowMs: normalizePositiveInteger(
      value.replayWindowMs,
      WEBHOOK_REPLAY_WINDOW_MS,
    ),
    rateLimitPerMinute: normalizePositiveInteger(
      value.rateLimitPerMinute,
      A2A_TRUST_LEDGER_DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE,
    ),
  };
}

function normalizeSharedTrustedA2AConfig(
  value: unknown,
): SharedTrustedA2APeer['a2a'] {
  if (!isRecord(value)) {
    throw new A2AEnvelopeValidationError(['a2a must be an object']);
  }
  const publicKeyPem =
    value.publicKeyPem === undefined
      ? undefined
      : normalizePublicKeyPem(value.publicKeyPem);
  const bearerTokenRef =
    value.bearerTokenRef === undefined
      ? undefined
      : normalizeSecretRef(value.bearerTokenRef);
  const agentCardUrl = normalizeOptionalUrl(value.agentCardUrl, 'agentCardUrl');
  const deliveryUrl = normalizeOptionalUrl(value.deliveryUrl, 'deliveryUrl');
  const publicKeyJwk =
    value.publicKeyJwk === undefined
      ? undefined
      : value.publicKeyJwk === null
        ? null
        : normalizePublicKeyJwk(value.publicKeyJwk);
  const derivedPublicKeyFingerprint = publicKeyJwk
    ? fingerprintA2APublicKey(publicKeyJwk)
    : undefined;
  const providedPublicKeyFingerprint =
    value.publicKeyFingerprint === undefined
      ? undefined
      : normalizePublicKeyFingerprint(value.publicKeyFingerprint);
  if (
    derivedPublicKeyFingerprint &&
    providedPublicKeyFingerprint &&
    derivedPublicKeyFingerprint !== providedPublicKeyFingerprint
  ) {
    throw new A2AEnvelopeValidationError([
      'a2a.publicKeyFingerprint does not match a2a.publicKeyJwk',
    ]);
  }
  const publicKeyFingerprint =
    providedPublicKeyFingerprint || derivedPublicKeyFingerprint;
  if (!publicKeyPem && !publicKeyFingerprint) {
    throw new A2AEnvelopeValidationError([
      'a2a.publicKeyPem or a2a.publicKeyFingerprint is required',
    ]);
  }
  return {
    ...(publicKeyPem ? { publicKeyPem } : {}),
    ...(bearerTokenRef ? { bearerTokenRef } : {}),
    ...(agentCardUrl ? { agentCardUrl } : {}),
    ...(deliveryUrl ? { deliveryUrl } : {}),
    ...(publicKeyJwk !== undefined ? { publicKeyJwk } : {}),
    ...(publicKeyFingerprint
      ? {
          publicKeyFingerprint,
          publicKeyStatus: normalizeTrustStatus(value.publicKeyStatus),
          trustedAt: parseTimestampOr(value.trustedAt, EPOCH_ISO),
          lastSeenAt: parseTimestampOr(value.lastSeenAt, EPOCH_ISO),
        }
      : {}),
    ...(typeof value.revokedAt === 'string' && value.revokedAt
      ? { revokedAt: value.revokedAt }
      : {}),
    ...(typeof value.revokedReason === 'string' && value.revokedReason
      ? { revokedReason: value.revokedReason }
      : {}),
    ...(typeof value.lastMismatchAt === 'string' && value.lastMismatchAt
      ? { lastMismatchAt: value.lastMismatchAt }
      : {}),
    ...(typeof value.lastMismatchFingerprint === 'string' &&
    value.lastMismatchFingerprint
      ? { lastMismatchFingerprint: value.lastMismatchFingerprint }
      : {}),
  };
}

function parseSharedTrustedPeer(raw: string): SharedTrustedPeer | null {
  try {
    const parsed = JSON.parse(raw) as SharedTrustedPeer;
    if (parsed.schemaVersion !== SHARED_TRUSTED_PEER_SCHEMA_VERSION)
      return null;
    if (
      !SHARED_TRUSTED_PEER_TRANSPORT_KINDS.includes(
        parsed.transport as SharedTrustedPeerTransportKind,
      )
    ) {
      return null;
    }
    const createdAt = parseTimestampOr(parsed.createdAt, EPOCH_ISO);
    const updatedAt = parseTimestampOr(parsed.updatedAt, EPOCH_ISO);
    const base: Pick<
      SharedTrustedPeerBase,
      'schemaVersion' | 'peerId' | 'trust' | 'createdAt' | 'updatedAt'
    > = {
      schemaVersion: SHARED_TRUSTED_PEER_SCHEMA_VERSION,
      peerId: normalizeA2APeerId(parsed.peerId),
      trust: normalizeSharedTrustMetadata(parsed.trust, {
        createdAt,
        updatedAt,
      }),
      createdAt,
      updatedAt,
    };

    if (parsed.transport === 'webhook') {
      const policyAuthority = normalizePolicyAuthority(parsed.policyAuthority);
      return {
        ...base,
        transport: 'webhook',
        senderAgentId: normalizeSenderAgentId(parsed.senderAgentId),
        ...(policyAuthority ? { policyAuthority } : {}),
        capabilities: normalizeCapabilities(parsed.capabilities),
        auditLineage: normalizeSharedAuditLineage(
          parsed.auditLineage,
          'operator',
        ),
        webhook: normalizeSharedTrustedWebhookConfig(parsed.webhook),
      };
    }

    const senderAgentId =
      typeof parsed.senderAgentId === 'string' && parsed.senderAgentId.trim()
        ? normalizeCanonicalSenderAgentId(parsed.senderAgentId)
        : undefined;
    return {
      ...base,
      transport: 'a2a',
      ...(senderAgentId ? { senderAgentId } : {}),
      auditLineage: normalizeSharedAuditLineage(
        parsed.auditLineage,
        'operator',
      ),
      a2a: normalizeSharedTrustedA2AConfig(parsed.a2a),
    };
  } catch {
    return null;
  }
}

function sharedWebhookPeerToLegacy(
  peer: SharedTrustedWebhookPeer,
): A2ATrustedWebhookPeer {
  return {
    schemaVersion: TRUSTED_WEBHOOK_PEER_SCHEMA_VERSION,
    peerId: peer.peerId,
    senderAgentId: peer.senderAgentId,
    ...(peer.policyAuthority ? { policyAuthority: peer.policyAuthority } : {}),
    capabilities: peer.capabilities,
    secretRef: peer.webhook.secretRef,
    signatureHeader: peer.webhook.signatureHeader,
    version: peer.webhook.version,
    replayWindowMs: peer.webhook.replayWindowMs,
    rateLimitPerMinute: peer.webhook.rateLimitPerMinute,
    createdAt: peer.createdAt,
    updatedAt: peer.updatedAt,
  };
}

function sharedA2APeerToLegacy(
  peer: SharedTrustedA2AJsonRpcPeer,
): A2ATrustedA2APeer {
  return {
    schemaVersion: TRUSTED_A2A_PEER_SCHEMA_VERSION,
    peerId: peer.peerId,
    senderAgentId: peer.senderAgentId,
    publicKeyPem: peer.a2a.publicKeyPem,
    createdAt: peer.createdAt,
    updatedAt: peer.updatedAt,
  };
}

function isSharedTrustedA2AJsonRpcPeer(
  peer: SharedTrustedPeer | null,
): peer is SharedTrustedA2AJsonRpcPeer {
  return (
    peer?.transport === 'a2a' &&
    typeof peer.senderAgentId === 'string' &&
    typeof peer.a2a.publicKeyPem === 'string'
  );
}

function sharedA2APublicKeyPeerToLegacy(
  peer: SharedTrustedA2APeer,
): A2ATrustedPublicKeyPeer | null {
  if (
    !peer.a2a.publicKeyFingerprint ||
    !peer.a2a.publicKeyStatus ||
    !peer.a2a.trustedAt ||
    !peer.a2a.lastSeenAt
  ) {
    return null;
  }
  return {
    schemaVersion: TRUSTED_PUBLIC_KEY_PEER_SCHEMA_VERSION,
    peerId: peer.peerId,
    agentCardUrl: peer.a2a.agentCardUrl || '',
    deliveryUrl: peer.a2a.deliveryUrl || '',
    publicKeyJwk: peer.a2a.publicKeyJwk ?? null,
    publicKeyFingerprint: peer.a2a.publicKeyFingerprint,
    status: peer.a2a.publicKeyStatus,
    trustedAt: peer.a2a.trustedAt,
    createdAt: peer.createdAt,
    updatedAt: peer.updatedAt,
    lastSeenAt: peer.a2a.lastSeenAt,
    ...(peer.a2a.revokedAt ? { revokedAt: peer.a2a.revokedAt } : {}),
    ...(peer.a2a.revokedReason
      ? { revokedReason: peer.a2a.revokedReason }
      : {}),
    ...(peer.a2a.lastMismatchAt
      ? { lastMismatchAt: peer.a2a.lastMismatchAt }
      : {}),
    ...(peer.a2a.lastMismatchFingerprint
      ? { lastMismatchFingerprint: peer.a2a.lastMismatchFingerprint }
      : {}),
  };
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

function persistTrustedPublicKeyPeer(
  peer: A2ATrustedPublicKeyPeer,
  params: {
    mode?: SharedTrustedPeerTrustMode;
    origin?: SharedTrustedPeerAuditOrigin;
  } = {},
): void {
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
  persistSharedTrustedPeer(
    trustedPublicKeyPeerToShared(peer, {
      mode: params.mode,
      origin: params.origin,
    }),
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
  const peer = getSharedTrustedPeer('a2a', peerId);
  if (peer?.transport === 'a2a') {
    const publicKeyPeer = sharedA2APublicKeyPeerToLegacy(peer);
    if (publicKeyPeer) return publicKeyPeer;
  }
  const migrated = migrateLegacySharedTrustedPublicKeyPeer(peerId);
  if (migrated) return sharedA2APublicKeyPeerToLegacy(migrated);
  return null;
}

export function listA2ATrustedPublicKeyPeers(): A2ATrustedPublicKeyPeer[] {
  return listSharedTrustedPeers('a2a')
    .map((peer) =>
      peer.transport === 'a2a' ? sharedA2APublicKeyPeerToLegacy(peer) : null,
    )
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

  if (existing.status === 'revoked') {
    throw new A2APeerUntrustedError(existing.peerId);
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
  params: { reason?: string; actor?: string; runId?: string; now?: Date } = {},
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
  invalidateA2AIdentityResolvers();
  recordTrustAudit({
    runId: params.runId,
    event: {
      type: 'a2a.trust.revoked',
      peerId: revoked.peerId,
      agentCardUrl: revoked.agentCardUrl,
      deliveryUrl: revoked.deliveryUrl,
      publicKeyFingerprint: revoked.publicKeyFingerprint,
      reason: revoked.revokedReason,
      actor: params.actor?.trim() || null,
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
  persistTrustedPublicKeyPeer(peer, {
    mode: 'operator',
    origin: 'operator',
  });
  invalidateA2AIdentityResolvers();
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
      actor: input.actor?.trim() || null,
      publicKeyMaterial: peer.publicKeyJwk ? 'jwk' : 'fingerprint',
    },
  });
  return peer;
}

export function deleteA2ATrustedPublicKeyPeer(
  peerId: string,
  params: { actor?: string } = {},
): void {
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
  deleteSharedA2APublicKeyTrust(normalizedPeerId);
  invalidateA2AIdentityResolvers();
  if (existing) {
    recordTrustAudit({
      event: {
        type: 'a2a.trust.deleted',
        peerId: existing.peerId,
        publicKeyFingerprint: existing.publicKeyFingerprint,
        previousStatus: existing.status,
        actor: params.actor?.trim() || null,
      },
    });
  }
}

function buildSharedTrustMetadata(
  createdAt: string,
  updatedAt: string,
  mode: SharedTrustedPeerTrustMode = 'operator',
): SharedTrustedPeerTrustMetadata {
  return {
    mode,
    establishedAt: createdAt,
    updatedAt,
  };
}

function legacyWebhookPeerToShared(
  peer: A2ATrustedWebhookPeer,
  params: { legacyAssetPath: string; migratedAt?: string },
): SharedTrustedWebhookPeer {
  return {
    schemaVersion: SHARED_TRUSTED_PEER_SCHEMA_VERSION,
    transport: 'webhook',
    peerId: peer.peerId,
    senderAgentId: peer.senderAgentId,
    ...(peer.policyAuthority ? { policyAuthority: peer.policyAuthority } : {}),
    capabilities: peer.capabilities,
    trust: buildSharedTrustMetadata(peer.createdAt, peer.updatedAt),
    auditLineage: {
      source: 'a2a-trust-ledger',
      origin: 'legacy-webhook',
      legacyAssetPath: params.legacyAssetPath,
      migratedAt: params.migratedAt || new Date().toISOString(),
    },
    webhook: {
      secretRef: peer.secretRef,
      signatureHeader: peer.signatureHeader,
      version: peer.version,
      replayWindowMs: peer.replayWindowMs,
      rateLimitPerMinute: peer.rateLimitPerMinute,
    },
    createdAt: peer.createdAt,
    updatedAt: peer.updatedAt,
  };
}

function legacyA2APeerToShared(
  peer: A2ATrustedA2APeer,
  params: { legacyAssetPath: string; migratedAt?: string },
): SharedTrustedA2AJsonRpcPeer {
  return {
    schemaVersion: SHARED_TRUSTED_PEER_SCHEMA_VERSION,
    transport: 'a2a',
    peerId: peer.peerId,
    senderAgentId: peer.senderAgentId,
    trust: buildSharedTrustMetadata(peer.createdAt, peer.updatedAt),
    auditLineage: {
      source: 'a2a-trust-ledger',
      origin: 'legacy-a2a',
      legacyAssetPath: params.legacyAssetPath,
      migratedAt: params.migratedAt || new Date().toISOString(),
    },
    a2a: {
      publicKeyPem: peer.publicKeyPem,
    },
    createdAt: peer.createdAt,
    updatedAt: peer.updatedAt,
  };
}

function trustedPublicKeyPeerToShared(
  peer: A2ATrustedPublicKeyPeer,
  params: {
    mode?: SharedTrustedPeerTrustMode;
    origin?: SharedTrustedPeerAuditOrigin;
    legacyAssetPath?: string;
    migratedAt?: string;
  } = {},
): SharedTrustedA2APeer {
  return {
    schemaVersion: SHARED_TRUSTED_PEER_SCHEMA_VERSION,
    transport: 'a2a',
    peerId: peer.peerId,
    trust: buildSharedTrustMetadata(
      peer.trustedAt,
      peer.updatedAt,
      params.mode || 'tofu',
    ),
    auditLineage: {
      source: 'a2a-trust-ledger',
      origin: params.origin || 'tofu',
      ...(params.legacyAssetPath
        ? { legacyAssetPath: params.legacyAssetPath }
        : {}),
      ...(params.migratedAt || params.legacyAssetPath
        ? { migratedAt: params.migratedAt || new Date().toISOString() }
        : {}),
    },
    a2a: {
      agentCardUrl: peer.agentCardUrl,
      deliveryUrl: peer.deliveryUrl,
      publicKeyJwk: peer.publicKeyJwk,
      publicKeyFingerprint: peer.publicKeyFingerprint,
      publicKeyStatus: peer.status,
      trustedAt: peer.trustedAt,
      lastSeenAt: peer.lastSeenAt,
      ...(peer.revokedAt ? { revokedAt: peer.revokedAt } : {}),
      ...(peer.revokedReason ? { revokedReason: peer.revokedReason } : {}),
      ...(peer.lastMismatchAt ? { lastMismatchAt: peer.lastMismatchAt } : {}),
      ...(peer.lastMismatchFingerprint
        ? { lastMismatchFingerprint: peer.lastMismatchFingerprint }
        : {}),
    },
    createdAt: peer.createdAt,
    updatedAt: peer.updatedAt,
  };
}

function mergeSharedA2APeer(
  existing: SharedTrustedA2APeer,
  incoming: SharedTrustedA2APeer,
): SharedTrustedA2APeer {
  return {
    ...incoming,
    senderAgentId: incoming.senderAgentId || existing.senderAgentId,
    a2a: {
      ...existing.a2a,
      ...incoming.a2a,
    },
    createdAt: existing.createdAt || incoming.createdAt,
  };
}

function writeSharedTrustedPeerState(peer: SharedTrustedPeer): void {
  syncRuntimeAssetRevisionState(
    'a2a',
    sharedTrustedPeerAssetPath(peer.transport, peer.peerId),
    {
      route: `a2a.trust-ledger.peer#${peer.transport}:${peer.peerId}`,
      source: 'a2a-trust-ledger',
    },
    {
      exists: true,
      content: JSON.stringify(peer),
    },
  );
  if (peer.transport === 'a2a') {
    trustedA2APeersBySenderCache = null;
    trustedA2APeersByPublicKeyCache = null;
  }
}

function persistSharedTrustedPeer(peer: SharedTrustedPeer): void {
  const existing =
    peer.transport === 'a2a' ? readSharedTrustedPeer('a2a', peer.peerId) : null;
  writeSharedTrustedPeerState(
    peer.transport === 'a2a' && existing?.transport === 'a2a'
      ? mergeSharedA2APeer(existing, peer)
      : peer,
  );
}

function readSharedTrustedPeer(
  transport: SharedTrustedPeerTransportKind,
  peerId: string,
): SharedTrustedPeer | null {
  const state = getRuntimeAssetRevisionState(
    'a2a',
    sharedTrustedPeerAssetPath(transport, peerId),
  );
  const peer = state ? parseSharedTrustedPeer(state.content) : null;
  return peer?.transport === transport ? peer : null;
}

function migrateLegacySharedTrustedPeer(
  transport: SharedTrustedPeerTransportKind,
  peerId: string,
): SharedTrustedPeer | null {
  if (transport === 'webhook') {
    const legacyPath = trustedWebhookPeerAssetPath(peerId);
    const state = getRuntimeAssetRevisionState('a2a', legacyPath);
    const legacy = state ? parseTrustedWebhookPeer(state.content) : null;
    if (!legacy) return null;
    const peer = legacyWebhookPeerToShared(legacy, {
      legacyAssetPath: legacyPath,
    });
    persistSharedTrustedPeer(peer);
    return peer;
  }

  return migrateLegacySharedTrustedA2APeerComponents(peerId);
}

function migrateLegacySharedTrustedPublicKeyPeer(
  peerId: string,
): SharedTrustedA2APeer | null {
  const legacyPath = trustedPublicKeyPeerAssetPath(peerId);
  const state = getRuntimeAssetRevisionState('a2a', legacyPath);
  const legacy = state ? parseTrustedPublicKeyPeer(state.content) : null;
  if (!legacy) return null;
  const peer = trustedPublicKeyPeerToShared(legacy, {
    origin: 'tofu',
    legacyAssetPath: legacyPath,
  });
  persistSharedTrustedPeer(peer);
  const shared = readSharedTrustedPeer('a2a', peer.peerId);
  return shared?.transport === 'a2a' ? shared : peer;
}

function migrateLegacySharedTrustedA2AJsonRpcPeer(
  peerId: string,
): SharedTrustedA2APeer | null {
  const legacyPath = trustedA2APeerAssetPath(peerId);
  const state = getRuntimeAssetRevisionState('a2a', legacyPath);
  const legacy = state ? parseTrustedA2APeer(state.content) : null;
  if (!legacy) return null;
  const peer = legacyA2APeerToShared(legacy, { legacyAssetPath: legacyPath });
  persistSharedTrustedPeer(peer);
  const shared = readSharedTrustedPeer('a2a', peer.peerId);
  return shared?.transport === 'a2a' ? shared : peer;
}

function migrateLegacySharedTrustedA2APeerComponents(
  peerId: string,
): SharedTrustedA2APeer | null {
  let peer = readSharedTrustedPeer('a2a', peerId);
  if (peer?.transport !== 'a2a') peer = null;

  if (!isSharedTrustedA2AJsonRpcPeer(peer)) {
    const migrated = migrateLegacySharedTrustedA2AJsonRpcPeer(peerId);
    if (migrated) peer = migrated;
  }

  if (!peer || !sharedA2APublicKeyPeerToLegacy(peer)) {
    const migrated = migrateLegacySharedTrustedPublicKeyPeer(peerId);
    if (migrated) peer = migrated;
  }

  return peer;
}

function migrateLegacySharedTrustedPublicKeyPeers(): void {
  const legacyStates = listRuntimeAssetRevisionStates('a2a', {
    assetPathPrefix: TRUSTED_PUBLIC_KEY_PEER_ASSET_PREFIX,
  });
  for (const state of legacyStates) {
    const legacy = parseTrustedPublicKeyPeer(state.content);
    if (!legacy) continue;
    const existing = readSharedTrustedPeer('a2a', legacy.peerId);
    if (
      existing?.transport === 'a2a' &&
      sharedA2APublicKeyPeerToLegacy(existing)
    ) {
      continue;
    }
    persistSharedTrustedPeer(
      trustedPublicKeyPeerToShared(legacy, {
        origin: 'tofu',
        legacyAssetPath: state.assetPath,
      }),
    );
  }
}

function deleteSharedA2APublicKeyTrust(peerId: string): void {
  const existing = readSharedTrustedPeer('a2a', peerId);
  if (existing?.transport !== 'a2a') return;
  const a2a = { ...existing.a2a };
  delete a2a.deliveryUrl;
  delete a2a.publicKeyJwk;
  delete a2a.publicKeyFingerprint;
  delete a2a.publicKeyStatus;
  delete a2a.trustedAt;
  delete a2a.lastSeenAt;
  delete a2a.revokedAt;
  delete a2a.revokedReason;
  delete a2a.lastMismatchAt;
  delete a2a.lastMismatchFingerprint;

  if (!existing.senderAgentId && !a2a.publicKeyPem && !a2a.bearerTokenRef) {
    delete a2a.agentCardUrl;
  }

  if (!existing.senderAgentId && Object.keys(a2a).length === 0) {
    syncRuntimeAssetRevisionState(
      'a2a',
      sharedTrustedPeerAssetPath('a2a', existing.peerId),
      {
        route: `a2a.trust-ledger.peer#a2a:${existing.peerId}`,
        source: 'a2a-trust-ledger',
      },
      { exists: false, content: null },
    );
    trustedA2APeersBySenderCache = null;
    trustedA2APeersByPublicKeyCache = null;
    return;
  }

  writeSharedTrustedPeerState({
    ...existing,
    a2a,
    updatedAt: new Date().toISOString(),
  });
}

function migrateLegacySharedTrustedPeers(
  transport: SharedTrustedPeerTransportKind,
): void {
  const legacyStates = listRuntimeAssetRevisionStates('a2a', {
    assetPathPrefix:
      transport === 'webhook'
        ? TRUSTED_WEBHOOK_PEER_ASSET_PREFIX
        : TRUSTED_A2A_PEER_ASSET_PREFIX,
  });
  for (const state of legacyStates) {
    if (transport === 'webhook') {
      const legacy = parseTrustedWebhookPeer(state.content);
      if (!legacy) continue;
      if (readSharedTrustedPeer('webhook', legacy.peerId)) continue;
      persistSharedTrustedPeer(
        legacyWebhookPeerToShared(legacy, { legacyAssetPath: state.assetPath }),
      );
      continue;
    }

    const legacy = parseTrustedA2APeer(state.content);
    if (!legacy) continue;
    const existing = readSharedTrustedPeer('a2a', legacy.peerId);
    if (isSharedTrustedA2AJsonRpcPeer(existing)) continue;
    persistSharedTrustedPeer(
      legacyA2APeerToShared(legacy, { legacyAssetPath: state.assetPath }),
    );
  }
  if (transport === 'a2a') migrateLegacySharedTrustedPublicKeyPeers();
}

export function getSharedTrustedPeer(
  transport: SharedTrustedPeerTransportKind,
  peerId: string,
): SharedTrustedPeer | null {
  if (transport === 'a2a') {
    return migrateLegacySharedTrustedA2APeerComponents(peerId);
  }
  const shared = readSharedTrustedPeer(transport, peerId);
  return shared || migrateLegacySharedTrustedPeer(transport, peerId);
}

export function listSharedTrustedPeers(
  transport?: SharedTrustedPeerTransportKind,
): SharedTrustedPeer[] {
  const transports = transport
    ? [transport]
    : [...SHARED_TRUSTED_PEER_TRANSPORT_KINDS];
  for (const kind of transports) migrateLegacySharedTrustedPeers(kind);

  const states = listRuntimeAssetRevisionStates('a2a', {
    assetPathPrefix: transport
      ? sharedTrustedPeerTransportAssetPrefix(transport)
      : SHARED_TRUSTED_PEER_ASSET_PREFIX,
  });
  return states
    .map((state) => parseSharedTrustedPeer(state.content))
    .filter(
      (peer): peer is SharedTrustedPeer =>
        peer !== null && (!transport || peer.transport === transport),
    )
    .sort((left, right) => {
      const transportOrder = left.transport.localeCompare(right.transport);
      return transportOrder || left.peerId.localeCompare(right.peerId);
    });
}

export function getSharedTrustedWebhookPeer(
  peerId: string,
): SharedTrustedWebhookPeer | null {
  const peer = getSharedTrustedPeer('webhook', peerId);
  return peer?.transport === 'webhook' ? peer : null;
}

export function listSharedTrustedWebhookPeers(): SharedTrustedWebhookPeer[] {
  return listSharedTrustedPeers('webhook').filter(
    (peer): peer is SharedTrustedWebhookPeer => peer.transport === 'webhook',
  );
}

export function getSharedTrustedA2AJsonRpcPeer(
  peerId: string,
): SharedTrustedA2AJsonRpcPeer | null {
  const peer = getSharedTrustedPeer('a2a', peerId);
  return isSharedTrustedA2AJsonRpcPeer(peer) ? peer : null;
}

export function listSharedTrustedA2AJsonRpcPeers(): SharedTrustedA2AJsonRpcPeer[] {
  return listSharedTrustedPeers('a2a').filter(isSharedTrustedA2AJsonRpcPeer);
}

function sharedTrustedA2AJsonRpcPeersBySender(): Map<
  string,
  SharedTrustedA2AJsonRpcPeer
> {
  if (trustedA2APeersBySenderCache) return trustedA2APeersBySenderCache;
  trustedA2APeersBySenderCache = new Map(
    listSharedTrustedA2AJsonRpcPeers().map((peer) => [
      peer.senderAgentId,
      peer,
    ]),
  );
  return trustedA2APeersBySenderCache;
}

function sharedTrustedA2AJsonRpcPeersByPublicKey(): Map<
  string,
  SharedTrustedA2AJsonRpcPeer
> {
  if (trustedA2APeersByPublicKeyCache) return trustedA2APeersByPublicKeyCache;
  trustedA2APeersByPublicKeyCache = new Map();
  for (const peer of listSharedTrustedA2AJsonRpcPeers()) {
    const publicKey = normalizePublicKeyPemText(peer.a2a.publicKeyPem);
    if (!trustedA2APeersByPublicKeyCache.has(publicKey)) {
      trustedA2APeersByPublicKeyCache.set(publicKey, peer);
    }
  }
  return trustedA2APeersByPublicKeyCache;
}

export function getSharedTrustedA2AJsonRpcPeerBySender(
  senderAgentId: string,
): SharedTrustedA2AJsonRpcPeer | null {
  const normalizedSenderAgentId =
    normalizeCanonicalSenderAgentId(senderAgentId);
  return (
    sharedTrustedA2AJsonRpcPeersBySender().get(normalizedSenderAgentId) ?? null
  );
}

export function getSharedTrustedA2AJsonRpcPeerByPublicKeyPem(
  publicKeyPem: string,
): SharedTrustedA2AJsonRpcPeer | null {
  return (
    sharedTrustedA2AJsonRpcPeersByPublicKey().get(
      normalizePublicKeyPemText(publicKeyPem),
    ) ?? null
  );
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
  const createdAt = existing?.createdAt || updatedAt;
  const peer: SharedTrustedWebhookPeer = {
    schemaVersion: SHARED_TRUSTED_PEER_SCHEMA_VERSION,
    transport: 'webhook',
    peerId,
    senderAgentId: normalizeSenderAgentId(input.senderAgentId),
    ...(policyAuthority ? { policyAuthority } : {}),
    capabilities: normalizeCapabilities(input.capabilities),
    trust: buildSharedTrustMetadata(createdAt, updatedAt),
    auditLineage: {
      source: 'a2a-trust-ledger',
      origin: 'operator',
    },
    webhook: {
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
    },
    createdAt,
    updatedAt,
  };
  persistSharedTrustedPeer(peer);
  return sharedWebhookPeerToLegacy(peer);
}

export function upsertA2ATrustedA2APeer(
  input: UpsertA2ATrustedA2APeerInput,
  now = new Date(),
): A2ATrustedA2APeer {
  const peerId = normalizeA2APeerId(input.peerId);
  const existing = getA2ATrustedA2APeer(peerId);
  const updatedAt = now.toISOString();
  const createdAt = existing?.createdAt || updatedAt;
  const bearerTokenRef = input.bearerTokenRef
    ? normalizeSecretRef(input.bearerTokenRef)
    : undefined;
  const agentCardUrl = normalizeOptionalUrl(input.agentCardUrl, 'agentCardUrl');
  const peer: SharedTrustedA2AJsonRpcPeer = {
    schemaVersion: SHARED_TRUSTED_PEER_SCHEMA_VERSION,
    transport: 'a2a',
    peerId,
    senderAgentId: normalizeCanonicalSenderAgentId(input.senderAgentId),
    trust: buildSharedTrustMetadata(createdAt, updatedAt),
    auditLineage: {
      source: 'a2a-trust-ledger',
      origin: 'operator',
    },
    a2a: {
      publicKeyPem: normalizePublicKeyPem(input.publicKeyPem),
      ...(bearerTokenRef ? { bearerTokenRef } : {}),
      ...(agentCardUrl ? { agentCardUrl } : {}),
    },
    createdAt,
    updatedAt,
  };
  persistSharedTrustedPeer(peer);
  trustedA2APeersBySenderCache = null;
  trustedA2APeersByPublicKeyCache = null;
  return sharedA2APeerToLegacy(peer);
}

export function getA2ATrustedWebhookPeer(
  peerId: string,
): A2ATrustedWebhookPeer | null {
  const peer = getSharedTrustedWebhookPeer(peerId);
  return peer ? sharedWebhookPeerToLegacy(peer) : null;
}

export function getA2ATrustedA2APeer(peerId: string): A2ATrustedA2APeer | null {
  const peer = getSharedTrustedA2AJsonRpcPeer(peerId);
  return peer ? sharedA2APeerToLegacy(peer) : null;
}

export function listA2ATrustedWebhookPeers(): A2ATrustedWebhookPeer[] {
  return listSharedTrustedWebhookPeers().map((peer) =>
    sharedWebhookPeerToLegacy(peer),
  );
}

export function listA2ATrustedA2APeers(): A2ATrustedA2APeer[] {
  return listSharedTrustedA2AJsonRpcPeers().map((peer) =>
    sharedA2APeerToLegacy(peer),
  );
}

export function getA2ATrustedA2APeerBySender(
  senderAgentId: string,
): A2ATrustedA2APeer | null {
  const peer = getSharedTrustedA2AJsonRpcPeerBySender(senderAgentId);
  return peer ? sharedA2APeerToLegacy(peer) : null;
}

export function getA2ATrustedA2APeerByPublicKeyPem(
  publicKeyPem: string,
): A2ATrustedA2APeer | null {
  const peer = getSharedTrustedA2AJsonRpcPeerByPublicKeyPem(publicKeyPem);
  return peer ? sharedA2APeerToLegacy(peer) : null;
}
