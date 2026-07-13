import { createHash, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  CompactEncrypt,
  compactDecrypt,
  importJWK,
  type JWEHeaderParameters,
} from 'jose';

import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  getRuntimeAssetRevisionState,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { writeFileAtomicExclusive } from '../utils/atomic-file.js';
import {
  type A2AEnvelope,
  type A2AEnvelopeEncryption,
  A2AEnvelopeValidationError,
  validateA2AEnvelope,
} from './envelope.js';
import { isRecord } from './utils.js';

export const A2A_E2EE_VERSION = 'jwe-x25519-a256gcm-v1' as const;
export const A2A_E2EE_ALGORITHM = 'ECDH-ES' as const;
export const A2A_E2EE_ENCRYPTION = 'A256GCM' as const;
const A2A_E2EE_CONTENT_TYPE =
  'application/hybridclaw-a2a-envelope+json' as const;
const A2A_E2EE_KEYPAIR_SCHEMA_VERSION = 1;
const A2A_E2EE_PEER_SCHEMA_VERSION = 1;
const A2A_E2EE_KEYPAIR_PATH = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'a2a',
  'e2ee-keypair.json',
);
const A2A_E2EE_PEER_ASSET_PREFIX = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'a2a',
  'e2ee-peers',
);
const PEER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface A2AE2EEAdvertisement {
  version: typeof A2A_E2EE_VERSION;
  alg: typeof A2A_E2EE_ALGORITHM;
  enc: typeof A2A_E2EE_ENCRYPTION;
  keyId: string;
  publicKeyJwk: JsonWebKey;
  publicKeyFingerprint: string;
}

export interface A2AE2EEKeypair extends A2AE2EEAdvertisement {
  schemaVersion: typeof A2A_E2EE_KEYPAIR_SCHEMA_VERSION;
  privateKeyJwk: JsonWebKey;
  createdAt: string;
}

export interface A2ATrustedE2EEPeer extends A2AE2EEAdvertisement {
  schemaVersion: typeof A2A_E2EE_PEER_SCHEMA_VERSION;
  peerId: string;
  required: true;
  trustedAt: string;
  updatedAt: string;
}

export class A2AE2EEError extends A2AEnvelopeValidationError {
  constructor(message: string) {
    super([message]);
    this.name = 'A2AE2EEError';
  }
}

let cachedKeypair: A2AE2EEKeypair | null = null;

function normalizePeerId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!PEER_ID_PATTERN.test(normalized)) {
    throw new A2AE2EEError('E2EE peerId is invalid');
  }
  return normalized;
}

function normalizeFingerprint(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new A2AE2EEError(`${field} must be a sha256 base64url fingerprint`);
  }
  return value;
}

function normalizeX25519PublicJwk(value: unknown): JsonWebKey {
  if (!isRecord(value)) {
    throw new A2AE2EEError('E2EE publicKeyJwk must be an object');
  }
  if (
    value.kty !== 'OKP' ||
    value.crv !== 'X25519' ||
    typeof value.x !== 'string' ||
    !value.x
  ) {
    throw new A2AE2EEError('E2EE publicKeyJwk must be an X25519 public JWK');
  }
  if (Object.hasOwn(value, 'd')) {
    throw new A2AE2EEError(
      'E2EE publicKeyJwk must not include private key material',
    );
  }
  return { kty: 'OKP', crv: 'X25519', x: value.x };
}

function normalizeX25519PrivateJwk(value: unknown): JsonWebKey {
  if (!isRecord(value)) {
    throw new A2AE2EEError('E2EE privateKeyJwk must be an object');
  }
  if (
    value.kty !== 'OKP' ||
    value.crv !== 'X25519' ||
    typeof value.x !== 'string' ||
    !value.x ||
    typeof value.d !== 'string' ||
    !value.d
  ) {
    throw new A2AE2EEError('E2EE privateKeyJwk must be an X25519 private JWK');
  }
  return { kty: 'OKP', crv: 'X25519', x: value.x, d: value.d };
}

export function fingerprintA2AE2EEPublicKey(publicKeyJwk: JsonWebKey): string {
  const normalized = normalizeX25519PublicJwk(publicKeyJwk);
  return createHash('sha256')
    .update(
      JSON.stringify({
        kty: normalized.kty,
        crv: normalized.crv,
        x: normalized.x,
      }),
    )
    .digest('base64url');
}

