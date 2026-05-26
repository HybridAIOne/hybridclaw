import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  listRuntimeAssetRevisionStates,
  syncRuntimeAssetRevisionState,
} from '../config/runtime-config-revisions.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { logger } from '../logger.js';
import type { SecretRef } from '../security/secret-refs.js';
import type { EscalationTarget } from '../types/execution.js';
import { type A2AEnvelope, validateA2AEnvelope } from './envelope.js';
import type { A2APeerDescriptor } from './peer-descriptor.js';
import type { TransportAdapterContext } from './transport-registry.js';
import { normalizePositiveInteger } from './utils.js';

export const A2A_RETRY_MAX_ATTEMPTS = 8;
const A2A_OUTBOX_SCHEMA_VERSION = 1;
const A2A_OUTBOX_ASSET_PREFIX = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'a2a',
  'outbox',
  'a2a',
);

export type A2AOutboundStatus = 'pending' | 'delivered' | 'failed';

export type A2AOutboxIdentityResolution =
  | {
      status: 'unresolved';
      canonicalId: string;
    }
  | {
      status: 'resolved';
      canonicalId: string;
      url: string;
      publicKey: string;
      resolvedAt: string;
    };

export interface A2AOutboxItem {
  schemaVersion: typeof A2A_OUTBOX_SCHEMA_VERSION;
  id: string;
  status: A2AOutboundStatus;
  envelope: A2AEnvelope;
  agentCardUrl?: string;
  identityResolution?: A2AOutboxIdentityResolution;
  bearerTokenRef?: SecretRef;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  runId?: string;
  escalationTarget?: EscalationTarget;
  lastAttemptAt?: string;
  deliveredAt?: string;
  failedAt?: string;
  lastError?: string;
  lastStatusCode?: number;
  lastJsonRpcCode?: number;
}

export interface A2AOutboxListOptions {
  status?: A2AOutboundStatus | readonly A2AOutboundStatus[];
}

export interface A2AOutboundAdapterOptions {
  maxAttempts?: number;
}

export function nowIso(now: Date): string {
  return now.toISOString();
}

