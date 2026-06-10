import path from 'node:path';
import {
  getRuntimeAssetRevisionState,
  listRuntimeAssetRevisionStates,
  type RuntimeConfigChangeMeta,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { isAgentIdentityComponent } from '../identity/agent-id.js';
import {
  type A2AEnvelope,
  A2AEnvelopeDuplicateError,
  A2AEnvelopeValidationError,
  classifyA2AAgentId,
  isA2AOpaqueId,
  validateA2AEnvelope,
} from './envelope.js';
import { resolveA2AAgentId, resolveA2AEnvelopeAgentIds } from './identity.js';
import { isRecord } from './utils.js';

const A2A_THREAD_STATE_VERSION = 1;

interface A2AThreadState {
  version: typeof A2A_THREAD_STATE_VERSION;
  thread_id: string;
  owner_coworker_id: string | null;
  envelopes: A2AEnvelope[];
}

export interface A2AThreadSummary {
  thread_id: string;
  owner_coworker_id: string | null;
  message_count: number;
  participants: string[];
  latest_message_id: string | null;
  latest_parent_message_id: string | null;
  latest_sender_agent_id: string | null;
  latest_recipient_agent_id: string | null;
  latest_intent: A2AEnvelope['intent'] | null;
  latest_content: string | null;
  latest_created_at: string | null;
}

function normalizeOpaqueId(value: string, field: string): string {
  const normalized = value.trim();
  if (!isA2AOpaqueId(normalized)) {
    throw new A2AEnvelopeValidationError([
      `${field} must be a non-empty id without whitespace`,
    ]);
  }
  return normalized;
}

function normalizeThreadId(threadId: string): string {
  return normalizeOpaqueId(threadId, 'thread_id');
}

function normalizeEnvelopeId(envelopeId: string): string {
  return normalizeOpaqueId(envelopeId, 'id');
}

function normalizeSenderInstanceId(senderInstanceId: string): string {
  const normalized = senderInstanceId.trim().toLowerCase();
  if (!isAgentIdentityComponent(normalized)) {
    throw new A2AEnvelopeValidationError([
      'sender_instance_id must be a canonical instance id',
    ]);
  }
  return normalized;
}

function a2aEnvelopeIdempotencyKey(envelope: A2AEnvelope): string {
  return `${envelope.id}\u0000${envelope.sender_instance_id ?? ''}`;
}

function compareA2AEnvelopes(left: A2AEnvelope, right: A2AEnvelope): number {
  const createdAtOrder = left.created_at.localeCompare(right.created_at);
  if (createdAtOrder !== 0) return createdAtOrder;
  return left.id.localeCompare(right.id);
}

function normalizeThreadOwnerCoworkerId(value: string, field: string): string {
  const normalized = value.trim();
  const kind = classifyA2AAgentId(normalized);
  if (kind === 'canonical') return normalized.toLowerCase();
  if (kind === 'local') return resolveA2AAgentId(normalized);
  throw new A2AEnvelopeValidationError([
    `${field} must be a local agent id or canonical agent id (agent-slug@user@instance-id)`,
  ]);
}

function tryNormalizeThreadOwnerCoworkerId(
  value: string,
  field: string,
  issues: string[],
): string | null {
  try {
    return normalizeThreadOwnerCoworkerId(value, field);
  } catch (error) {
    if (error instanceof A2AEnvelopeValidationError) {
      issues.push(...error.issues);
      return null;
    }
    throw error;
  }
}

function latestHandoffEnvelope(
  envelopes: readonly A2AEnvelope[],
): A2AEnvelope | null {
  let latestHandoff: A2AEnvelope | null = null;
  for (const envelope of envelopes) {
    if (
      envelope.intent === 'handoff' &&
      (!latestHandoff || compareA2AEnvelopes(envelope, latestHandoff) > 0)
    ) {
      latestHandoff = envelope;
    }
  }
  return latestHandoff;
}

function compareThreadSummariesByRecency(
  left: A2AThreadSummary,
  right: A2AThreadSummary,
): number {
  const recencyOrder = (right.latest_created_at ?? '').localeCompare(
    left.latest_created_at ?? '',
  );
  if (recencyOrder !== 0) return recencyOrder;
  return left.thread_id.localeCompare(right.thread_id);
}

export function a2aThreadAssetPath(threadId: string): string {
  const normalizedThreadId = normalizeThreadId(threadId);
  return path.join(
    DEFAULT_RUNTIME_HOME_DIR,
    'a2a',
    'threads',
    `${encodeURIComponent(normalizedThreadId)}.json`,
  );
}

function emptyThreadState(threadId: string): A2AThreadState {
  return {
    version: A2A_THREAD_STATE_VERSION,
    thread_id: threadId,
    owner_coworker_id: null,
    envelopes: [],
  };
}

function parsePersistedThreadState(
  raw: string,
  expectedThreadId: string,
): A2AThreadState {
  const issues: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new A2AEnvelopeValidationError([
      `thread state JSON is invalid: ${
        error instanceof Error ? error.message : 'unknown parse error'
      }`,
    ]);
  }

  if (!isRecord(parsed)) {
    throw new A2AEnvelopeValidationError([
      'thread state must be a JSON object',
    ]);
  }

  if (parsed.version !== A2A_THREAD_STATE_VERSION) {
    issues.push(`thread state version must be ${A2A_THREAD_STATE_VERSION}`);
  }

  const threadId =
    typeof parsed.thread_id === 'string' ? parsed.thread_id.trim() : '';
  if (threadId !== expectedThreadId) {
    issues.push(`thread state is for ${threadId || '<missing>'}`);
  }

  let ownerCoworkerId: string | null = null;
  if (
    Object.hasOwn(parsed, 'owner_coworker_id') &&
    parsed.owner_coworker_id !== null
  ) {
    if (typeof parsed.owner_coworker_id !== 'string') {
      issues.push('owner_coworker_id must be a string or null');
    } else {
      ownerCoworkerId = tryNormalizeThreadOwnerCoworkerId(
        parsed.owner_coworker_id,
        'owner_coworker_id',
        issues,
      );
    }
  }

  const rawEnvelopes = parsed.envelopes;
  if (!Array.isArray(rawEnvelopes)) {
    issues.push('thread state envelopes must be an array');
  }

  const envelopes: A2AEnvelope[] = [];
  const seenEnvelopeKeys = new Set<string>();
  if (Array.isArray(rawEnvelopes)) {
    rawEnvelopes.forEach((entry, index) => {
      try {
        const envelope = validateA2AEnvelope(entry);
        const idempotencyKey = a2aEnvelopeIdempotencyKey(envelope);
        if (envelope.thread_id !== expectedThreadId) {
          issues.push(`envelopes[${index}] belongs to ${envelope.thread_id}`);
        }
        if (seenEnvelopeKeys.has(idempotencyKey)) {
          issues.push(
            `duplicate envelope id/sender_instance_id: ${envelope.id}`,
          );
        }
        seenEnvelopeKeys.add(idempotencyKey);
        envelopes.push(envelope);
      } catch (error) {
        if (error instanceof A2AEnvelopeValidationError) {
          issues.push(
            ...error.issues.map((issue) => `envelopes[${index}]: ${issue}`),
          );
          return;
        }
        issues.push(
          `envelopes[${index}]: ${
            error instanceof Error ? error.message : 'invalid envelope'
          }`,
        );
      }
    });
  }

  if (ownerCoworkerId === null && envelopes.length > 0) {
    const latestHandoff = latestHandoffEnvelope(envelopes);
    if (latestHandoff) {
      ownerCoworkerId = tryNormalizeThreadOwnerCoworkerId(
        latestHandoff.recipient_agent_id,
        'handoff recipient_agent_id',
        issues,
      );
    }
  }

  if (issues.length > 0) {
    throw new A2AEnvelopeValidationError(issues);
  }

  return {
    version: A2A_THREAD_STATE_VERSION,
    thread_id: expectedThreadId,
    owner_coworker_id: ownerCoworkerId,
    envelopes,
  };
}

