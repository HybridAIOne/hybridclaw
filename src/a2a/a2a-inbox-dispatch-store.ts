import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  getRuntimeAssetRevisionState,
  listRuntimeAssetRevisionStates,
  type RuntimeConfigChangeMeta,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { logger } from '../logger.js';
import { type A2AEnvelope, validateA2AEnvelope } from './envelope.js';
import { isRecord, normalizePositiveInteger } from './utils.js';

const A2A_INBOX_DISPATCH_SCHEMA_VERSION = 1;
export const A2A_INBOX_DISPATCH_DEFAULT_MAX_ATTEMPTS = 3;

const A2A_INBOX_DISPATCH_ASSET_PREFIX = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'a2a',
  'inbox-dispatch',
);

export type A2AInboxDispatchStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'ignored'
  | 'suppressed';

export interface A2AInboxDispatchItem {
  schemaVersion: typeof A2A_INBOX_DISPATCH_SCHEMA_VERSION;
  id: string;
  status: A2AInboxDispatchStatus;
  envelope: A2AEnvelope;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  actor?: string;
  source?: string;
  sessionId?: string;
  runId?: string;
  dispatchSessionId?: string;
  dispatchRunId?: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  ignoredAt?: string;
  suppressedAt?: string;
  lastError?: string;
}

export interface A2AInboxDispatchListOptions {
  status?: A2AInboxDispatchStatus | readonly A2AInboxDispatchStatus[];
  threadId?: string;
}

export interface A2AInboxDispatchEnqueueOptions {
  actor?: string;
  source?: string;
  sessionId?: string;
  runId?: string;
  maxAttempts?: number;
  now?: Date;
}

export function a2aInboxDispatchId(envelope: A2AEnvelope): string {
  const normalized = validateA2AEnvelope(envelope);
  return createHash('sha256')
    .update(normalized.thread_id)
    .update('\0')
    .update(normalized.id)
    .update('\0')
    .update(normalized.sender_instance_id ?? '')
    .digest('hex');
}

function dispatchAssetPath(id: string): string {
  return path.join(A2A_INBOX_DISPATCH_ASSET_PREFIX, `${id}.json`);
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function isA2AInboxDispatchStatus(
  value: unknown,
): value is A2AInboxDispatchStatus {
  return (
    value === 'pending' ||
    value === 'running' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'ignored' ||
    value === 'suppressed'
  );
}

function optionalString(
  record: Record<string, unknown>,
  field: keyof A2AInboxDispatchItem,
): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseDispatchItem(
  raw: string,
  assetPath: string,
): A2AInboxDispatchItem | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.schemaVersion !== A2A_INBOX_DISPATCH_SCHEMA_VERSION) {
      return null;
    }
    if (typeof parsed.id !== 'string' || !parsed.id.trim()) return null;
    if (!isA2AInboxDispatchStatus(parsed.status)) return null;
    const envelope = validateA2AEnvelope(parsed.envelope);
    const attempts =
      typeof parsed.attempts === 'number' &&
      Number.isSafeInteger(parsed.attempts) &&
      parsed.attempts >= 0
        ? parsed.attempts
        : 0;
    const maxAttempts = normalizePositiveInteger(
      parsed.maxAttempts,
      A2A_INBOX_DISPATCH_DEFAULT_MAX_ATTEMPTS,
    );
    const nextAttemptAt =
      typeof parsed.nextAttemptAt === 'string' && parsed.nextAttemptAt.trim()
        ? parsed.nextAttemptAt
        : new Date(0).toISOString();
    const createdAt =
      typeof parsed.createdAt === 'string' && parsed.createdAt.trim()
        ? parsed.createdAt
        : nextAttemptAt;
    const updatedAt =
      typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim()
        ? parsed.updatedAt
        : createdAt;
    const actor = optionalString(parsed, 'actor');
    const source = optionalString(parsed, 'source');
    const sessionId = optionalString(parsed, 'sessionId');
    const runId = optionalString(parsed, 'runId');
    const dispatchSessionId = optionalString(parsed, 'dispatchSessionId');
    const dispatchRunId = optionalString(parsed, 'dispatchRunId');
    const startedAt = optionalString(parsed, 'startedAt');
    const completedAt = optionalString(parsed, 'completedAt');
    const failedAt = optionalString(parsed, 'failedAt');
    const ignoredAt = optionalString(parsed, 'ignoredAt');
    const suppressedAt = optionalString(parsed, 'suppressedAt');
    const lastError = optionalString(parsed, 'lastError');

    return {
      schemaVersion: A2A_INBOX_DISPATCH_SCHEMA_VERSION,
      id: parsed.id,
      status: parsed.status,
      envelope,
      attempts,
      maxAttempts,
      nextAttemptAt,
      createdAt,
      updatedAt,
      ...(actor ? { actor } : {}),
      ...(source ? { source } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      ...(dispatchSessionId ? { dispatchSessionId } : {}),
      ...(dispatchRunId ? { dispatchRunId } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(failedAt ? { failedAt } : {}),
      ...(ignoredAt ? { ignoredAt } : {}),
      ...(suppressedAt ? { suppressedAt } : {}),
      ...(lastError ? { lastError } : {}),
    };
  } catch (error) {
    logger.warn(
      { assetPath, err: error },
      'Dropped invalid A2A inbox dispatch item',
    );
    return null;
  }
}

