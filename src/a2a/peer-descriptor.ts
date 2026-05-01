import type { SecretRef } from '../security/secret-refs.js';
import { parseSecretInput } from '../security/secret-refs.js';
import { isRecord } from './utils.js';

export const A2A_PEER_TRANSPORTS = ['internal', 'a2a', 'webhook'] as const;

export type A2APeerTransport = (typeof A2A_PEER_TRANSPORTS)[number];

export interface InternalPeerDescriptor {
  transport: 'internal';
  agentId?: string;
}

export interface A2APeerDescriptor {
  transport: 'a2a';
  agentCardUrl: string;
}

export interface WebhookPeerDescriptor {
  transport: 'webhook';
  url: string;
  secretRef: SecretRef;
}

export interface UnknownPeerDescriptor {
  transport: string;
  raw: Record<string, unknown>;
}

export type KnownPeerDescriptor =
  | InternalPeerDescriptor
  | A2APeerDescriptor
  | WebhookPeerDescriptor;

export type PeerDescriptor = KnownPeerDescriptor | UnknownPeerDescriptor;

export class PeerDescriptorValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid A2A peer descriptor: ${issues.join('; ')}`);
    this.name = 'PeerDescriptorValidationError';
    this.issues = [...issues];
  }
}

function readAlias(
  record: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): unknown {
  return record[camelKey] !== undefined ? record[camelKey] : record[snakeKey];
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function readRequiredString(
  value: unknown,
  field: string,
  issues: string[],
): string {
  if (typeof value !== 'string') {
    issues.push(`${field} must be a string`);
    return '';
  }
  const normalized = value.trim();
  if (!normalized) {
    issues.push(`${field} is required`);
  }
  return normalized;
}

function validateAllowedFields(
  record: Record<string, unknown>,
  allowedFields: readonly string[],
  issues: string[],
): void {
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) {
      issues.push(`unexpected field: ${field}`);
    }
  }
}

function readHttpUrl(
  record: Record<string, unknown>,
  field: string,
  issues: string[],
): string {
  const value = readRequiredString(record[field], field, issues);
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      issues.push(`${field} must use http or https`);
    }
  } catch {
    issues.push(`${field} must be a valid URL`);
  }
  return value;
}

function normalizeTransport(value: unknown, issues: string[]): string {
  if (typeof value !== 'string') {
    issues.push('transport must be a string');
    return '';
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    issues.push('transport is required');
  }
  return normalized;
}

function normalizeWebhookSecretRef(
  value: unknown,
  issues: string[],
): SecretRef | undefined {
  const parsed = parseSecretInput(value);
  if (parsed.kind === 'invalid') {
    issues.push(`secretRef ${parsed.reason}`);
    return undefined;
  }
  if (parsed.kind === 'plain') {
    issues.push('secretRef must be a secret reference');
    return undefined;
  }
  return parsed.ref;
}

export function normalizePeerDescriptor(value: unknown): PeerDescriptor {
  if (value === undefined || value === null) {
    return { transport: 'internal' };
  }
  if (!isRecord(value)) {
    throw new PeerDescriptorValidationError(['descriptor must be an object']);
  }

  const issues: string[] = [];
  const transport = normalizeTransport(value.transport, issues);
  if (!transport) {
    throw new PeerDescriptorValidationError(issues);
  }

  if (transport === 'internal') {
    validateAllowedFields(value, ['transport', 'agentId', 'agent_id'], issues);
    const agentId = normalizeOptionalString(
      readAlias(value, 'agentId', 'agent_id'),
    );
    if (issues.length > 0) {
      throw new PeerDescriptorValidationError(issues);
    }
    return {
      transport: 'internal',
      ...(agentId ? { agentId } : {}),
    };
  }

  if (transport === 'a2a') {
    validateAllowedFields(
      value,
      ['transport', 'agentCardUrl', 'agent_card_url'],
      issues,
    );
    const agentCardUrl = readHttpUrl(
      { agentCardUrl: readAlias(value, 'agentCardUrl', 'agent_card_url') },
      'agentCardUrl',
      issues,
    );
    if (issues.length > 0) {
      throw new PeerDescriptorValidationError(issues);
    }
    return {
      transport: 'a2a',
      agentCardUrl,
    };
  }

  if (transport === 'webhook') {
    validateAllowedFields(
      value,
      ['transport', 'url', 'secretRef', 'secret_ref'],
      issues,
    );
    const url = readHttpUrl(value, 'url', issues);
    const secretRef = normalizeWebhookSecretRef(
      readAlias(value, 'secretRef', 'secret_ref'),
      issues,
    );
    if (issues.length > 0 || !secretRef) {
      throw new PeerDescriptorValidationError(issues);
    }
    return {
      transport: 'webhook',
      url,
      secretRef,
    };
  }

  validateAllowedFields(value, ['transport'], issues);
  if (issues.length > 0) {
    throw new PeerDescriptorValidationError(issues);
  }
  return {
    transport,
    raw: { ...value },
  };
}

export function isKnownPeerDescriptor(
  descriptor: PeerDescriptor,
): descriptor is KnownPeerDescriptor {
  return A2A_PEER_TRANSPORTS.includes(descriptor.transport as A2APeerTransport);
}
