import { randomUUID } from 'node:crypto';

import {
  isAgentIdentityComponent,
  isCanonicalAgentIdentity,
  parseAgentIdentity,
} from '../identity/agent-id.js';
import { isRecord } from './utils.js';

export const A2A_ENVELOPE_INTENTS = [
  'chat',
  'handoff',
  'escalate',
  'ack',
  'policy.update',
] as const;
export const A2A_LOCAL_INSTANCE_ID = 'local';

export type A2AEnvelopeIntent = (typeof A2A_ENVELOPE_INTENTS)[number];
export type A2AAgentIdKind = 'local' | 'canonical';

interface NormalizedA2AAgentId {
  value: string;
  kind: A2AAgentIdKind | null;
  instanceId?: string;
}

export interface A2AEnvelope {
  id: string;
  sender_agent_id: string;
  recipient_agent_id: string;
  sender_instance_id?: string;
  source_instance_id?: string;
  target_instance_id?: string;
  thread_id: string;
  parent_message_id?: string;
  intent: A2AEnvelopeIntent;
  content: string;
  created_at: string;
  delegation_token?: string;
}

export type CreateA2AEnvelopeInput = Omit<A2AEnvelope, 'id' | 'created_at'> & {
  id?: string;
  created_at?: string;
};

export interface A2AEnvelopeAuditSummary {
  messageId: string | null;
  threadId: string | null;
  senderAgentId: string | null;
  recipientAgentId: string | null;
  senderInstanceId: string | null;
  sourceInstanceId: string | null;
  targetInstanceId: string | null;
  delegation: boolean;
}