export function parseA2AE2EEAdvertisement(
  value: unknown,
): A2AE2EEAdvertisement | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new A2AE2EEError('E2EE advertisement must be an object');
  }
  if (value.version !== A2A_E2EE_VERSION) {
    throw new A2AE2EEError(`E2EE version must be ${A2A_E2EE_VERSION}`);
  }
  if (value.alg !== A2A_E2EE_ALGORITHM) {
    throw new A2AE2EEError(`E2EE alg must be ${A2A_E2EE_ALGORITHM}`);
  }
  if (value.enc !== A2A_E2EE_ENCRYPTION) {
    throw new A2AE2EEError(`E2EE enc must be ${A2A_E2EE_ENCRYPTION}`);
  }
  const publicKeyJwk = normalizeX25519PublicJwk(value.publicKeyJwk);
  const publicKeyFingerprint = fingerprintA2AE2EEPublicKey(publicKeyJwk);
  const advertisedFingerprint = normalizeFingerprint(
    value.publicKeyFingerprint,
    'E2EE publicKeyFingerprint',
  );
  if (advertisedFingerprint !== publicKeyFingerprint) {
    throw new A2AE2EEError(
      'E2EE publicKeyFingerprint does not match publicKeyJwk',
    );
  }
  const keyId = normalizeFingerprint(value.keyId, 'E2EE keyId');
  if (keyId !== publicKeyFingerprint) {
    throw new A2AE2EEError('E2EE keyId does not match publicKeyJwk');
  }
  return {
    version: A2A_E2EE_VERSION,
    alg: A2A_E2EE_ALGORITHM,
    enc: A2A_E2EE_ENCRYPTION,
    keyId,
    publicKeyJwk,
    publicKeyFingerprint,
  };
}

function parseKeypair(value: unknown): A2AE2EEKeypair {
  if (!isRecord(value)) {
    throw new A2AE2EEError('E2EE keypair must be an object');
  }
  if (value.schemaVersion !== A2A_E2EE_KEYPAIR_SCHEMA_VERSION) {
    throw new A2AE2EEError('E2EE keypair schema version is unsupported');
  }
  const advertisement = parseA2AE2EEAdvertisement(value);
  if (!advertisement) {
    throw new A2AE2EEError('E2EE keypair advertisement is required');
  }
  const privateKeyJwk = normalizeX25519PrivateJwk(value.privateKeyJwk);
  if (privateKeyJwk.x !== advertisement.publicKeyJwk.x) {
    throw new A2AE2EEError('E2EE private key does not match public key');
  }
  return {
    schemaVersion: A2A_E2EE_KEYPAIR_SCHEMA_VERSION,
    ...advertisement,
    privateKeyJwk,
    createdAt:
      typeof value.createdAt === 'string' && value.createdAt
        ? value.createdAt
        : new Date(0).toISOString(),
  };
}

function readKeypair(): A2AE2EEKeypair | null {
  try {
    return parseKeypair(
      JSON.parse(fs.readFileSync(A2A_E2EE_KEYPAIR_PATH, 'utf-8')) as unknown,
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return null;
    throw error;
  }
}

export function ensureA2AE2EEKeypair(now = new Date()): A2AE2EEKeypair {
  if (cachedKeypair) return cachedKeypair;
  const existing = readKeypair();
  if (existing) {
    cachedKeypair = existing;
    return existing;
  }
  const generated = generateKeyPairSync('x25519');
  const publicKeyJwk = normalizeX25519PublicJwk(
    generated.publicKey.export({ format: 'jwk' }),
  );
  const privateKeyJwk = normalizeX25519PrivateJwk(
    generated.privateKey.export({ format: 'jwk' }),
  );
  const publicKeyFingerprint = fingerprintA2AE2EEPublicKey(publicKeyJwk);
  const keypair: A2AE2EEKeypair = {
    schemaVersion: A2A_E2EE_KEYPAIR_SCHEMA_VERSION,
    version: A2A_E2EE_VERSION,
    alg: A2A_E2EE_ALGORITHM,
    enc: A2A_E2EE_ENCRYPTION,
    keyId: publicKeyFingerprint,
    publicKeyJwk,
    publicKeyFingerprint,
    privateKeyJwk,
    createdAt: now.toISOString(),
  };
  try {
    writeFileAtomicExclusive(
      A2A_E2EE_KEYPAIR_PATH,
      `${JSON.stringify(keypair, null, 2)}\n`,
      {
        tempPrefix: 'e2ee-keypair',
        dirMode: 0o700,
        fileMode: 0o600,
      },
    );
    cachedKeypair = keypair;
    return keypair;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== 'EEXIST') throw error;
    const raced = readKeypair();
    if (!raced) throw error;
    cachedKeypair = raced;
    return raced;
  }
}