function matchesStatus(
  item: A2AInboxDispatchItem,
  status: A2AInboxDispatchListOptions['status'],
): boolean {
  if (!status) return true;
  if (Array.isArray(status)) return status.includes(item.status);
  return item.status === status;
}

function persistMeta(): RuntimeConfigChangeMeta {
  return {
    route: 'a2a.inbox.dispatch',
    source: 'a2a-inbox-dispatch',
  };
}

export function persistA2AInboxDispatchItem(item: A2AInboxDispatchItem): void {
  syncRuntimeAssetRevisionState(
    'a2a',
    dispatchAssetPath(item.id),
    persistMeta(),
    {
      exists: true,
      content: JSON.stringify(item),
    },
  );
}

export function getA2AInboxDispatchItem(
  id: string,
): A2AInboxDispatchItem | null {
  const state = getRuntimeAssetRevisionState('a2a', dispatchAssetPath(id));
  return state ? parseDispatchItem(state.content, dispatchAssetPath(id)) : null;
}

export function getA2AInboxDispatchItemForEnvelope(
  envelope: A2AEnvelope,
): A2AInboxDispatchItem | null {
  return getA2AInboxDispatchItem(a2aInboxDispatchId(envelope));
}

export function listA2AInboxDispatchItems(
  options: A2AInboxDispatchListOptions = {},
): A2AInboxDispatchItem[] {
  return listRuntimeAssetRevisionStates('a2a', {
    assetPathPrefix: A2A_INBOX_DISPATCH_ASSET_PREFIX,
  })
    .map((state) => parseDispatchItem(state.content, state.assetPath))
    .filter(
      (item): item is A2AInboxDispatchItem =>
        item !== null &&
        matchesStatus(item, options.status) &&
        (!options.threadId || item.envelope.thread_id === options.threadId),
    )
    .sort((left, right) => {
      const nextAttemptOrder = left.nextAttemptAt.localeCompare(
        right.nextAttemptAt,
      );
      if (nextAttemptOrder !== 0) return nextAttemptOrder;
      return left.id.localeCompare(right.id);
    });
}

export function enqueueA2AInboxDispatch(
  envelope: A2AEnvelope,
  options: A2AInboxDispatchEnqueueOptions = {},
): A2AInboxDispatchItem {
  const normalizedEnvelope = validateA2AEnvelope(envelope);
  const id = a2aInboxDispatchId(normalizedEnvelope);
  const existing = getA2AInboxDispatchItem(id);
  if (existing) return existing;

  const now = options.now ?? new Date();
  const timestamp = nowIso(now);
  const item: A2AInboxDispatchItem = {
    schemaVersion: A2A_INBOX_DISPATCH_SCHEMA_VERSION,
    id,
    status: 'pending',
    envelope: normalizedEnvelope,
    attempts: 0,
    maxAttempts: normalizePositiveInteger(
      options.maxAttempts,
      A2A_INBOX_DISPATCH_DEFAULT_MAX_ATTEMPTS,
    ),
    nextAttemptAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
  };
  persistA2AInboxDispatchItem(item);
  return item;
}
