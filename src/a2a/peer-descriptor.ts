import type { SecretRef } from '../security/secret-refs.js';
import { parseSecretInput } from '../security/secret-refs.js';
import {
  A2A_TRANSPORT_PATTERN,
  isA2AAllowedHttpUrl,
  isA2ALoopbackHttpUrl,
  isRecord,
  normalizeTransportString,
} from './utils.js';

export const A2A_PEER_TRANSPORTS = ['internal', 'a2a', 'webhook'] as const;

export type A2APeerTransport = (typeof A2A_PEER_TRANSPORTS)[number];

const INTERNAL_ALLOWED_FIELDS = new Set(['transport', 'agentId', 'agent_id']);
const A2A_ALLOWED_FIELDS = new Set([
  'transport',
  'url',
  'peerUrl',
  'peer_url',
  'baseUrl',
  'base_url',
  'agentCardUrl',
  'agent_card_url',
  'bearerTokenRef',
  'bearer_token_ref',
]);
const WEBHOOK_ALLOWED_FIELDS = new Set([
  'transport',
  'url',
  'secretRef',
  'secret_ref',
  'signatureHeader',
  'signature_header',
  'version',
]);

export interface InternalPeerDescriptor {
  transport: 'internal';
  agentId?: string;
}

export interface A2APeerDescriptor {
  transport: 'a2a';
  agentCardUrl: string;
  bearerTokenRef?: SecretRef;
}

export interface WebhookPeerDescriptor {
  transport: 'webhook';
  url: string;
  secretRef: SecretRef;
  signatureHeader?: string;
  version?: string;
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

function readOptionalStringAlias(
  record: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
  field: string,
  issues: string[],
): string | undefined {
  if (!Object.hasOwn(record, camelKey) && !Object.hasOwn(record, snakeKey)) {
    return undefined;
  }
  const value = readAlias(record, camelKey, snakeKey);
  if (typeof value !== 'string') {
    issues.push(`${field} must be a string when provided`);
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    issues.push(`${field} must not be empty when provided`);
    return undefined;
  }
  return normalized;
}

function readOptionalString(
  record: Record<string, unknown>,
  field: string,
  issues: string[],
): string | undefined {
  if (!Object.hasOwn(record, field)) return undefined;
  const value = record[field];
  if (typeof value !== 'string') {
    issues.push(`${field} must be a string when provided`);
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    issues.push(`${field} must not be empty when provided`);
    return undefined;
  }
  return normalized;
}

function validateAllowedFields(
  record: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  issues: string[],
): void {
  for (const field of Object.keys(record)) {
    if (!allowedFields.has(field)) {
      issues.push(`unexpected field: ${field}`);
    }
  }
}

function readWebhookUrl(
  record: Record<string, unknown>,
  field: string,
  issues: string[],
): string {
  const value = readRequiredString(record[field], field, issues);
  if (!value) return '';
  try {
    new URL(value);
  } catch {
    issues.push(`${field} must be a valid URL`);
    return value;
  }
  if (!isA2AAllowedHttpUrl(value)) {
    issues.push(`${field} must use https unless targeting loopback`);
  }
  return value;
}

function readOptionalUrlAlias(
  record: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
  field: string,
  issues: string[],
): string | undefined {
  const value = readOptionalStringAlias(
    record,
    camelKey,
    snakeKey,
    field,
    issues,
  );
  if (!value) return undefined;
  try {
    new URL(value);
  } catch {
    issues.push(`${field} must be a valid URL`);
    return undefined;
  }
  if (!isA2AAllowedHttpUrl(value)) {
    issues.push(`${field} must use https unless targeting loopback`);
  }
  return value;
}

function deriveAgentCardUrl(peerUrl: string): string {
  const url = new URL(peerUrl);
  return new URL('/.well-known/agent.json', url.origin).toString();
}

function readA2AAgentCardUrl(
  record: Record<string, unknown>,
  issues: string[],
): string {
  const explicitAgentCardUrl = readAlias(
    record,
    'agentCardUrl',
    'agent_card_url',
  );
  if (explicitAgentCardUrl !== undefined) {
    return readWebhookUrl(
      { agentCardUrl: explicitAgentCardUrl },
      'agentCardUrl',
      issues,
    );
  }

  const hasPeerUrl =
    Object.hasOwn(record, 'peerUrl') ||
    Object.hasOwn(record, 'peer_url') ||
    Object.hasOwn(record, 'baseUrl') ||
    Object.hasOwn(record, 'base_url') ||
    Object.hasOwn(record, 'url');
  const peerUrl =
    readOptionalUrlAlias(record, 'peerUrl', 'peer_url', 'peerUrl', issues) ||
    readOptionalUrlAlias(record, 'baseUrl', 'base_url', 'baseUrl', issues) ||
    readOptionalUrlAlias(record, 'url', 'url', 'url', issues);
  if (!peerUrl) {
    if (!hasPeerUrl) {
      issues.push('agentCardUrl or url is required');
    }
    return '';
  }
  return deriveAgentCardUrl(peerUrl);
}

function readHttpHeaderName(
  record: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
  field: string,
  issues: string[],
): string | undefined {
  const value = readOptionalStringAlias(
    record,
    camelKey,
    snakeKey,
    field,
    issues,
  );
  if (!value) return undefined;
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(value)) {
    issues.push(`${field} must be a valid HTTP header name`);
    return undefined;
  }
  return value;
}

