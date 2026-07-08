import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { withMemoryDatabase } from '../memory/db.js';
import {
  createScryptVerifier,
  isScryptVerifierMatch,
} from './token-verifier.js';

export const PUBLICATION_TOKEN_PREFIX = 'hcp';

const PUBLICATION_TOKEN_ID_BYTES = 6;
const PUBLICATION_TOKEN_SECRET_BYTES = 32;
const PUBLICATION_TOKEN_RE = /^hcp_([a-f0-9]{12})_([A-Za-z0-9_-]+)$/;
const PUBLICATION_LABEL_MAX_LENGTH = 120;
const PUBLICATION_ID_RE = /^[a-f0-9]{12}$/;
const DEFAULT_PUBLICATION_POLICY_TTL_SECONDS = 60 * 60;

export interface LinkPublicationPolicy {
  kind: 'link';
  ttlSeconds?: number;
}

export interface PasswordPublicationPolicy {
  kind: 'password';
  hash: string;
  ttlSeconds?: number;
}

export interface OidcPublicationPolicy {
  kind: 'oidc';
  provider: 'entra';
  tenantId: string;
  audience: string;
  allowFrom: string[];
  ttlSeconds?: number;
}

export type AppPublicationPolicy =
  | LinkPublicationPolicy
  | PasswordPublicationPolicy
  | OidcPublicationPolicy;

export interface AppPublicationMetadata {
  id: string;
  appId: string;
  policy: AppPublicationPolicy;
  embedHosts: string[];
  allowBridge: boolean;
  label: string | null;
  created_at: string;
  created_by: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface CreatePublicationInput {
  appId: string;
  policy: AppPublicationPolicy;
  embedHosts?: string[];
  allowBridge?: boolean;
  label?: string | null;
  createdBy?: string | null;
  expiresAt?: string | Date | null;
}

export interface CreatePublicationResult {
  token: string;
  metadata: AppPublicationMetadata;
}

export type VerifyPublicationTokenResult =
  | { status: 'ok'; publication: AppPublicationMetadata }
  | { status: 'malformed' | 'missing' | 'revoked' | 'expired' };

interface AppPublicationRow {
  id: string;
  app_id: string;
  token_hash: string;
  policy: string;
  embed_hosts: string;
  allow_bridge: number;
  label: string | null;
  created_at: string;
  created_by: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

function normalizeOptionalTimestamp(
  value: string | Date | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const candidate = value instanceof Date ? value : new Date(value.trim());
  if (Number.isNaN(candidate.getTime())) {
    throw new Error('Publication expiry must be a valid date.');
  }
  return candidate.toISOString();
}

function normalizeNullableText(
  value: string | null | undefined,
): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizePublicationLabel(value: string | null | undefined) {
  const label = normalizeNullableText(value);
  if (label && label.length > PUBLICATION_LABEL_MAX_LENGTH) {
    throw new Error(
      `Publication label must be ${PUBLICATION_LABEL_MAX_LENGTH} characters or fewer.`,
    );
  }
  return label;
}

function normalizeTtlSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Publication policy ttlSeconds must be a number.');
  }
  const normalized = Math.floor(value);
  if (normalized < 60 || normalized > 24 * 60 * 60) {
    throw new Error(
      'Publication policy ttlSeconds must be between 60 and 86400.',
    );
  }
  return normalized;
}

