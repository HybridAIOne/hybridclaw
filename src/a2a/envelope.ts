import { randomUUID } from 'node:crypto';
import { isRecord } from './utils.js';

export const A2A_ENVELOPE_INTENTS = [
  'chat',
  'handoff',
  'escalate',
  'ack',
] as const;

export type A2AEnvelopeIntent = (typeof A2A_ENVELOPE_INTENTS)[number];
export type A2AAgentIdKind = 'local' | 'canonical';

export interface A2AEnvelope {
  id: string;
  sender_agent_id: string;
  recipient_agent_id: string;
  thread_id: string;
  parent_message_id?: string;
  intent: A2AEnvelopeIntent;
  content: string;
  created_at: string;
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
  'thread_id',
  'parent_message_id',
  'intent',
  'content',
  'created_at',
]);

const LOCAL_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CANONICAL_AGENT_ID_PATTERN =
  /^[a-z0-9][a-z0-9._-]{0,127}@[a-z0-9][a-z0-9._-]{0,127}@[a-z0-9][a-z0-9._-]{0,127}$/;
const OPAQUE_ID_DISALLOWED_PATTERN = /[\p{Cc}\s]/u;

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
  if (
    normalized.includes('@') &&
    CANONICAL_AGENT_ID_PATTERN.test(normalized.toLowerCase())
  ) {
    return 'canonical';
  }
  if (!normalized.includes('@') && LOCAL_AGENT_ID_PATTERN.test(normalized)) {
    return 'local';
  }
  return null;
}

function normalizeAgentId(value: string): string {
  return classifyA2AAgentId(value) === 'canonical'
    ? value.trim().toLowerCase()
    : value;
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

function validateOpaqueId(
  field: 'id' | 'thread_id' | 'parent_message_id',
  value: string | undefined,
  issues: string[],
): void {
  if (value === undefined) return;
  if (!isA2AOpaqueId(value)) {
    issues.push(`${field} must be a non-empty id without whitespace`);
  }
}

function validateAgentId(
  field: 'sender_agent_id' | 'recipient_agent_id',
  value: string,
  issues: string[],
): void {
  if (!isA2AAgentId(value)) {
    issues.push(
      `${field} must be a local agent id or canonical agent id (agent-slug@user@instance-id)`,
    );
  }
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
  const threadId = readRequiredTrimmedString(value, 'thread_id', issues);
  const parentMessageId = readOptionalTrimmedString(
    value,
    'parent_message_id',
    issues,
  );
  const intent = readRequiredTrimmedString(value, 'intent', issues);
  const content = readContent(value, issues);
  const createdAt = readRequiredTrimmedString(value, 'created_at', issues);
  const normalizedSenderAgentId = normalizeAgentId(senderAgentId);
  const normalizedRecipientAgentId = normalizeAgentId(recipientAgentId);

  validateOpaqueId('id', id, issues);
  validateOpaqueId('thread_id', threadId, issues);
  validateOpaqueId('parent_message_id', parentMessageId, issues);
  validateAgentId('sender_agent_id', normalizedSenderAgentId, issues);
  validateAgentId('recipient_agent_id', normalizedRecipientAgentId, issues);
  if (!isA2AEnvelopeIntent(intent)) {
    issues.push(`intent must be one of: ${A2A_ENVELOPE_INTENTS.join(', ')}`);
  }
  validateCreatedAt(createdAt, issues);

  if (issues.length > 0) {
    throw new A2AEnvelopeValidationError(issues);
  }

  return {
    id,
    sender_agent_id: normalizedSenderAgentId,
    recipient_agent_id: normalizedRecipientAgentId,
    thread_id: threadId,
    ...(parentMessageId ? { parent_message_id: parentMessageId } : {}),
    intent: intent as A2AEnvelopeIntent,
    content,
    created_at: createdAt,
  };
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
  };
}