function readThreadState(threadId: string): A2AThreadState {
  const normalizedThreadId = normalizeThreadId(threadId);
  const state = getRuntimeAssetRevisionState(
    'a2a',
    a2aThreadAssetPath(normalizedThreadId),
  );
  if (!state) return emptyThreadState(normalizedThreadId);
  return parsePersistedThreadState(state.content, normalizedThreadId);
}

function serializeThreadState(state: A2AThreadState): string {
  return JSON.stringify(state);
}

export function listA2AThreadEnvelopes(threadId: string): A2AEnvelope[] {
  return readThreadState(threadId).envelopes;
}

function summarizeThreadState(state: A2AThreadState): A2AThreadSummary {
  const orderedEnvelopes = [...state.envelopes].sort(compareA2AEnvelopes);
  const latest = orderedEnvelopes.at(-1) ?? null;
  const participants = new Set<string>();
  for (const envelope of orderedEnvelopes) {
    participants.add(envelope.sender_agent_id);
    participants.add(envelope.recipient_agent_id);
  }

  return {
    thread_id: state.thread_id,
    owner_coworker_id: state.owner_coworker_id,
    message_count: state.envelopes.length,
    participants: [...participants].sort(),
    latest_message_id: latest?.id ?? null,
    latest_parent_message_id: latest?.parent_message_id ?? null,
    latest_sender_agent_id: latest?.sender_agent_id ?? null,
    latest_recipient_agent_id: latest?.recipient_agent_id ?? null,
    latest_intent: latest?.intent ?? null,
    latest_content: latest?.content ?? null,
    latest_created_at: latest?.created_at ?? null,
  };
}