function outboxAssetPath(id: string): string {
  return path.join(A2A_OUTBOX_ASSET_PREFIX, `${id}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeIdentityResolution(
  value: unknown,
): A2AOutboxIdentityResolution | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.canonicalId !== 'string') {
    throw new Error('identityResolution must include canonicalId');
  }
  const canonicalId = value.canonicalId.trim();
  if (!canonicalId) {
    throw new Error('identityResolution canonicalId is required');
  }
  if (value.status === 'resolved') {
    if (
      typeof value.url !== 'string' ||
      typeof value.publicKey !== 'string' ||
      typeof value.resolvedAt !== 'string'
    ) {
      throw new Error(
        'resolved identityResolution must include url, publicKey, and resolvedAt',
      );
    }
    return {
      status: 'resolved',
      canonicalId,
      url: value.url,
      publicKey: value.publicKey,
      resolvedAt: value.resolvedAt,
    };
  }
  if (value.status === 'unresolved') {
    return { status: 'unresolved', canonicalId };
  }
  if (
    value.status === undefined &&
    typeof value.url !== 'string' &&
    typeof value.publicKey !== 'string' &&
    typeof value.resolvedAt !== 'string'
  ) {
    return { status: 'unresolved', canonicalId };
  }
  throw new Error('identityResolution status must be unresolved or resolved');
}

function parseOutboxItem(raw: string, assetPath: string): A2AOutboxItem | null {
  try {
    const parsed = JSON.parse(raw) as A2AOutboxItem;
    if (parsed.schemaVersion !== A2A_OUTBOX_SCHEMA_VERSION) return null;
    validateA2AEnvelope(parsed.envelope);
    if (
      parsed.status !== 'pending' &&
      parsed.status !== 'delivered' &&
      parsed.status !== 'failed'
    ) {
      return null;
    }
    const identityResolution = normalizeIdentityResolution(
      parsed.identityResolution,
    );
    return {
      ...parsed,
      ...(identityResolution ? { identityResolution } : {}),
    };
  } catch (error) {
    logger.warn(
      { assetPath, err: error },
      'Dropped invalid A2A outbound outbox item',
    );
    return null;
  }
}

function matchesOutboxListStatus(
  item: A2AOutboxItem,
  status: A2AOutboxListOptions['status'],
): boolean {
  if (!status) return true;
  if (Array.isArray(status)) return status.includes(item.status);
  return item.status === status;
}

export function persistA2AOutboxItem(item: A2AOutboxItem): void {
  syncRuntimeAssetRevisionState(
    'a2a',
    outboxAssetPath(item.id),
    {
      route: 'a2a.outbound.outbox',
      source: 'a2a-outbound',
    },
    {
      exists: true,
      content: JSON.stringify(item),
    },
  );
}

export function listA2AOutboxItems(
  options: A2AOutboxListOptions = {},
): A2AOutboxItem[] {
  return listRuntimeAssetRevisionStates('a2a', {
    assetPathPrefix: A2A_OUTBOX_ASSET_PREFIX,
  })
    .map((state) => parseOutboxItem(state.content, state.assetPath))
    .filter(
      (item): item is A2AOutboxItem =>
        item !== null && matchesOutboxListStatus(item, options.status),
    )
    .sort((left, right) => {
      const nextAttemptOrder = left.nextAttemptAt.localeCompare(
        right.nextAttemptAt,
      );
      if (nextAttemptOrder !== 0) return nextAttemptOrder;
      return left.id.localeCompare(right.id);
    });
}

function makeOutboxItem(
  envelope: A2AEnvelope,
  descriptor: Partial<
    Pick<A2APeerDescriptor, 'agentCardUrl' | 'bearerTokenRef'>
  >,
  context?: TransportAdapterContext,
  opts?: A2AOutboundAdapterOptions,
  identityResolution?: A2AOutboxItem['identityResolution'],
): A2AOutboxItem {
  const createdAt = new Date();
  const createdAtIso = nowIso(createdAt);
  return {
    schemaVersion: A2A_OUTBOX_SCHEMA_VERSION,
    id: randomUUID(),
    status: 'pending',
    envelope: validateA2AEnvelope(envelope),
    ...(descriptor.agentCardUrl
      ? { agentCardUrl: descriptor.agentCardUrl }
      : {}),
    ...(identityResolution ? { identityResolution } : {}),
    bearerTokenRef: descriptor.bearerTokenRef,
    attempts: 0,
    maxAttempts: normalizePositiveInteger(
      opts?.maxAttempts,
      A2A_RETRY_MAX_ATTEMPTS,
    ),
    nextAttemptAt: createdAtIso,
    createdAt: createdAtIso,
    updatedAt: createdAtIso,
    sessionId: context?.sessionId,
    runId: context?.runId,
    escalationTarget: context?.escalationTarget,
  };
}

export function enqueueA2AEnvelope(
  envelope: A2AEnvelope,
  descriptor: A2APeerDescriptor,
  context?: TransportAdapterContext,
  opts?: A2AOutboundAdapterOptions,
): A2AOutboxItem {
  const item = makeOutboxItem(envelope, descriptor, context, opts);
  persistA2AOutboxItem(item);
  return item;
}

export function enqueueUnresolvedA2AEnvelope(
  envelope: A2AEnvelope,
  recipientAgentId: string,
  context?: TransportAdapterContext,
  opts?: A2AOutboundAdapterOptions,
): A2AOutboxItem {
  const item = makeOutboxItem(envelope, {}, context, opts, {
    status: 'unresolved',
    canonicalId: recipientAgentId,
  });
  persistA2AOutboxItem(item);
  return item;
}
