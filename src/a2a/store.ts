import path from 'node:path';
import {
  getRuntimeAssetRevisionState,
  listRuntimeAssetRevisionStates,
  type RuntimeConfigChangeMeta,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import {
  type A2AEnvelope,
  A2AEnvelopeDuplicateError,
  A2AEnvelopeValidationError,
  isA2AOpaqueId,
  validateA2AEnvelope,
} from './envelope.js';
import { resolveA2AAgentId, resolveA2AEnvelopeAgentIds } from './identity.js';
import { isRecord } from './utils.js';

const A2A_THREAD_STATE_VERSION = 1;

interface A2AThreadState {
  version: typeof A2A_THREAD_STATE_VERSION;
  thread_id: string;
  envelopes: A2AEnvelope[];
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

  const rawEnvelopes = parsed.envelopes;
  if (!Array.isArray(rawEnvelopes)) {
    issues.push('thread state envelopes must be an array');
  }

  const envelopes: A2AEnvelope[] = [];
  const seenEnvelopeIds = new Set<string>();
  if (Array.isArray(rawEnvelopes)) {
    rawEnvelopes.forEach((entry, index) => {
      try {
        const envelope = validateA2AEnvelope(entry);
        if (envelope.thread_id !== expectedThreadId) {
          issues.push(`envelopes[${index}] belongs to ${envelope.thread_id}`);
        }
        if (seenEnvelopeIds.has(envelope.id)) {
          issues.push(`duplicate envelope id: ${envelope.id}`);
        }
        seenEnvelopeIds.add(envelope.id);
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

  if (issues.length > 0) {
    throw new A2AEnvelopeValidationError(issues);
  }

  return {
    version: A2A_THREAD_STATE_VERSION,
    thread_id: expectedThreadId,
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
    const createdAtOrder = left.created_at.localeCompare(right.created_at);
    if (createdAtOrder !== 0) return createdAtOrder;
    return left.id.localeCompare(right.id);
  });
}

export function getA2AEnvelope(
  threadId: string,
  envelopeId: string,
): A2AEnvelope | null {
  const normalizedEnvelopeId = normalizeEnvelopeId(envelopeId);
  const envelope = readThreadState(threadId).envelopes.find(
    (entry) => entry.id === normalizedEnvelopeId,
  );
  return envelope ?? null;
}

export function saveA2AEnvelope(
  envelope: unknown,
  meta?: RuntimeConfigChangeMeta,
): A2AEnvelope {
  const normalizedEnvelope = resolveA2AEnvelopeAgentIds(envelope);
  const state = readThreadState(normalizedEnvelope.thread_id);
  if (state.envelopes.some((entry) => entry.id === normalizedEnvelope.id)) {
    throw new A2AEnvelopeDuplicateError(
      normalizedEnvelope.id,
      normalizedEnvelope.thread_id,
    );
  }

  const nextState: A2AThreadState = {
    ...state,
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