function threadIdFromAssetPath(assetPath: string): string | null {
  const threadsDir = path.join(DEFAULT_RUNTIME_HOME_DIR, 'a2a', 'threads');
  const relativePath = path.relative(threadsDir, assetPath);
  if (
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath) ||
    path.dirname(relativePath) !== '.' ||
    path.extname(relativePath) !== '.json'
  ) {
    return null;
  }

  try {
    return normalizeThreadId(
      decodeURIComponent(path.basename(relativePath, '.json')),
    );
  } catch (error) {
    if (error instanceof URIError) {
      throw new A2AEnvelopeValidationError([
        `thread asset path is not URI-decodable: ${assetPath}`,
      ]);
    }
    throw error;
  }
}

export function listA2AThreads(): A2AThreadSummary[] {
  const threads: A2AThreadSummary[] = [];
  for (const state of listRuntimeAssetRevisionStates('a2a')) {
    const threadId = threadIdFromAssetPath(state.assetPath);
    if (!threadId) continue;
    threads.push(
      summarizeThreadState(parsePersistedThreadState(state.content, threadId)),
    );
  }

  return threads.sort(compareThreadSummariesByRecency);
}

export function listA2AInboxThreads(agentId: string): A2AThreadSummary[] {
  const recipientAgentId = resolveA2AAgentId(agentId);
  const threads: A2AThreadSummary[] = [];
  for (const revisionState of listRuntimeAssetRevisionStates('a2a')) {
    const threadId = threadIdFromAssetPath(revisionState.assetPath);
    if (!threadId) continue;
    const threadState = parsePersistedThreadState(
      revisionState.content,
      threadId,
    );
    if (
      threadState.owner_coworker_id !== recipientAgentId &&
      !threadState.envelopes.some(
        (envelope) => envelope.recipient_agent_id === recipientAgentId,
      )
    ) {
      continue;
    }
    threads.push(summarizeThreadState(threadState));
  }

  return threads.sort(compareThreadSummariesByRecency);
}

export function listA2AInboxEnvelopes(agentId: string): A2AEnvelope[] {
  const recipientAgentId = resolveA2AAgentId(agentId);
  const envelopes: A2AEnvelope[] = [];
  for (const state of listRuntimeAssetRevisionStates('a2a')) {
    const threadId = threadIdFromAssetPath(state.assetPath);
    if (!threadId) continue;
    for (const envelope of parsePersistedThreadState(state.content, threadId)
      .envelopes) {
      if (envelope.recipient_agent_id === recipientAgentId) {
        envelopes.push(envelope);
      }
    }
  }

  return envelopes.sort((left, right) => {
    return compareA2AEnvelopes(left, right);
  });
}

/**
 * Looks up a persisted envelope by the federation idempotency tuple.
 * Callers may omit senderInstanceId only when the envelope id is unique
 * within the thread; ambiguous federated ids fail fast.
 */
export function getA2AEnvelope(
  threadId: string,
  envelopeId: string,
  senderInstanceId?: string,
): A2AEnvelope | null {
  const normalizedEnvelopeId = normalizeEnvelopeId(envelopeId);
  const normalizedSenderInstanceId =
    senderInstanceId === undefined
      ? undefined
      : normalizeSenderInstanceId(senderInstanceId);
  const matches = readThreadState(threadId).envelopes.filter(
    (entry) => entry.id === normalizedEnvelopeId,
  );
  if (normalizedSenderInstanceId !== undefined) {
    return (
      matches.find(
        (entry) => entry.sender_instance_id === normalizedSenderInstanceId,
      ) ?? null
    );
  }
  if (matches.length > 1) {
    throw new A2AEnvelopeValidationError([
      `envelope id ${normalizedEnvelopeId} is ambiguous; provide sender_instance_id`,
    ]);
  }
  return matches[0] ?? null;
}

export function saveA2AEnvelope(
  envelope: unknown,
  meta?: RuntimeConfigChangeMeta,
): A2AEnvelope {
  const normalizedEnvelope = resolveA2AEnvelopeAgentIds(envelope);
  const state = readThreadState(normalizedEnvelope.thread_id);
  if (
    state.envelopes.some(
      (entry) =>
        a2aEnvelopeIdempotencyKey(entry) ===
        a2aEnvelopeIdempotencyKey(normalizedEnvelope),
    )
  ) {
    throw new A2AEnvelopeDuplicateError(
      normalizedEnvelope.id,
      normalizedEnvelope.thread_id,
    );
  }

  const nextState: A2AThreadState = {
    ...state,
    owner_coworker_id:
      normalizedEnvelope.intent === 'handoff'
        ? normalizedEnvelope.recipient_agent_id
        : state.owner_coworker_id,
    envelopes: [...state.envelopes, normalizedEnvelope],
  };
  syncRuntimeAssetRevisionState(
    'a2a',
    a2aThreadAssetPath(normalizedEnvelope.thread_id),
    meta,
    {
      exists: true,
      content: serializeThreadState(nextState),
    },
  );
  return normalizedEnvelope;
}