function normalizeTransport(value: unknown, issues: string[]): string {
  if (typeof value !== 'string') {
    issues.push('transport must be a string');
    return '';
  }
  const normalized = normalizeTransportString(value);
  if (!normalized) {
    issues.push('transport is required');
  } else if (!A2A_TRANSPORT_PATTERN.test(normalized)) {
    issues.push(
      'transport must match /^[a-z][a-z0-9._-]{0,63}$/ after trimming and lowercasing',
    );
  }
  return normalized;
}

function normalizeSecretRef(
  value: unknown,
  field: string,
  issues: string[],
  required: boolean,
): SecretRef | undefined {
  if (value === undefined || value === null) {
    if (required) {
      issues.push(`${field} is required`);
    }
    return undefined;
  }
  const parsed = parseSecretInput(value);
  if (parsed.kind === 'invalid') {
    issues.push(`${field} ${parsed.reason}`);
    return undefined;
  }
  if (parsed.kind === 'plain') {
    issues.push(`${field} must be a secret reference`);
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
  if (issues.length > 0) {
    throw new PeerDescriptorValidationError(issues);
  }

  if (transport === 'internal') {
    validateAllowedFields(value, INTERNAL_ALLOWED_FIELDS, issues);
    const agentId = readOptionalStringAlias(
      value,
      'agentId',
      'agent_id',
      'agentId',
      issues,
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
    validateAllowedFields(value, A2A_ALLOWED_FIELDS, issues);
    const agentCardUrl = readA2AAgentCardUrl(value, issues);
    const bearerTokenRef = normalizeSecretRef(
      readAlias(value, 'bearerTokenRef', 'bearer_token_ref'),
      'bearerTokenRef',
      issues,
      false,
    );
    if (
      agentCardUrl &&
      !isA2ALoopbackHttpUrl(agentCardUrl) &&
      !bearerTokenRef
    ) {
      issues.push('bearerTokenRef is required for non-loopback a2a peers');
    }
    if (issues.length > 0) {
      throw new PeerDescriptorValidationError(issues);
    }
    return {
      transport: 'a2a',
      agentCardUrl,
      ...(bearerTokenRef ? { bearerTokenRef } : {}),
    };
  }

  if (transport === 'webhook') {
    validateAllowedFields(value, WEBHOOK_ALLOWED_FIELDS, issues);
    const url = readWebhookUrl(value, 'url', issues);
    const secretRef = normalizeSecretRef(
      readAlias(value, 'secretRef', 'secret_ref'),
      'secretRef',
      issues,
      true,
    );
    const signatureHeader = readHttpHeaderName(
      value,
      'signatureHeader',
      'signature_header',
      'signatureHeader',
      issues,
    );
    const version = readOptionalString(value, 'version', issues);
    if (version && version !== '1') {
      issues.push('version must be 1 when provided');
    }
    if (issues.length > 0 || !secretRef) {
      throw new PeerDescriptorValidationError(issues);
    }
    return {
      transport: 'webhook',
      url,
      secretRef,
      ...(signatureHeader ? { signatureHeader } : {}),
      ...(version ? { version } : {}),
    };
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
