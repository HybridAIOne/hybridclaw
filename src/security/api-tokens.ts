import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { withMemoryDatabase } from '../memory/db.js';

export const API_TOKEN_PREFIX = 'hck';
const API_TOKEN_ID_BYTES = 6;
const API_TOKEN_SECRET_BYTES = 32;
const API_TOKEN_SALT_BYTES = 16;
const API_TOKEN_VERIFIER_BYTES = 32;
const API_TOKEN_LAST_USED_UPDATE_MS = 60_000;
const API_TOKEN_RE = /^hck_([a-f0-9]{12})_([A-Za-z0-9_-]+)$/;
const API_TOKEN_LABEL_MAX_LENGTH = 120;
const API_TOKEN_VERIFIER_PREFIX = 'scrypt:v1';
const API_TOKEN_SCRYPT_OPTIONS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;

export interface ApiTokenMetadata {
  id: string;
  label: string;
  claims: Record<string, unknown>;
  created_at: string;
  created_by: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface CreateApiTokenInput {
  label: string;
  claims: Record<string, unknown>;
  expiresAt?: string | Date | null;
  createdBy?: string | null;
}

export interface CreateApiTokenResult {
  token: string;
  metadata: ApiTokenMetadata;
}

export interface VerifiedApiToken {
  id: string;
  label: string;
  claims: Record<string, unknown>;
}

interface ApiTokenRow {
  id: string;
  label: string;
  token_hash: string;
  claims: string;
  created_at: string;
  created_by: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

function deriveApiTokenVerifier(token: string, salt: Buffer): Buffer {
  return scryptSync(
    token,
    salt,
    API_TOKEN_VERIFIER_BYTES,
    API_TOKEN_SCRYPT_OPTIONS,
  );
}

function createApiTokenVerifier(token: string): string {
  const salt = randomBytes(API_TOKEN_SALT_BYTES);
  const verifier = deriveApiTokenVerifier(token, salt);
  return [
    API_TOKEN_VERIFIER_PREFIX,
    salt.toString('base64url'),
    verifier.toString('base64url'),
  ].join(':');
}

function parseStoredApiTokenVerifier(value: string): {
  salt: Buffer;
  verifier: Buffer;
} | null {
  const [scheme, version, rawSalt, rawVerifier, extra] = value.split(':');
  if (
    scheme !== 'scrypt' ||
    version !== 'v1' ||
    !rawSalt ||
    !rawVerifier ||
    extra !== undefined
  ) {
    return null;
  }
  const salt = Buffer.from(rawSalt, 'base64url');
  const verifier = Buffer.from(rawVerifier, 'base64url');
  if (
    salt.length !== API_TOKEN_SALT_BYTES ||
    verifier.length !== API_TOKEN_VERIFIER_BYTES
  ) {
    return null;
  }
  return { salt, verifier };
}

function isApiTokenVerifierMatch(
  token: string,
  storedVerifier: string,
): boolean {
  const parsed = parseStoredApiTokenVerifier(storedVerifier);
  if (!parsed) return false;
  const presentedVerifier = deriveApiTokenVerifier(token, parsed.salt);
  if (presentedVerifier.length !== parsed.verifier.length) return false;
  return timingSafeEqual(presentedVerifier, parsed.verifier);
}

function normalizeApiTokenLabel(value: string): string {
  const label = value.trim();
  if (!label) {
    throw new Error('API token label is required.');
  }
  if (label.length > API_TOKEN_LABEL_MAX_LENGTH) {
    throw new Error(
      `API token label must be ${API_TOKEN_LABEL_MAX_LENGTH} characters or fewer.`,
    );
  }
  return label;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasRbacClaimKey(value: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(value, 'actions') ||
    Object.hasOwn(value, 'scope') ||
    Object.hasOwn(value, 'role') ||
    Object.hasOwn(value, 'roles')
  );
}

export function normalizeApiTokenClaims(
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error('API token claims must be an object.');
  }
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  if (!isPlainRecord(normalized)) {
    throw new Error('API token claims must be JSON-serializable.');
  }
  if (!hasRbacClaimKey(normalized)) {
    normalized.actions = [];
  }
  return normalized;
}

function parseStoredClaims(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isPlainRecord(parsed)
      ? normalizeApiTokenClaims(parsed)
      : { actions: [] };
  } catch {
    return { actions: [] };
  }
}

function normalizeOptionalTimestamp(value: string | Date | null | undefined) {
  if (value === null || value === undefined) return null;
  const candidate = value instanceof Date ? value : new Date(value.trim());
  if (Number.isNaN(candidate.getTime())) {
    throw new Error('API token expiry must be a valid date.');
  }
  return candidate.toISOString();
}

