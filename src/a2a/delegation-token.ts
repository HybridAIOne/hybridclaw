import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import {
  isCanonicalAgentIdentity,
  resolveLocalInstanceId,
} from '../identity/agent-id.js';
import { writeFileAtomicExclusive } from '../utils/atomic-file.js';
import { resolveA2AAgentId } from './identity.js';
import { isRecord } from './utils.js';

export const A2A_DELEGATION_TOKEN_TTL_SECONDS = 300;
export const A2A_DELEGATION_TOKEN_KEYPAIR_SCHEMA_VERSION = 1;
export const A2A_DELEGATION_TOKEN_REVOCATION_SCHEMA_VERSION = 1;
export const A2A_DELEGATION_TOKEN_ISSUER = 'hybridclaw';

export interface A2ADelegationTokenKeyPair {
  schemaVersion: typeof A2A_DELEGATION_TOKEN_KEYPAIR_SCHEMA_VERSION;
  keyId: string;
  algorithm: 'Ed25519';
  publicKeyPem: string;
  privateKeyPem: string;
  instanceId: string;
  createdAt: string;
}

export interface A2ADelegationTokenClaims {
  iss: typeof A2A_DELEGATION_TOKEN_ISSUER;
  sub: string;
  aud: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  sender_agent_id: string;
  target_agent_id: string;
  scope: string[];
  parent_run_id: string;
  // Observability only; integrity is bound by jti, sender, target, audience, and scope.
  message_id?: string;
  thread_id?: string;
}

export interface SignA2ADelegationTokenInput {
  senderAgentId: string;
  targetAgentId: string;
  audience: string;
  scope: string | string[];
  parentRunId: string;
  jwtId: string;
  messageId?: string;
  threadId?: string;
  now?: Date;
  expiresInSeconds?: number;
  keyPair?: A2ADelegationTokenKeyPair;
}

export interface VerifyA2ADelegationTokenInput {
  token: string;
  publicKeyPem: string;
  audience?: string | undefined;
  requiredScope?: string | string[] | undefined;
  senderAgentId?: string | undefined;
  targetAgentId?: string | undefined;
  now?: Date | undefined;
  revocationRootDir?: string | undefined;
}

export interface A2ADelegationTokenRevocation {
  schemaVersion: typeof A2A_DELEGATION_TOKEN_REVOCATION_SCHEMA_VERSION;
  jwtId: string;
  revokedAt: string;
}

export interface A2ADelegationTokenRevocationPruneResult {
  scanned: number;
  pruned: number;
}

export class A2ADelegationTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'A2ADelegationTokenError';
  }
}

export class A2ARevokedDelegationTokenError extends A2ADelegationTokenError {
  constructor(message = 'JWT has been revoked') {
    super(message);
    this.name = 'A2ARevokedDelegationTokenError';
  }
}

let cachedKeyPair: A2ADelegationTokenKeyPair | null = null;
let cachedPrivateKey: { pem: string; key: KeyObject } | null = null;
const cachedPublicKeys = new Map<string, KeyObject>();

function delegationKeyPairPath(): string {
  return path.join(
    DEFAULT_RUNTIME_HOME_DIR,
    'identity',
    'delegation-token-keypair.json',
  );
}

function delegationRevocationRootDir(): string {
  return path.join(DEFAULT_RUNTIME_HOME_DIR, 'a2a', 'delegation-revocations');
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeBase64UrlJson(segment: string, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8'));
  } catch {
    throw new A2ADelegationTokenError(`${label} is not valid base64url JSON`);
  }
}

function normalizeTokenString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new A2ADelegationTokenError(`${label} is required`);
  }
  if (/[\p{Cc}\s]/u.test(normalized)) {
    throw new A2ADelegationTokenError(
      `${label} must not contain whitespace or control characters`,
    );
  }
  return normalized;
}

function normalizeScope(scope: string | string[]): string[] {
  const rawScopes = Array.isArray(scope) ? scope : [scope];
  const normalizedScopes = Array.from(
    new Set(rawScopes.map((entry) => normalizeTokenString(entry, 'scope'))),
  );
  if (normalizedScopes.length === 0) {
    throw new A2ADelegationTokenError('scope is required');
  }
  return normalizedScopes;
}