export function getLocalA2AE2EEAdvertisement(): A2AE2EEAdvertisement {
  const keypair = ensureA2AE2EEKeypair();
  return {
    version: keypair.version,
    alg: keypair.alg,
    enc: keypair.enc,
    keyId: keypair.keyId,
    publicKeyJwk: keypair.publicKeyJwk,
    publicKeyFingerprint: keypair.publicKeyFingerprint,
  };
}

function peerAssetPath(peerId: string): string {
  return path.join(
    A2A_E2EE_PEER_ASSET_PREFIX,
    `${encodeURIComponent(normalizePeerId(peerId))}.json`,
  );
}

function parseTrustedPeer(value: unknown): A2ATrustedE2EEPeer {
  if (!isRecord(value)) {
    throw new A2AE2EEError('Trusted E2EE peer must be an object');
  }
  if (value.schemaVersion !== A2A_E2EE_PEER_SCHEMA_VERSION) {
    throw new A2AE2EEError('Trusted E2EE peer schema version is unsupported');
  }
  const advertisement = parseA2AE2EEAdvertisement(value);
  if (!advertisement) {
    throw new A2AE2EEError('Trusted E2EE peer advertisement is required');
  }
  return {
    schemaVersion: A2A_E2EE_PEER_SCHEMA_VERSION,
    peerId: normalizePeerId(String(value.peerId || '')),
    required: true,
    ...advertisement,
    trustedAt:
      typeof value.trustedAt === 'string' && value.trustedAt
        ? value.trustedAt
        : new Date(0).toISOString(),
    updatedAt:
      typeof value.updatedAt === 'string' && value.updatedAt
        ? value.updatedAt
        : new Date(0).toISOString(),
  };
}

export function getA2ATrustedE2EEPeer(
  peerId: string,
): A2ATrustedE2EEPeer | null {
  const state = getRuntimeAssetRevisionState('a2a', peerAssetPath(peerId));
  if (!state?.content) return null;
  return parseTrustedPeer(JSON.parse(state.content) as unknown);
}

export function trustA2AE2EEPeer(params: {
  peerId: string;
  advertisement: A2AE2EEAdvertisement;
  actor?: string;
  now?: Date;
}): A2ATrustedE2EEPeer {
  const peerId = normalizePeerId(params.peerId);
  const advertisement = parseA2AE2EEAdvertisement(params.advertisement);
  if (!advertisement) {
    throw new A2AE2EEError('E2EE advertisement is required');
  }
  const existing = getA2ATrustedE2EEPeer(peerId);
  const timestamp = (params.now ?? new Date()).toISOString();
  const peer: A2ATrustedE2EEPeer = {
    schemaVersion: A2A_E2EE_PEER_SCHEMA_VERSION,
    peerId,
    required: true,
    ...advertisement,
    trustedAt:
      existing?.publicKeyFingerprint === advertisement.publicKeyFingerprint
        ? existing.trustedAt
        : timestamp,
    updatedAt: timestamp,
  };
  syncRuntimeAssetRevisionState(
    'a2a',
    peerAssetPath(peerId),
    {
      route: `a2a.e2ee.peer#${peerId}`,
      source: 'a2a-pairing',
    },
    { exists: true, content: JSON.stringify(peer) },
  );
  recordAuditEvent({
    sessionId: 'a2a:e2ee',
    runId: makeAuditRunId('a2a-e2ee-trust'),
    event: {
      type: 'a2a.e2ee_peer_trusted',
      peerId,
      actor: params.actor || 'operator',
      publicKeyFingerprint: peer.publicKeyFingerprint,
      previousPublicKeyFingerprint: existing?.publicKeyFingerprint || null,
    },
  });
  return peer;
}

export function deleteA2ATrustedE2EEPeer(peerId: string): void {
  const normalized = normalizePeerId(peerId);
  syncRuntimeAssetRevisionState(
    'a2a',
    peerAssetPath(normalized),
    {
      route: `a2a.e2ee.peer#${normalized}`,
      source: 'a2a-trust-ledger',
    },
    { exists: false, content: null },
  );
}