function normalizePublicationPolicy(
  policy: AppPublicationPolicy,
): AppPublicationPolicy {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('Publication policy must be an object.');
  }
  const ttlSeconds = normalizeTtlSeconds(
    (policy as { ttlSeconds?: unknown }).ttlSeconds,
  );
  if (policy.kind === 'link') {
    return { kind: 'link', ...(ttlSeconds ? { ttlSeconds } : {}) };
  }
  if (policy.kind === 'password') {
    const hash = String(policy.hash || '').trim();
    if (!hash) throw new Error('Password publication policy hash is required.');
    return { kind: 'password', hash, ...(ttlSeconds ? { ttlSeconds } : {}) };
  }
  if (policy.kind === 'oidc') {
    const provider = policy.provider;
    if (provider !== 'entra') {
      throw new Error('Unsupported OIDC publication provider.');
    }
    const tenantId = policy.tenantId.trim();
    const audience = policy.audience.trim();
    if (!tenantId) throw new Error('OIDC tenantId is required.');
    if (!audience) throw new Error('OIDC audience is required.');
    return {
      kind: 'oidc',
      provider,
      tenantId,
      audience,
      allowFrom: normalizeStringList(policy.allowFrom),
      ...(ttlSeconds ? { ttlSeconds } : {}),
    };
  }
  throw new Error('Unsupported publication policy kind.');
}

function normalizeStringList(values: unknown): string[] {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) {
    throw new Error('Expected an array of strings.');
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      throw new Error('Expected an array of strings.');
    }
    const text = value.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }
  return normalized;
}

function normalizeEmbedHosts(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const text = value.trim();
    if (!text) continue;
    let origin: string;
    try {
      const parsed = new URL(text);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('Unsupported protocol.');
      }
      origin = parsed.origin;
    } catch {
      throw new Error(`Invalid embed host: ${text}`);
    }
    if (seen.has(origin)) continue;
    seen.add(origin);
    normalized.push(origin);
  }
  return normalized;
}

function parseStoredPolicy(value: string): AppPublicationPolicy {
  const parsed = JSON.parse(value) as AppPublicationPolicy;
  return normalizePublicationPolicy(parsed);
}

function parseStoredEmbedHosts(value: string): string[] {
  try {
    return normalizeEmbedHosts(JSON.parse(value) as string[]);
  } catch {
    return [];
  }
}

function toMetadata(row: AppPublicationRow): AppPublicationMetadata {
  return {
    id: row.id,
    appId: row.app_id,
    policy: parseStoredPolicy(row.policy),
    embedHosts: parseStoredEmbedHosts(row.embed_hosts),
    allowBridge: row.allow_bridge === 1,
    label: row.label,
    created_at: row.created_at,
    created_by: row.created_by,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
  };
}

function tryToMetadata(row: AppPublicationRow): AppPublicationMetadata | null {
  try {
    return toMetadata(row);
  } catch {
    return null;
  }
}

function generatePublicationId(): string {
  return randomBytes(PUBLICATION_TOKEN_ID_BYTES).toString('hex');
}

function buildPublicationToken(id: string): string {
  const secret = randomBytes(PUBLICATION_TOKEN_SECRET_BYTES).toString(
    'base64url',
  );
  return `${PUBLICATION_TOKEN_PREFIX}_${id}_${secret}`;
}

function parsePublicationToken(
  value: string,
): { id: string; token: string } | null {
  const token = value.trim();
  const match = PUBLICATION_TOKEN_RE.exec(token);
  if (!match) return null;
  const id = match[1];
  return id ? { id, token } : null;
}

function isExpired(row: AppPublicationRow, now: Date): boolean {
  if (!row.expires_at) return false;
  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt <= now.getTime();
}

function prunePublicationsInDatabase(
  database: Database.Database,
  now: Date,
): number {
  return database
    .prepare(
      `DELETE FROM app_publications
       WHERE expires_at IS NOT NULL
         AND expires_at <= ?`,
    )
    .run(now.toISOString()).changes;
}

export function createPasswordPublicationPolicy(
  password: string,
): PasswordPublicationPolicy {
  const normalized = password.trim();
  if (!normalized) throw new Error('Publication password is required.');
  return { kind: 'password', hash: createScryptVerifier(normalized) };
}

export function isPublicationPasswordMatch(
  policy: PasswordPublicationPolicy,
  password: string,
): boolean {
  return isScryptVerifierMatch(password.trim(), policy.hash);
}

export function getPublicationPolicyTtlMs(
  policy: AppPublicationPolicy,
): number {
  return (policy.ttlSeconds ?? DEFAULT_PUBLICATION_POLICY_TTL_SECONDS) * 1000;
}