function normalizeAgentIdForToken(agentId: string): string {
  const normalized = agentId.trim();
  if (isCanonicalAgentIdentity(normalized)) return normalized.toLowerCase();
  // Local ids are resolved to canonical ids so tokens stay portable across instances.
  return resolveA2AAgentId(normalized);
}

function privateKeyObject(privateKeyPem: string): KeyObject {
  if (cachedPrivateKey?.pem === privateKeyPem) return cachedPrivateKey.key;
  const key = createPrivateKey(privateKeyPem);
  cachedPrivateKey = { pem: privateKeyPem, key };
  return key;
}

function publicKeyObject(publicKeyPem: string): KeyObject {
  const cached = cachedPublicKeys.get(publicKeyPem);
  if (cached) return cached;
  const key = createPublicKey(publicKeyPem);
  cachedPublicKeys.set(publicKeyPem, key);
  return key;
}

function keyIdForPublicKey(publicKeyPem: string): string {
  return createHash('sha256')
    .update(publicKeyPem)
    .digest('base64url')
    .slice(0, 32);
}

function validateKeyPair(value: unknown): A2ADelegationTokenKeyPair {
  if (!isRecord(value)) {
    throw new A2ADelegationTokenError('delegation keypair must be an object');
  }
  const keyPair = value as Partial<A2ADelegationTokenKeyPair>;
  if (keyPair.schemaVersion !== A2A_DELEGATION_TOKEN_KEYPAIR_SCHEMA_VERSION) {
    throw new A2ADelegationTokenError('unsupported delegation keypair schema');
  }
  if (keyPair.algorithm !== 'Ed25519') {
    throw new A2ADelegationTokenError(
      'delegation keypair algorithm must be Ed25519',
    );
  }
  for (const field of [
    'keyId',
    'publicKeyPem',
    'privateKeyPem',
    'instanceId',
    'createdAt',
  ] as const) {
    if (typeof keyPair[field] !== 'string' || !keyPair[field]?.trim()) {
      throw new A2ADelegationTokenError(`${field} is required`);
    }
  }
  const keyId = keyPair.keyId as string;
  const publicKeyPem = keyPair.publicKeyPem as string;
  const privateKeyPem = keyPair.privateKeyPem as string;
  const instanceId = keyPair.instanceId as string;
  const createdAt = keyPair.createdAt as string;
  const publicKey = createPublicKey(publicKeyPem);
  createPrivateKey(privateKeyPem);
  const expectedKeyId = keyIdForPublicKey(
    publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  );
  if (keyId !== expectedKeyId) {
    throw new A2ADelegationTokenError(
      'delegation keypair keyId does not match public key',
    );
  }
  return {
    schemaVersion: A2A_DELEGATION_TOKEN_KEYPAIR_SCHEMA_VERSION,
    keyId,
    algorithm: 'Ed25519',
    publicKeyPem,
    privateKeyPem,
    instanceId,
    createdAt,
  };
}

function readKeyPair(keyPairPath: string): A2ADelegationTokenKeyPair | null {
  try {
    return validateKeyPair(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return null;
    throw error;
  }
}

function generateDelegationKeyPair(now: Date): A2ADelegationTokenKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey
    .export({ format: 'pem', type: 'spki' })
    .toString();
  const privateKeyPem = privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  return {
    schemaVersion: A2A_DELEGATION_TOKEN_KEYPAIR_SCHEMA_VERSION,
    keyId: keyIdForPublicKey(publicKeyPem),
    algorithm: 'Ed25519',
    publicKeyPem,
    privateKeyPem,
    instanceId: resolveLocalInstanceId(),
    createdAt: now.toISOString(),
  };
}

function writeNewKeyPair(
  keyPairPath: string,
  keyPair: A2ADelegationTokenKeyPair,
): void {
  try {
    writeFileAtomicExclusive(
      keyPairPath,
      `${JSON.stringify(keyPair, null, 2)}\n`,
      {
        tempPrefix: 'delegation-keypair',
        fileMode: 0o600,
      },
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== 'EEXIST') throw error;
  }
}