export class A2AEnvelopeValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid A2A envelope: ${issues.join('; ')}`);
    this.name = 'A2AEnvelopeValidationError';
    this.issues = [...issues];
  }
}

export class A2AEnvelopeDuplicateError extends A2AEnvelopeValidationError {
  readonly envelopeId: string;
  readonly threadId: string;

  constructor(envelopeId: string, threadId: string) {
    const message = `A2A envelope ${envelopeId} already exists in thread ${threadId}.`;
    super([message]);
    this.name = 'A2AEnvelopeDuplicateError';
    this.message = message;
    this.envelopeId = envelopeId;
    this.threadId = threadId;
  }
}

const A2A_ENVELOPE_FIELDS = new Set([
  'id',
  'sender_agent_id',
  'recipient_agent_id',
  'sender_instance_id',
  'source_instance_id',
  'target_instance_id',
  'thread_id',
  'parent_message_id',
  'intent',
  'content',
  'created_at',
  'delegation_token',
]);

const LOCAL_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPAQUE_ID_DISALLOWED_PATTERN = /[\p{Cc}\s]/u;
const DELEGATION_TOKEN_MAX_LENGTH = 8192;

function readRequiredTrimmedString(
  record: Record<string, unknown>,
  field: keyof A2AEnvelope,
  issues: string[],
): string {
  const value = record[field];
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

function readOptionalTrimmedString(
  record: Record<string, unknown>,
  field: keyof A2AEnvelope,
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

function readContent(
  record: Record<string, unknown>,
  issues: string[],
): string {
  const value = record.content;
  if (typeof value !== 'string') {
    issues.push('content must be a string');
    return '';
  }
  return value;
}

export function isA2AEnvelopeIntent(value: string): value is A2AEnvelopeIntent {
  return A2A_ENVELOPE_INTENTS.includes(value as A2AEnvelopeIntent);
}

export function classifyA2AAgentId(value: string): A2AAgentIdKind | null {
  const normalized = value.trim();
  if (normalized.includes('@') && isCanonicalAgentIdentity(normalized)) {
    return 'canonical';
  }
  if (!normalized.includes('@') && LOCAL_AGENT_ID_PATTERN.test(normalized)) {
    return 'local';
  }
  return null;
}

function normalizeA2AAgentId(value: string): NormalizedA2AAgentId {
  const normalized = value.trim();
  if (normalized.includes('@') && isCanonicalAgentIdentity(normalized)) {
    const parsed = parseAgentIdentity(normalized);
    return {
      value: parsed.id,
      kind: 'canonical',
      instanceId: parsed.instanceId,
    };
  }
  if (!normalized.includes('@') && LOCAL_AGENT_ID_PATTERN.test(normalized)) {
    return { value: normalized, kind: 'local' };
  }
  return { value: normalized, kind: null };
}

function normalizeInstanceId(value: string): string {
  return value.trim().toLowerCase();
}

export function isA2AAgentId(value: string): boolean {
  return classifyA2AAgentId(value) !== null;
}

export function isA2AOpaqueId(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length > 0 && !OPAQUE_ID_DISALLOWED_PATTERN.test(normalized)
  );
}

function isA2AInstanceId(value: string): boolean {
  return isAgentIdentityComponent(value);
}

type A2AOpaqueIdField =
  | 'id'
  | 'thread_id'
  | 'parent_message_id'
  | 'delegation_token';

function validateOpaqueId(
  field: A2AOpaqueIdField,
  value: string | undefined,
  issues: string[],
  opts: { noun?: 'id' | 'token'; maxLength?: number } = {},
): void {
  if (value === undefined) return;
  const noun = opts.noun ?? 'id';
  if (!isA2AOpaqueId(value)) {
    issues.push(`${field} must be a non-empty ${noun} without whitespace`);
  }
  if (opts.maxLength !== undefined && value.length > opts.maxLength) {
    issues.push(`${field} must be at most ${opts.maxLength} characters`);
  }
}

function validateAgentId(
  field: 'sender_agent_id' | 'recipient_agent_id',
  value: string,
  kind: A2AAgentIdKind | null,
  issues: string[],
): void {
  if (!value) return;
  if (kind === null) {
    issues.push(
      `${field} must be a local agent id or canonical agent id (agent-slug@user@instance-id)`,
    );
  }
}

function validateInstanceId(
  field: 'sender_instance_id' | 'source_instance_id' | 'target_instance_id',
  value: string | undefined,
  issues: string[],
): void {
  if (value === undefined) return;
  if (!isA2AInstanceId(value)) {
    issues.push(`${field} must be a canonical instance id`);
  }
}

function requireCanonicalAgentIdForDelegation(
  field: 'sender_agent_id' | 'recipient_agent_id',
  kind: A2AAgentIdKind | null,
  issues: string[],
): void {
  if (kind === 'local') {
    issues.push(
      `${field} must be canonical when delegation fields are provided`,
    );
  }
}

function validateDelegationInstanceMatch(
  instanceField:
    | 'sender_instance_id'
    | 'source_instance_id'
    | 'target_instance_id',
  instanceId: string | undefined,
  agentField: 'sender_agent_id' | 'recipient_agent_id',
  agentInstanceId: string | undefined,
  issues: string[],
): void {
  if (instanceId === undefined) return;
  if (agentInstanceId && instanceId !== agentInstanceId) {
    issues.push(
      `${instanceField} must match the instance-id portion of ${agentField}`,
    );
  }
}

function validateDelegationFieldSet(
  sourceInstanceId: string | undefined,
  targetInstanceId: string | undefined,
  delegationToken: string | undefined,
  senderAgentKind: A2AAgentIdKind | null,
  recipientAgentKind: A2AAgentIdKind | null,
  issues: string[],
): void {
  const presentCount = [
    sourceInstanceId,
    targetInstanceId,
    delegationToken,
  ].filter((value) => value !== undefined).length;
  if (presentCount === 0) return;

  if (presentCount !== 3) {
    issues.push(
      'source_instance_id, target_instance_id, and delegation_token must be provided together',
    );
  }
  requireCanonicalAgentIdForDelegation(
    'sender_agent_id',
    senderAgentKind,
    issues,
  );
  requireCanonicalAgentIdForDelegation(
    'recipient_agent_id',
    recipientAgentKind,
    issues,
  );
}

function validateCreatedAt(value: string, issues: string[]): void {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    issues.push('created_at must be an ISO timestamp');
  }
}

function validateNoUnknownFields(
  record: Record<string, unknown>,
  issues: string[],
): void {
  for (const field of Object.keys(record)) {
    if (!A2A_ENVELOPE_FIELDS.has(field)) {
      issues.push(`unexpected field: ${field}`);
    }
  }
}

export function validateA2AEnvelope(value: unknown): A2AEnvelope {
  const issues: string[] = [];
  if (!isRecord(value)) {
    throw new A2AEnvelopeValidationError(['envelope must be an object']);
  }

  validateNoUnknownFields(value, issues);

  const id = readRequiredTrimmedString(value, 'id', issues);
  const senderAgentId = readRequiredTrimmedString(
    value,
    'sender_agent_id',
    issues,
  );
  const recipientAgentId = readRequiredTrimmedString(
    value,
    'recipient_agent_id',
    issues,
  );
  const rawSourceInstanceId = readOptionalTrimmedString(
    value,
    'source_instance_id',
    issues,
  );
  const rawTargetInstanceId = readOptionalTrimmedString(
    value,
    'target_instance_id',
    issues,
  );
  const rawSenderInstanceId = readOptionalTrimmedString(
    value,
    'sender_instance_id',
    issues,
  );
  const threadId = readRequiredTrimmedString(value, 'thread_id', issues);
  const parentMessageId = readOptionalTrimmedString(
    value,
    'parent_message_id',
    issues,
  );
  const intent = readRequiredTrimmedString(value, 'intent', issues);
  const content = readContent(value, issues);
  const createdAt = readRequiredTrimmedString(value, 'created_at', issues);
  const delegationToken = readOptionalTrimmedString(
    value,
    'delegation_token',
    issues,
  );
  const senderAgent = normalizeA2AAgentId(senderAgentId);
  const recipientAgent = normalizeA2AAgentId(recipientAgentId);
  const sourceInstanceId =
    rawSourceInstanceId === undefined
      ? undefined
      : normalizeInstanceId(rawSourceInstanceId);
  const targetInstanceId =
    rawTargetInstanceId === undefined
      ? undefined
      : normalizeInstanceId(rawTargetInstanceId);
  const explicitSenderInstanceId =
    rawSenderInstanceId === undefined
      ? undefined
      : normalizeInstanceId(rawSenderInstanceId);
  const senderInstanceId =
    explicitSenderInstanceId ??
    senderAgent.instanceId ??
    // Legacy local-only envelopes predate explicit federation metadata.
    (senderAgent.kind === 'local' ? A2A_LOCAL_INSTANCE_ID : undefined);

  validateOpaqueId('id', id, issues);
  validateOpaqueId('thread_id', threadId, issues);
  validateOpaqueId('parent_message_id', parentMessageId, issues);
  validateAgentId(
    'sender_agent_id',
    senderAgent.value,
    senderAgent.kind,
    issues,
  );
  validateAgentId(
    'recipient_agent_id',
    recipientAgent.value,
    recipientAgent.kind,
    issues,
  );
  validateInstanceId('source_instance_id', sourceInstanceId, issues);
  validateInstanceId('target_instance_id', targetInstanceId, issues);
  validateInstanceId('sender_instance_id', senderInstanceId, issues);
  validateOpaqueId('delegation_token', delegationToken, issues, {
    noun: 'token',
    maxLength: DELEGATION_TOKEN_MAX_LENGTH,
  });
  validateDelegationFieldSet(
    sourceInstanceId,
    targetInstanceId,
    delegationToken,
    senderAgent.kind,
    recipientAgent.kind,
    issues,
  );
  validateDelegationInstanceMatch(
    'sender_instance_id',
    senderInstanceId,
    'sender_agent_id',
    senderAgent.instanceId,
    issues,
  );
  validateDelegationInstanceMatch(
    'source_instance_id',
    sourceInstanceId,
    'sender_agent_id',
    senderAgent.instanceId,
    issues,
  );
  if (
    sourceInstanceId !== undefined &&
    senderInstanceId !== undefined &&
    sourceInstanceId !== senderInstanceId
  ) {
    issues.push('source_instance_id must match sender_instance_id');
  }
  validateDelegationInstanceMatch(
    'target_instance_id',
    targetInstanceId,
    'recipient_agent_id',
    recipientAgent.instanceId,
    issues,
  );
  if (!isA2AEnvelopeIntent(intent)) {
    issues.push(`intent must be one of: ${A2A_ENVELOPE_INTENTS.join(', ')}`);
  }
  validateCreatedAt(createdAt, issues);

  if (issues.length > 0) {
    throw new A2AEnvelopeValidationError(issues);
  }

  const envelope: A2AEnvelope = {
    id,
    sender_agent_id: senderAgent.value,
    recipient_agent_id: recipientAgent.value,
    thread_id: threadId,
    intent: intent as A2AEnvelopeIntent,
    content,
    created_at: createdAt,
  };
  if (senderInstanceId) envelope.sender_instance_id = senderInstanceId;
  if (sourceInstanceId) envelope.source_instance_id = sourceInstanceId;
  if (targetInstanceId) envelope.target_instance_id = targetInstanceId;
  if (parentMessageId) envelope.parent_message_id = parentMessageId;
  if (delegationToken) envelope.delegation_token = delegationToken;
  return envelope;
}

export function createA2AEnvelope(input: CreateA2AEnvelopeInput): A2AEnvelope {
  return validateA2AEnvelope({
    ...input,
    id: input.id ?? randomUUID(),
    created_at: input.created_at ?? new Date().toISOString(),
  });
}

export function parseA2AEnvelopeJson(raw: string): A2AEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new A2AEnvelopeValidationError([
      error instanceof Error ? error.message : 'invalid JSON',
    ]);
  }
  return validateA2AEnvelope(parsed);
}

export function serializeA2AEnvelope(envelope: A2AEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function summarizeA2AEnvelopeForAudit(
  envelope: A2AEnvelope,
): A2AEnvelopeAuditSummary {
  return {
    messageId: envelope.id,
    threadId: envelope.thread_id,
    senderAgentId: envelope.sender_agent_id,
    recipientAgentId: envelope.recipient_agent_id,
    senderInstanceId: envelope.sender_instance_id ?? null,
    sourceInstanceId: envelope.source_instance_id ?? null,
    targetInstanceId: envelope.target_instance_id ?? null,
    delegation: Boolean(envelope.delegation_token),
  };
}