export function createPublication(
  input: CreatePublicationInput,
): CreatePublicationResult {
  const appId = input.appId.trim();
  if (!appId) throw new Error('Publication appId is required.');
  const policy = normalizePublicationPolicy(input.policy);
  const embedHosts = normalizeEmbedHosts(input.embedHosts);
  const allowBridge = input.allowBridge === true;
  const label = normalizePublicationLabel(input.label);
  const createdBy = normalizeNullableText(input.createdBy);
  const expiresAt = normalizeOptionalTimestamp(input.expiresAt);
  const id = generatePublicationId();
  const token = buildPublicationToken(id);
  const tokenHash = createScryptVerifier(token);

  return withMemoryDatabase((database) => {
    prunePublicationsInDatabase(database, new Date());
    database
      .prepare(
        `INSERT INTO app_publications (
          id,
          app_id,
          token_hash,
          policy,
          embed_hosts,
          allow_bridge,
          label,
          created_by,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        appId,
        tokenHash,
        JSON.stringify(policy),
        JSON.stringify(embedHosts),
        allowBridge ? 1 : 0,
        label,
        createdBy,
        expiresAt,
      );

    const row = database
      .prepare<[string], AppPublicationRow>(
        'SELECT * FROM app_publications WHERE id = ?',
      )
      .get(id);
    if (!row) throw new Error('Publication was not persisted.');
    return {
      token,
      metadata: toMetadata(row),
    };
  });
}

export function listPublicationsForApp(
  appId: string,
): AppPublicationMetadata[] {
  const normalized = appId.trim();
  if (!normalized) return [];
  return withMemoryDatabase((database) =>
    database
      .prepare<[string], AppPublicationRow>(
        `SELECT *
         FROM app_publications
         WHERE app_id = ?
         ORDER BY created_at DESC, id ASC`,
      )
      .all(normalized)
      .map(tryToMetadata)
      .filter((publication) => publication !== null),
  );
}

export function verifyPublicationToken(
  token: string,
  options: { now?: Date } = {},
): VerifyPublicationTokenResult {
  const parsed = parsePublicationToken(token);
  if (!parsed) return { status: 'malformed' };
  const now = options.now ?? new Date();
  return withMemoryDatabase((database) => {
    const row = database
      .prepare<[string], AppPublicationRow>(
        'SELECT * FROM app_publications WHERE id = ?',
      )
      .get(parsed.id);
    if (!row) return { status: 'missing' };
    if (!isScryptVerifierMatch(parsed.token, row.token_hash)) {
      return { status: 'missing' };
    }
    if (row.revoked_at) return { status: 'revoked' };
    if (isExpired(row, now)) return { status: 'expired' };
    const publication = tryToMetadata(row);
    if (!publication) return { status: 'missing' };
    return { status: 'ok', publication };
  });
}

export function revokePublication(id: string): AppPublicationMetadata | null {
  const normalizedId = id.trim().toLowerCase();
  if (!PUBLICATION_ID_RE.test(normalizedId)) return null;
  return withMemoryDatabase((database) => {
    database
      .prepare(
        `UPDATE app_publications
         SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         WHERE id = ?`,
      )
      .run(normalizedId);
    const row = database
      .prepare<[string], AppPublicationRow>(
        'SELECT * FROM app_publications WHERE id = ?',
      )
      .get(normalizedId);
    return row ? tryToMetadata(row) : null;
  });
}

export function revokePublicationsForApp(appId: string): number {
  const normalized = appId.trim();
  if (!normalized) return 0;
  return withMemoryDatabase(
    (database) =>
      database
        .prepare(
          `UPDATE app_publications
         SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         WHERE app_id = ?
           AND revoked_at IS NULL`,
        )
        .run(normalized).changes,
  );
}

export function prunePublications(options: { now?: Date } = {}): number {
  const now = options.now ?? new Date();
  return withMemoryDatabase((database) =>
    prunePublicationsInDatabase(database, now),
  );
}
