import { createHash } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';

import { isA2AAllowedHttpUrl } from '../a2a/utils.js';
import { type ParsedAgentIdentity, parseAgentIdentity } from './agent-id.js';
import { type ParsedUserId, parseUserId } from './user-id.js';

export const IDENTITY_RESOLVER_CACHE_TTL_MS = 5 * 60_000;
export const IDENTITY_RESOLVER_CACHE_MAX_ENTRIES = 1024;

export interface IdentityResolution {
  readonly url: string;
  readonly publicKey: string;
}

export type CanonicalIdentityKind = 'agent' | 'user';

export type ParsedCanonicalIdentity =
  | {
      readonly kind: 'agent';
      readonly id: string;
      readonly parsed: ParsedAgentIdentity;
    }
  | {
      readonly kind: 'user';
      readonly id: string;
      readonly parsed: ParsedUserId;
    };

export interface IdentityResolverBackend {
  lookup(canonicalId: string): Promise<IdentityResolution | null>;
}

export interface IdentityResolverOptions {
  readonly backend: IdentityResolverBackend;
  readonly cacheTtlMs?: number;
  readonly cacheMaxEntries?: number;
  readonly now?: () => Date;
}

interface CachedIdentityResolution {
  readonly resolution: IdentityResolution;
  readonly expiresAt: number;
}

export class IdentityResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityResolverError';
  }
}

export class IdentityNotFoundError extends IdentityResolverError {
  readonly canonicalId: string;

  constructor(canonicalId: string) {
    super(`No identity discovery record found for ${canonicalId}.`);
    this.name = 'IdentityNotFoundError';
    this.canonicalId = canonicalId;
  }
}

export function parseCanonicalIdentity(value: string): ParsedCanonicalIdentity {
  const normalized = value.trim();
  const partCount = normalized.split('@').length;

  if (partCount === 3) {
    const parsed = parseAgentIdentity(normalized);
    return { kind: 'agent', id: parsed.id, parsed };
  }

  if (partCount === 2) {
    const parsed = parseUserId(normalized);
    return { kind: 'user', id: parsed.id, parsed };
  }

  throw new IdentityResolverError(
    'canonicalId must be a canonical user id (username@authority) or agent id (agent-slug@user@instance-id)',
  );
}

function normalizeCacheTtlMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return IDENTITY_RESOLVER_CACHE_TTL_MS;
  return Math.max(1, Math.trunc(value as number));
}

function normalizeCacheMaxEntries(value: number | undefined): number {
  if (!Number.isFinite(value)) return IDENTITY_RESOLVER_CACHE_MAX_ENTRIES;
  return Math.max(1, Math.trunc(value as number));
}

function normalizeIdentityResolution(value: unknown): IdentityResolution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityResolverError(
      'identity discovery record must be an object',
    );
  }
  const record = value as Record<string, unknown>;
  const rawUrl = record.url ?? record.instanceUrl ?? record.instance_url;
  const rawPublicKey = record.publicKey ?? record.public_key;
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new IdentityResolverError(
      'identity discovery record url is required',
    );
  }
  const url = normalizeIdentityUrl(rawUrl);
  if (typeof rawPublicKey !== 'string' || !rawPublicKey.trim()) {
    throw new IdentityResolverError(
      'identity discovery record publicKey is required',
    );
  }
  return {
    url,
    publicKey: rawPublicKey.trim(),
  };
}

function normalizeIdentityUrl(value: string): string {
  const trimmed = value.trim();
  if (!isA2AAllowedHttpUrl(trimmed)) {
    throw new IdentityResolverError(
      'identity discovery url must use https unless targeting loopback',
    );
  }
  const url = new URL(trimmed);
  url.hash = '';
  if (url.pathname === '/' && !url.search) {
    return url.origin;
  }
  return url.toString().replace(/\/$/u, '');
}

export class IdentityResolver {
  private readonly backend: IdentityResolverBackend;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly now: () => Date;
  private readonly cache = new Map<string, CachedIdentityResolution>();

  constructor(options: IdentityResolverOptions) {
    this.backend = options.backend;
    this.cacheTtlMs = normalizeCacheTtlMs(options.cacheTtlMs);
    this.cacheMaxEntries = normalizeCacheMaxEntries(options.cacheMaxEntries);
    this.now = options.now ?? (() => new Date());
  }