export function digestA2ATransportEnvelope(envelope: A2AEnvelope): string {
  return createHash('sha256')
    .update(JSON.stringify(validateA2AEnvelope(envelope)))
    .digest('base64url');
}

function encryptionMetadata(keyId: string): A2AEnvelopeEncryption {
  return {
    version: A2A_E2EE_VERSION,
    alg: A2A_E2EE_ALGORITHM,
    enc: A2A_E2EE_ENCRYPTION,
    kid: keyId,
  };
}

function buildEncryptedTransportEnvelope(params: {
  inner: A2AEnvelope;
  content: string;
  encryption: A2AEnvelopeEncryption;
}): A2AEnvelope {
  const {
    content: _content,
    encryption: _encryption,
    delegation_token: _delegationToken,
    source_instance_id: _sourceInstanceId,
    target_instance_id: _targetInstanceId,
    ...routingFields
  } = params.inner;
  return validateA2AEnvelope({
    ...routingFields,
    content: params.content,
    encryption: params.encryption,
  });
}

export async function encryptA2AEnvelopeForPeer(
  envelope: A2AEnvelope,
  peer: A2ATrustedE2EEPeer,
): Promise<A2AEnvelope> {
  const canonical = validateA2AEnvelope(envelope);
  if (canonical.encryption) {
    throw new A2AE2EEError('A2A envelope is already encrypted');
  }
  const publicKey = await importJWK(peer.publicKeyJwk, A2A_E2EE_ALGORITHM);
  const content = await new CompactEncrypt(
    new TextEncoder().encode(JSON.stringify(canonical)),
  )
    .setProtectedHeader({
      alg: A2A_E2EE_ALGORITHM,
      enc: A2A_E2EE_ENCRYPTION,
      cty: A2A_E2EE_CONTENT_TYPE,
      kid: peer.keyId,
    })
    .encrypt(publicKey);
  return buildEncryptedTransportEnvelope({
    inner: canonical,
    content,
    encryption: encryptionMetadata(peer.keyId),
  });
}

function assertProtectedHeader(
  header: JWEHeaderParameters,
  encryption: A2AEnvelopeEncryption,
): void {
  if (
    header.alg !== A2A_E2EE_ALGORITHM ||
    header.enc !== A2A_E2EE_ENCRYPTION ||
    header.cty !== A2A_E2EE_CONTENT_TYPE ||
    header.kid !== encryption.kid
  ) {
    throw new A2AE2EEError('A2A E2EE protected header does not match envelope');
  }
}

function assertEnvelopeBinding(outer: A2AEnvelope, inner: A2AEnvelope): void {
  if (!outer.encryption) {
    throw new A2AE2EEError('A2A E2EE envelope metadata is missing');
  }
  const rebound = buildEncryptedTransportEnvelope({
    inner,
    content: outer.content,
    encryption: outer.encryption,
  });
  if (JSON.stringify(rebound) !== JSON.stringify(outer)) {
    throw new A2AE2EEError('A2A E2EE envelope metadata binding failed');
  }
}

export async function decryptA2AEnvelope(
  envelope: A2AEnvelope,
  options: { required: boolean },
): Promise<A2AEnvelope> {
  const outer = validateA2AEnvelope(envelope);
  if (!outer.encryption) {
    if (options.required) {
      throw new A2AE2EEError('A2A E2EE is required for this peer');
    }
    return outer;
  }
  const keypair = ensureA2AE2EEKeypair();
  if (outer.encryption.kid !== keypair.keyId) {
    throw new A2AE2EEError('A2A E2EE message targets an unknown key');
  }
  try {
    const privateKey = await importJWK(
      keypair.privateKeyJwk,
      A2A_E2EE_ALGORITHM,
    );
    const decrypted = await compactDecrypt(outer.content, privateKey);
    assertProtectedHeader(decrypted.protectedHeader, outer.encryption);
    const parsed = JSON.parse(
      new TextDecoder().decode(decrypted.plaintext),
    ) as unknown;
    const inner = validateA2AEnvelope(parsed);
    if (inner.encryption) {
      throw new A2AE2EEError('Nested A2A E2EE envelopes are not allowed');
    }
    assertEnvelopeBinding(outer, inner);
    return inner;
  } catch (error) {
    if (error instanceof A2AE2EEError) throw error;
    throw new A2AE2EEError('A2A E2EE decryption failed');
  }
}