export function getOrCreateA2ADelegationTokenKeyPair(
  options: { keyPairPath?: string; now?: Date } = {},
): A2ADelegationTokenKeyPair {
  const defaultKeyPairPath = delegationKeyPairPath();
  const keyPairPath = options.keyPairPath ?? defaultKeyPairPath;
  const usesDefaultPath = keyPairPath === defaultKeyPairPath;
  if (usesDefaultPath && cachedKeyPair) return cachedKeyPair;

  const existing = readKeyPair(keyPairPath);
  if (existing) {
    if (usesDefaultPath) cachedKeyPair = existing;
    return existing;
  }

  const generated = generateDelegationKeyPair(options.now ?? new Date());
  writeNewKeyPair(keyPairPath, generated);
  const keyPair = readKeyPair(keyPairPath) ?? generated;
  if (usesDefaultPath) cachedKeyPair = keyPair;
  return keyPair;
}

function assertNumericDate(
  claims: Record<string, unknown>,
  field: 'iat' | 'nbf' | 'exp',
): number {
  const value = claims[field];
  if (!Number.isSafeInteger(value)) {
    throw new A2ADelegationTokenError(`${field} must be an integer timestamp`);
  }
  return value as number;
}

function assertStringClaim(
  claims: Record<string, unknown>,
  field:
    | 'iss'
    | 'sub'
    | 'aud'
    | 'jti'
    | 'sender_agent_id'
    | 'target_agent_id'
    | 'parent_run_id',
): string {
  const value = claims[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new A2ADelegationTokenError(`${field} is required`);
  }
  return value.trim();
}

function parseClaims(payload: unknown): A2ADelegationTokenClaims {
  if (!isRecord(payload)) {
    throw new A2ADelegationTokenError('JWT payload must be an object');
  }
  const iss = assertStringClaim(payload, 'iss');
  if (iss !== A2A_DELEGATION_TOKEN_ISSUER) {
    throw new A2ADelegationTokenError('JWT issuer is not trusted');
  }
  const scope = payload.scope;
  if (
    !Array.isArray(scope) ||
    scope.length === 0 ||
    !scope.every((entry) => typeof entry === 'string' && !!entry.trim())
  ) {
    throw new A2ADelegationTokenError('scope must be a non-empty string array');
  }
  const claims: A2ADelegationTokenClaims = {
    iss: A2A_DELEGATION_TOKEN_ISSUER,
    sub: assertStringClaim(payload, 'sub'),
    aud: assertStringClaim(payload, 'aud'),
    jti: assertStringClaim(payload, 'jti'),
    iat: assertNumericDate(payload, 'iat'),
    nbf: assertNumericDate(payload, 'nbf'),
    exp: assertNumericDate(payload, 'exp'),
    sender_agent_id: assertStringClaim(payload, 'sender_agent_id'),
    target_agent_id: assertStringClaim(payload, 'target_agent_id'),
    scope: scope.map((entry) => entry.trim()),
    parent_run_id: assertStringClaim(payload, 'parent_run_id'),
    ...(typeof payload.message_id === 'string' && payload.message_id.trim()
      ? { message_id: payload.message_id.trim() }
      : {}),
    ...(typeof payload.thread_id === 'string' && payload.thread_id.trim()
      ? { thread_id: payload.thread_id.trim() }
      : {}),
  };
  if (claims.sub !== claims.sender_agent_id) {
    throw new A2ADelegationTokenError('JWT sub must match sender_agent_id');
  }
  if (!isCanonicalAgentIdentity(claims.sender_agent_id)) {
    throw new A2ADelegationTokenError('sender_agent_id must be canonical');
  }
  if (!isCanonicalAgentIdentity(claims.target_agent_id)) {
    throw new A2ADelegationTokenError('target_agent_id must be canonical');
  }
  return claims;
}