function normalizeCreatedBy(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function generateApiTokenId(): string {
  return randomBytes(API_TOKEN_ID_BYTES).toString('hex');
}

function buildApiToken(id: string): string {
  const secret = randomBytes(API_TOKEN_SECRET_BYTES).toString('base64url');
  return `${API_TOKEN_PREFIX}_${id}_${secret}`;
}

function parseApiToken(value: string): { id: string; token: string } | null {
  const token = value.trim();
  const match = API_TOKEN_RE.exec(token);
  if (!match) return null;
  const id = match[1];
  return id ? { id, token } : null;
}

export function isApiTokenString(value: string): boolean {
  return value.trim().startsWith(`${API_TOKEN_PREFIX}_`);
}

function toMetadata(row: ApiTokenRow): ApiTokenMetadata {
  return {
    id: row.id,
    label: row.label,
    claims: parseStoredClaims(row.claims),
    created_at: row.created_at,
    created_by: row.created_by,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

function pruneExpiredApiTokensInDatabase(
  database: Database.Database,
  now: Date,
): number {
  return database
    .prepare(
      `DELETE FROM api_tokens
       WHERE expires_at IS NOT NULL
         AND expires_at <= ?`,
    )
    .run(now.toISOString()).changes;
}

export function pruneExpiredApiTokens(options: { now?: Date } = {}): number {
  const now = options.now ?? new Date();
  return withMemoryDatabase((database) =>
    pruneExpiredApiTokensInDatabase(database, now),
  );
}

export function createApiToken(
  input: CreateApiTokenInput,
): CreateApiTokenResult {
  const label = normalizeApiTokenLabel(input.label);
  const claims = normalizeApiTokenClaims(input.claims);
  const expiresAt = normalizeOptionalTimestamp(input.expiresAt);
  const createdBy = normalizeCreatedBy(input.createdBy);
  const id = generateApiTokenId();
  const token = buildApiToken(id);
  const tokenHash = createApiTokenVerifier(token);

  return withMemoryDatabase((database) => {
    pruneExpiredApiTokensInDatabase(database, new Date());
    database
      .prepare(
        `INSERT INTO api_tokens (
          id,
          label,
          token_hash,
          claims,
          created_by,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, label, tokenHash, JSON.stringify(claims), createdBy, expiresAt);

    const row = database
      .prepare<[string], ApiTokenRow>('SELECT * FROM api_tokens WHERE id = ?')
      .get(id);
    if (!row) {
      throw new Error('API token was not persisted.');
    }
    return {
      token,
      metadata: toMetadata(row),
    };
  });
}

export function listApiTokens(): ApiTokenMetadata[] {
  return withMemoryDatabase((database) =>
    database
      .prepare<[], ApiTokenRow>(
        `SELECT *
         FROM api_tokens
         ORDER BY created_at DESC, id ASC`,
      )
      .all()
      .map(toMetadata),
  );
}

export function revokeApiToken(id: string): ApiTokenMetadata | null {
  const normalizedId = id.trim().toLowerCase();
  if (!/^[a-f0-9]{12}$/.test(normalizedId)) return null;
  return withMemoryDatabase((database) => {
    database
      .prepare(
        `UPDATE api_tokens
         SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         WHERE id = ?`,
      )
      .run(normalizedId);
    const row = database
      .prepare<[string], ApiTokenRow>('SELECT * FROM api_tokens WHERE id = ?')
      .get(normalizedId);
    return row ? toMetadata(row) : null;
  });
}

function shouldTouchLastUsed(row: ApiTokenRow, now: Date): boolean {
  if (!row.last_used_at) return true;
  const previous = Date.parse(row.last_used_at);
  if (!Number.isFinite(previous)) return true;
  return now.getTime() - previous >= API_TOKEN_LAST_USED_UPDATE_MS;
}

function isExpired(row: ApiTokenRow, now: Date): boolean {
  if (!row.expires_at) return false;
  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt <= now.getTime();
}

export function verifyApiToken(
  bearer: string,
  options: { now?: Date } = {},
): VerifiedApiToken | null {
  const parsed = parseApiToken(bearer);
  if (!parsed) return null;
  const now = options.now ?? new Date();
  return withMemoryDatabase((database) => {
    const row = database
      .prepare<[string], ApiTokenRow>('SELECT * FROM api_tokens WHERE id = ?')
      .get(parsed.id);
    if (!row) return null;
    if (row.revoked_at) return null;
    if (isExpired(row, now)) return null;
    if (!isApiTokenVerifierMatch(parsed.token, row.token_hash)) return null;

    if (shouldTouchLastUsed(row, now)) {
      database
        .prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
        .run(now.toISOString(), row.id);
    }

    return {
      id: row.id,
      label: row.label,
      claims: parseStoredClaims(row.claims),
    };
  });
}
