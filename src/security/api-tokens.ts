import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { withMemoryDatabase } from '../memory/db.js';

export const API_TOKEN_PREFIX = 'hck';
const API_TOKEN_ID_BYTES = 6;
const API_TOKEN_SECRET_BYTES = 32;
const API_TOKEN_LAST_USED_UPDATE_MS = 60_000;
const API_TOKEN_RE = /^hck_([a-f0-9]{12})_([A-Za-z0-9_-]+)$/;
const API_TOKEN_LABEL_MAX_LENGTH = 120;
const API_TOKEN_VERIFIER_KEY = 'hybridclaw-api-token-verifier-v1';

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

function apiTokenVerifierHex(value: string): string {
  // lgtm[js/insufficient-password-hash] API tokens are 256-bit random bearer
  // secrets; this HMAC is a deterministic lookup verifier, not a password hash.
  return createHmac('sha256', API_TOKEN_VERIFIER_KEY)
    .update(value)
    .digest('hex');
}

function safeEqualHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
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

export function createApiToken(
  input: CreateApiTokenInput,
): CreateApiTokenResult {
  const label = normalizeApiTokenLabel(input.label);
  const claims = normalizeApiTokenClaims(input.claims);
  const expiresAt = normalizeOptionalTimestamp(input.expiresAt);
  const createdBy = normalizeCreatedBy(input.createdBy);
  const id = generateApiTokenId();
  const token = buildApiToken(id);
  const tokenHash = apiTokenVerifierHex(token);

  return withMemoryDatabase((database) => {
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
  const presentedHash = apiTokenVerifierHex(parsed.token);

  return withMemoryDatabase((database) => {
    const row = database
      .prepare<[string], ApiTokenRow>('SELECT * FROM api_tokens WHERE id = ?')
      .get(parsed.id);
    if (!row) return null;
    if (row.revoked_at) return null;
    if (isExpired(row, now)) return null;
    if (!safeEqualHex(presentedHash, row.token_hash)) return null;

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