export function signA2ADelegationToken(
  input: SignA2ADelegationTokenInput,
): string {
  const keyPair = input.keyPair ?? getOrCreateA2ADelegationTokenKeyPair();
  const issuedAt = Math.trunc((input.now ?? new Date()).getTime() / 1000);
  const expiresInSeconds =
    input.expiresInSeconds && input.expiresInSeconds > 0
      ? Math.trunc(input.expiresInSeconds)
      : A2A_DELEGATION_TOKEN_TTL_SECONDS;
  const senderAgentId = normalizeAgentIdForToken(input.senderAgentId);
  const targetAgentId = normalizeAgentIdForToken(input.targetAgentId);
  const claims: A2ADelegationTokenClaims = {
    iss: A2A_DELEGATION_TOKEN_ISSUER,
    sub: senderAgentId,
    aud: normalizeTokenString(input.audience, 'audience'),
    jti: normalizeTokenString(input.jwtId, 'jwtId'),
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + expiresInSeconds,
    sender_agent_id: senderAgentId,
    target_agent_id: targetAgentId,
    scope: normalizeScope(input.scope),
    parent_run_id: normalizeTokenString(input.parentRunId, 'parentRunId'),
    ...(input.messageId
      ? { message_id: normalizeTokenString(input.messageId, 'messageId') }
      : {}),
    ...(input.threadId
      ? { thread_id: normalizeTokenString(input.threadId, 'threadId') }
      : {}),
  };
  const header = base64UrlJson({
    alg: 'EdDSA',
    typ: 'JWT',
    kid: keyPair.keyId,
  });
  const payload = base64UrlJson(claims);
  const signingInput = `${header}.${payload}`;
  const signature = sign(
    null,
    Buffer.from(signingInput),
    privateKeyObject(keyPair.privateKeyPem),
  ).toString('base64url');
  return `${signingInput}.${signature}`;
}

export function decodeA2ADelegationTokenClaims(
  token: string,
): A2ADelegationTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new A2ADelegationTokenError('JWT must contain three segments');
  }
  return parseClaims(decodeBase64UrlJson(parts[1] || '', 'JWT payload'));
}

function revocationAssetPath(jwtId: string, rootDir: string): string {
  return path.join(
    rootDir,
    `${encodeURIComponent(normalizeTokenString(jwtId, 'jwtId'))}.json`,
  );
}

function parseRevocation(raw: string): A2ADelegationTokenRevocation | null {
  try {
    const parsed = JSON.parse(raw) as Partial<A2ADelegationTokenRevocation>;
    if (
      parsed.schemaVersion !== A2A_DELEGATION_TOKEN_REVOCATION_SCHEMA_VERSION ||
      typeof parsed.jwtId !== 'string' ||
      !parsed.jwtId.trim() ||
      typeof parsed.revokedAt !== 'string' ||
      !parsed.revokedAt.trim()
    ) {
      return null;
    }
    return {
      schemaVersion: A2A_DELEGATION_TOKEN_REVOCATION_SCHEMA_VERSION,
      jwtId: parsed.jwtId,
      revokedAt: parsed.revokedAt,
    };
  } catch {
    return null;
  }
}

export function pruneExpiredA2ADelegationTokenRevocations(
  options: {
    now?: Date | undefined;
    maxAgeSeconds?: number | undefined;
    revocationRootDir?: string | undefined;
  } = {},
): A2ADelegationTokenRevocationPruneResult {
  const rootDir = options.revocationRootDir ?? delegationRevocationRootDir();
  const maxAgeSeconds =
    options.maxAgeSeconds && options.maxAgeSeconds > 0
      ? Math.trunc(options.maxAgeSeconds)
      : A2A_DELEGATION_TOKEN_TTL_SECONDS;
  const expiresBeforeMs =
    (options.now ?? new Date()).getTime() - maxAgeSeconds * 1000;
  let scanned = 0;
  let pruned = 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return { scanned, pruned };
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    scanned += 1;
    const assetPath = path.join(rootDir, entry.name);
    const revocation = parseRevocation(fs.readFileSync(assetPath, 'utf-8'));
    if (!revocation) continue;
    const revokedAtMs = Date.parse(revocation.revokedAt);
    if (!Number.isFinite(revokedAtMs) || revokedAtMs > expiresBeforeMs) {
      continue;
    }
    fs.rmSync(assetPath, { force: true });
    pruned += 1;
  }

  return { scanned, pruned };
}