  async resolve(canonicalId: string): Promise<IdentityResolution> {
    const normalizedId = parseCanonicalIdentity(canonicalId).id;
    const nowMs = this.now().getTime();
    this.pruneExpired(nowMs);
    const cached = this.cache.get(normalizedId);
    if (cached && cached.expiresAt > nowMs) {
      return cached.resolution;
    }

    const result = await this.backend.lookup(normalizedId);
    if (!result) {
      throw new IdentityNotFoundError(normalizedId);
    }
    const resolution = normalizeIdentityResolution(result);
    this.cache.set(normalizedId, {
      resolution,
      expiresAt: nowMs + this.cacheTtlMs,
    });
    this.enforceCacheMaxEntries();
    return resolution;
  }

  invalidate(canonicalId?: string): void {
    if (canonicalId === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(parseCanonicalIdentity(canonicalId).id);
  }

  private pruneExpired(nowMs: number): void {
    for (const [key, cached] of this.cache) {
      if (cached.expiresAt <= nowMs) {
        this.cache.delete(key);
      }
    }
  }

  private enforceCacheMaxEntries(): void {
    while (this.cache.size > this.cacheMaxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) return;
      this.cache.delete(oldestKey);
    }
  }
}

export type DnsTxtLookup = (name: string) => Promise<readonly string[][]>;

export interface DnsIdentityResolverBackendOptions {
  readonly zone: string;
  readonly lookupTxt?: DnsTxtLookup;
}

function normalizeDnsZone(zone: string): string {
  const normalized = zone.trim().toLowerCase().replace(/\.+$/u, '');
  if (!normalized) {
    throw new IdentityResolverError('identity discovery DNS zone is required');
  }
  return normalized;
}

export function identityDiscoveryDnsName(
  canonicalId: string,
  zone: string,
): string {
  const normalizedId = parseCanonicalIdentity(canonicalId).id;
  const normalizedZone = normalizeDnsZone(zone);
  const idHash = createHash('sha256').update(normalizedId).digest('base64url');
  return `_hybridclaw-id.${idHash}.${normalizedZone}`;
}

function isDnsNotFound(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  return ['ENODATA', 'ENOTFOUND', 'ENODOMAIN'].includes(code);
}

function parseDnsIdentityRecord(
  canonicalId: string,
  txtRecord: readonly string[],
): IdentityResolution | null {
  const raw = txtRecord.join('').trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IdentityResolverError(
      'identity discovery TXT record must be JSON',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IdentityResolverError(
      'identity discovery TXT record must be a JSON object',
    );
  }
  const record = parsed as Record<string, unknown>;
  const recordCanonicalId = record.canonicalId ?? record.canonical_id;
  if (typeof recordCanonicalId === 'string') {
    const normalizedRecordId = parseCanonicalIdentity(recordCanonicalId).id;
    if (normalizedRecordId !== canonicalId) return null;
  }
  return normalizeIdentityResolution(record);
}

export class DnsIdentityResolverBackend implements IdentityResolverBackend {
  private readonly zone: string;
  private readonly lookupTxt: DnsTxtLookup;

  constructor(options: DnsIdentityResolverBackendOptions) {
    this.zone = normalizeDnsZone(options.zone);
    this.lookupTxt = options.lookupTxt ?? ((name: string) => resolveTxt(name));
  }

  async lookup(canonicalId: string): Promise<IdentityResolution | null> {
    const normalizedId = parseCanonicalIdentity(canonicalId).id;
    const recordName = identityDiscoveryDnsName(normalizedId, this.zone);
    let records: readonly string[][];
    try {
      records = await this.lookupTxt(recordName);
    } catch (error) {
      if (isDnsNotFound(error)) return null;
      throw error;
    }

    let firstRecordError: Error | null = null;
    for (const record of records) {
      try {
        const resolution = parseDnsIdentityRecord(normalizedId, record);
        if (resolution) return resolution;
      } catch (error) {
        firstRecordError ??=
          error instanceof Error
            ? error
            : new IdentityResolverError('unknown TXT record parse error');
      }
    }
    if (firstRecordError) {
      throw new IdentityResolverError(
        `No usable identity discovery TXT record for ${normalizedId} at ${recordName}: ${firstRecordError.message}`,
      );
    }
    return null;
  }
}