export function revokeA2ADelegationTokenId(
  jwtId: string,
  options: {
    revokedAt?: Date;
    revocationRootDir?: string;
  } = {},
): A2ADelegationTokenRevocation {
  const normalizedJwtId = normalizeTokenString(jwtId, 'jwtId');
  const revocation: A2ADelegationTokenRevocation = {
    schemaVersion: A2A_DELEGATION_TOKEN_REVOCATION_SCHEMA_VERSION,
    jwtId: normalizedJwtId,
    revokedAt: (options.revokedAt ?? new Date()).toISOString(),
  };
  const rootDir = options.revocationRootDir ?? delegationRevocationRootDir();
  fs.mkdirSync(rootDir, { recursive: true });
  pruneExpiredA2ADelegationTokenRevocations({
    now: options.revokedAt,
    revocationRootDir: rootDir,
  });
  fs.writeFileSync(
    revocationAssetPath(normalizedJwtId, rootDir),
    `${JSON.stringify(revocation, null, 2)}\n`,
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  );
  return revocation;
}

export function isA2ADelegationTokenRevoked(
  jwtId: string,
  options: { revocationRootDir?: string | undefined } = {},
): boolean {
  return fs.existsSync(
    revocationAssetPath(
      jwtId,
      options.revocationRootDir ?? delegationRevocationRootDir(),
    ),
  );
}

function assertTokenHeader(header: unknown): void {
  if (!isRecord(header)) {
    throw new A2ADelegationTokenError('JWT header must be an object');
  }
  if (header.alg !== 'EdDSA') {
    throw new A2ADelegationTokenError('JWT alg must be EdDSA');
  }
  if (header.typ !== undefined && header.typ !== 'JWT') {
    throw new A2ADelegationTokenError('JWT typ must be JWT when provided');
  }
}

function assertScope(
  claims: A2ADelegationTokenClaims,
  requiredScope: string | string[] | undefined,
): void {
  if (!requiredScope) return;
  const requiredScopes = normalizeScope(requiredScope);
  for (const scope of requiredScopes) {
    if (!claims.scope.includes(scope)) {
      throw new A2ADelegationTokenError(`JWT missing required scope: ${scope}`);
    }
  }
}

export function verifyA2ADelegationToken(
  input: VerifyA2ADelegationTokenInput,
): A2ADelegationTokenClaims {
  const parts = input.token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new A2ADelegationTokenError('JWT must contain three segments');
  }
  const [headerSegment = '', payloadSegment = '', signatureSegment = ''] =
    parts;
  assertTokenHeader(decodeBase64UrlJson(headerSegment, 'JWT header'));
  const signatureOk = verify(
    null,
    Buffer.from(`${headerSegment}.${payloadSegment}`),
    publicKeyObject(input.publicKeyPem),
    Buffer.from(signatureSegment, 'base64url'),
  );
  if (!signatureOk) {
    throw new A2ADelegationTokenError('JWT signature is invalid');
  }
  const claims = parseClaims(
    decodeBase64UrlJson(payloadSegment, 'JWT payload'),
  );

  const nowSeconds = Math.trunc((input.now ?? new Date()).getTime() / 1000);
  if (claims.nbf > nowSeconds) {
    throw new A2ADelegationTokenError('JWT is not active yet');
  }
  if (claims.exp <= nowSeconds) {
    throw new A2ADelegationTokenError('JWT has expired');
  }
  if (
    input.audience &&
    claims.aud !== normalizeTokenString(input.audience, 'audience')
  ) {
    throw new A2ADelegationTokenError('JWT audience does not match');
  }
  assertScope(claims, input.requiredScope);
  if (
    input.senderAgentId &&
    claims.sender_agent_id !== normalizeAgentIdForToken(input.senderAgentId)
  ) {
    throw new A2ADelegationTokenError('JWT sender does not match');
  }
  if (
    input.targetAgentId &&
    claims.target_agent_id !== normalizeAgentIdForToken(input.targetAgentId)
  ) {
    throw new A2ADelegationTokenError('JWT target does not match');
  }
  if (
    isA2ADelegationTokenRevoked(claims.jti, {
      revocationRootDir: input.revocationRootDir,
    })
  ) {
    throw new A2ARevokedDelegationTokenError();
  }
  return claims;
}
