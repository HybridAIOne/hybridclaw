import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';

import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import type { AuditEventPayload } from '../audit/audit-trail.js';
import {
  getRuntimeAssetRevision,
  listRuntimeAssetRevisions,
  type RuntimeConfigChangeMeta,
  syncRuntimeAssetRevisionStateInOpenDatabase,
} from '../config/runtime-config-revisions.js';
import {
  withMemoryDatabase,
  withMemoryDatabaseRuntimeRevisionStore,
} from '../memory/db.js';

export const BOARD_CARD_COLUMNS = [
  'triage',
  'todo',
  'in_progress',
  'in_review',
  'done',
] as const;

const BOARD_CARD_STATE_VERSION = 1;
const BOARD_CARD_ASSET_PREFIX = 'board/cards';
const SOURCE_PREFIXES = ['autopilot', 'a2a', 'workflow'] as const;

export type BoardCardColumn = (typeof BOARD_CARD_COLUMNS)[number];

export type BoardCardOwner =
  | { userId: string; agentId?: never }
  | { agentId: string; userId?: never };

export type BoardCardActor = BoardCardOwner | { system: string };

export type BoardCardSource =
  | 'manual'
  | `autopilot/${string}`
  | `a2a/${string}`
  | `workflow/${string}`;

export interface Card {
  id: string;
  title: string;
  body: string;
  owner: BoardCardOwner;
  column: BoardCardColumn;
  status: string;
  source: BoardCardSource;
  parent: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreateCardInput {
  id?: string;
  title: string;
  body?: string;
  owner: BoardCardOwner;
  column?: BoardCardColumn;
  status?: string;
  source?: BoardCardSource;
  parent?: string | null;
}

export type UpdateCardPatch = Partial<
  Pick<Card, 'title' | 'body' | 'owner' | 'status' | 'source'> & {
    parent: string | null;
  }
>;

export interface ListCardsFilter {
  column?: BoardCardColumn;
  owner?: BoardCardOwner;
  sourcePrefix?: 'autopilot' | 'a2a' | 'workflow' | 'manual';
  includeDeleted?: boolean;
}

export interface BoardCardMutationContext {
  actor?: BoardCardActor | null;
  sessionId?: string | null;
  runId?: string | null;
  meta?: RuntimeConfigChangeMeta;
}

export interface BoardCardFieldDiff {
  before: unknown;
  after: unknown;
}

export interface BoardCardMutationEvent extends AuditEventPayload {
  type: 'board.card_created' | 'board.card_updated' | 'board.card_deleted';
  actor: BoardCardActor;
  cardId: string;
  diff: Record<string, BoardCardFieldDiff>;
  at: string;
}

interface BoardCardRow {
  id: string;
  title: string;
  body: string;
  owner: string;
  owner_type: string;
  owner_id: string;
  column: string;
  status: string;
  source: string;
  parent: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface PersistedBoardCardState {
  version: typeof BOARD_CARD_STATE_VERSION;
  card: Card;
}

export type BoardCardSubscriber = (event: BoardCardMutationEvent) => unknown;

const subscribers = new Set<BoardCardSubscriber>();

export function subscribeBoardCardEvents(
  subscriber: BoardCardSubscriber,
): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function boardCardAssetPath(id: string): string {
  return path.join(BOARD_CARD_ASSET_PREFIX, `${encodeURIComponent(id)}.json`);
}

function normalizeNonEmptyString(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function normalizeOptionalString(value: unknown, field: string): string | null {
  if (value == null) return null;
  const normalized = normalizeNonEmptyString(value, field);
  return normalized;
}

function normalizeColumn(value: unknown): BoardCardColumn {
  const normalized = normalizeNonEmptyString(value, 'column');
  if (BOARD_CARD_COLUMNS.includes(normalized as BoardCardColumn)) {
    return normalized as BoardCardColumn;
  }
  throw new Error(`Unsupported board card column: ${normalized}`);
}

function normalizeOwner(owner: BoardCardOwner): {
  owner: BoardCardOwner;
  ownerType: 'user' | 'agent';
  ownerId: string;
  ownerJson: string;
} {
  const userId = typeof owner.userId === 'string' ? owner.userId.trim() : '';
  const agentId = typeof owner.agentId === 'string' ? owner.agentId.trim() : '';
  if (userId && agentId) {
    throw new Error('Board card owner must reference one user or one agent.');
  }
  if (userId) {
    const normalizedOwner = { userId };
    return {
      owner: normalizedOwner,
      ownerType: 'user',
      ownerId: userId,
      ownerJson: JSON.stringify(normalizedOwner),
    };
  }
  if (agentId) {
    const normalizedOwner = { agentId };
    return {
      owner: normalizedOwner,
      ownerType: 'agent',
      ownerId: agentId,
      ownerJson: JSON.stringify(normalizedOwner),
    };
  }
  throw new Error('Board card owner is required.');
}

function normalizeActor(actor?: BoardCardActor | null): BoardCardActor {
  if (!actor) return { system: 'board' };
  if ('system' in actor) {
    return { system: normalizeNonEmptyString(actor.system, 'actor.system') };
  }
  return normalizeOwner(actor).owner;
}

function normalizeSource(source: unknown): BoardCardSource {
  const normalized = normalizeNonEmptyString(source, 'source');
  if (normalized === 'manual') return normalized;
  const [prefix, rest] = normalized.split('/', 2);
  if (
    SOURCE_PREFIXES.includes(prefix as (typeof SOURCE_PREFIXES)[number]) &&
    rest?.trim()
  ) {
    return normalized as BoardCardSource;
  }
  throw new Error(`Unsupported board card source: ${normalized}`);
}

function parseOwner(
  row: Pick<BoardCardRow, 'owner' | 'owner_type' | 'owner_id'>,
): BoardCardOwner {
  try {
    return normalizeOwner(JSON.parse(row.owner) as BoardCardOwner).owner;
  } catch {
    return row.owner_type === 'user'
      ? { userId: row.owner_id }
      : { agentId: row.owner_id };
  }
}

function mapCardRow(row: BoardCardRow): Card {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    owner: parseOwner(row),
    column: normalizeColumn(row.column),
    status: row.status,
    source: normalizeSource(row.source),
    parent: row.parent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function serializeCardState(card: Card): string {
  return JSON.stringify({
    version: BOARD_CARD_STATE_VERSION,
    card,
  } satisfies PersistedBoardCardState);
}

function parseCardState(raw: string): Card {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Board card revision JSON is invalid: ${
        error instanceof Error ? error.message : 'unknown parse error'
      }`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Board card revision must be an object.');
  }
  const state = parsed as Partial<PersistedBoardCardState>;
  if (state.version !== BOARD_CARD_STATE_VERSION) {
    throw new Error(
      `Board card revision version must be ${BOARD_CARD_STATE_VERSION}.`,
    );
  }
  if (!state.card || typeof state.card !== 'object') {
    throw new Error('Board card revision card is required.');
  }
  return normalizeCardForPersistence(state.card as Card);
}

function normalizeCardForPersistence(card: Card): Card {
  return {
    id: normalizeNonEmptyString(card.id, 'id'),
    title: normalizeNonEmptyString(card.title, 'title'),
    body: typeof card.body === 'string' ? card.body : '',
    owner: normalizeOwner(card.owner).owner,
    column: normalizeColumn(card.column),
    status: normalizeNonEmptyString(card.status, 'status'),
    source: normalizeSource(card.source),
    parent: normalizeOptionalString(card.parent, 'parent'),
    createdAt: normalizeNonEmptyString(card.createdAt, 'createdAt'),
    updatedAt: normalizeNonEmptyString(card.updatedAt, 'updatedAt'),
    deletedAt: card.deletedAt
      ? normalizeNonEmptyString(card.deletedAt, 'deletedAt')
      : null,
  };
}

function diffCards(
  before: Card | null,
  after: Card | null,
): Record<string, BoardCardFieldDiff> {
  const fields = [
    'id',
    'title',
    'body',
    'owner',
    'column',
    'status',
    'source',
    'parent',
    'createdAt',
    'updatedAt',
    'deletedAt',
  ] as const;
  const diff: Record<string, BoardCardFieldDiff> = {};
  for (const field of fields) {
    const beforeValue = before?.[field] ?? null;
    const afterValue = after?.[field] ?? null;
    if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) continue;
    diff[field] = { before: beforeValue, after: afterValue };
  }
  return diff;
}

function emitBoardCardEvent(
  event: BoardCardMutationEvent,
  context?: BoardCardMutationContext,
): void {
  for (const subscriber of subscribers) {
    try {
      subscriber(event);
    } catch {
      // Subscribers are best-effort; structured audit is the durable stream.
    }
  }
  recordAuditEvent({
    sessionId: context?.sessionId?.trim() || 'board',
    runId: context?.runId?.trim() || makeAuditRunId('board-card'),
    event,
  });
}

function syncCardRevisionState(
  database: Database.Database,
  revisionSchemaName: string,
  card: Card,
  context: BoardCardMutationContext | undefined,
): void {
  syncRuntimeAssetRevisionStateInOpenDatabase(
    database,
    'board_card',
    boardCardAssetPath(card.id),
    {
      actor: formatActorForRevision(context?.actor),
      route: context?.meta?.route || 'board.card-store',
      source: context?.meta?.source || card.source,
    },
    {
      exists: true,
      content: serializeCardState(card),
    },
    card.updatedAt,
    { schemaName: revisionSchemaName },
  );
}

function formatActorForRevision(actor?: BoardCardActor | null): string {
  const normalized = normalizeActor(actor);
  if ('system' in normalized) return `system:${normalized.system}`;
  if ('userId' in normalized) return `user:${normalized.userId}`;
  return `agent:${normalized.agentId}`;
}

function insertOrReplaceCard(database: Database.Database, card: Card): Card {
  const normalized = normalizeCardForPersistence(card);
  const owner = normalizeOwner(normalized.owner);
  database
    .prepare(
      `INSERT INTO board_cards (
         id, title, body, owner, owner_type, owner_id, "column", status, source, parent, created_at, updated_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         owner = excluded.owner,
         owner_type = excluded.owner_type,
         owner_id = excluded.owner_id,
         "column" = excluded."column",
         status = excluded.status,
         source = excluded.source,
         parent = excluded.parent,
         updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at`,
    )
    .run(
      normalized.id,
      normalized.title,
      normalized.body,
      owner.ownerJson,
      owner.ownerType,
      owner.ownerId,
      normalized.column,
      normalized.status,
      normalized.source,
      normalized.parent,
      normalized.createdAt,
      normalized.updatedAt,
      normalized.deletedAt,
    );
  const stored = selectCard(database, normalized.id, { includeDeleted: true });
  if (!stored) {
    throw new Error(`Failed to read persisted board card: ${normalized.id}`);
  }
  return stored;
}

function selectCard(
  database: Database.Database,
  id: string,
  opts?: { includeDeleted?: boolean },
): Card | null {
  const row = database
    .prepare<[string], BoardCardRow>(
      `SELECT id, title, body, owner, owner_type, owner_id, "column", status, source, parent, created_at, updated_at, deleted_at
       FROM board_cards
       WHERE id = ?`,
    )
    .get(id);
  if (!row) return null;
  const card = mapCardRow(row);
  if (!opts?.includeDeleted && card.deletedAt) return null;
  return card;
}

export function createCard(
  input: CreateCardInput,
  context?: BoardCardMutationContext,
): Card {
  const timestamp = new Date().toISOString();
  const card: Card = normalizeCardForPersistence({
    id: input.id?.trim() || randomUUID(),
    title: input.title,
    body: input.body ?? '',
    owner: input.owner,
    column: input.column ?? 'triage',
    status: input.status ?? 'queued',
    source: input.source ?? 'manual',
    parent: input.parent ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  });

  return withMemoryDatabaseRuntimeRevisionStore((database, revisionSchema) => {
    const created = database.transaction(() => {
      if (selectCard(database, card.id, { includeDeleted: true })) {
        throw new Error(`Board card already exists: ${card.id}`);
      }
      const stored = insertOrReplaceCard(database, card);
      syncCardRevisionState(database, revisionSchema, stored, context);
      return stored;
    })();
    emitBoardCardEvent(
      {
        type: 'board.card_created',
        actor: normalizeActor(context?.actor),
        cardId: created.id,
        diff: diffCards(null, created),
        at: created.updatedAt,
      },
      context,
    );
    return created;
  });
}

export function getCard(id: string): Card | null {
  const normalizedId = normalizeNonEmptyString(id, 'id');
  return withMemoryDatabase((database) => selectCard(database, normalizedId));
}

// This store is intentionally last-write-wins. R29.9 owns column/state-machine
// conflict validation; this layer only persists the newest accepted mutation.
export function listCards(filter: ListCardsFilter = {}): Card[] {
  return withMemoryDatabase((database) => {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (!filter.includeDeleted) {
      clauses.push('deleted_at IS NULL');
    }
    if (filter.column) {
      clauses.push('"column" = ?');
      values.push(normalizeColumn(filter.column));
    }
    if (filter.owner) {
      const owner = normalizeOwner(filter.owner);
      clauses.push('owner_type = ? AND owner_id = ?');
      values.push(owner.ownerType, owner.ownerId);
    }
    if (filter.sourcePrefix) {
      if (filter.sourcePrefix === 'manual') {
        clauses.push('source = ?');
        values.push('manual');
      } else {
        clauses.push('source >= ? AND source < ?');
        values.push(`${filter.sourcePrefix}/`, `${filter.sourcePrefix}/\uffff`);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return database
      .prepare<unknown[], BoardCardRow>(
        `SELECT id, title, body, owner, owner_type, owner_id, "column", status, source, parent, created_at, updated_at, deleted_at
         FROM board_cards
         ${where}
         ORDER BY created_at ASC, id ASC`,
      )
      .all(...values)
      .map(mapCardRow);
  });
}

export function updateCard(
  id: string,
  patch: UpdateCardPatch,
  context?: BoardCardMutationContext,
): Card {
  const normalizedId = normalizeNonEmptyString(id, 'id');
  return withMemoryDatabaseRuntimeRevisionStore((database, revisionSchema) => {
    const { before, after } = database.transaction(() => {
      const current = selectCard(database, normalizedId);
      if (!current) throw new Error(`Board card not found: ${normalizedId}`);
      const definedPatch = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ) as UpdateCardPatch;
      const next = normalizeCardForPersistence({
        ...current,
        ...definedPatch,
        updatedAt: new Date().toISOString(),
      });
      const stored = insertOrReplaceCard(database, next);
      syncCardRevisionState(database, revisionSchema, stored, context);
      return { before: current, after: stored };
    })();
    emitBoardCardEvent(
      {
        type: 'board.card_updated',
        actor: normalizeActor(context?.actor),
        cardId: after.id,
        diff: diffCards(before, after),
        at: after.updatedAt,
      },
      context,
    );
    return after;
  });
}

export function deleteCard(
  id: string,
  context?: BoardCardMutationContext,
): Card {
  const normalizedId = normalizeNonEmptyString(id, 'id');
  return withMemoryDatabaseRuntimeRevisionStore((database, revisionSchema) => {
    const { before, after } = database.transaction(() => {
      const current = selectCard(database, normalizedId);
      if (!current) throw new Error(`Board card not found: ${normalizedId}`);
      const deleted = normalizeCardForPersistence({
        ...current,
        updatedAt: new Date().toISOString(),
        deletedAt: new Date().toISOString(),
      });
      const stored = insertOrReplaceCard(database, deleted);
      syncCardRevisionState(database, revisionSchema, stored, context);
      return { before: current, after: stored };
    })();
    emitBoardCardEvent(
      {
        type: 'board.card_deleted',
        actor: normalizeActor(context?.actor),
        cardId: after.id,
        diff: diffCards(before, after),
        at: after.updatedAt,
      },
      context,
    );
    return after;
  });
}

export function listCardRevisions(id: string) {
  return listRuntimeAssetRevisions(
    'board_card',
    boardCardAssetPath(normalizeNonEmptyString(id, 'id')),
  );
}

export function restoreCardRevision(
  id: string,
  revisionId: number,
  context?: BoardCardMutationContext,
): Card {
  const normalizedId = normalizeNonEmptyString(id, 'id');
  const revision = getRuntimeAssetRevision(
    'board_card',
    boardCardAssetPath(normalizedId),
    revisionId,
  );
  if (!revision) {
    throw new Error(
      `Board card revision ${revisionId} was not found for ${normalizedId}.`,
    );
  }
  const restored = parseCardState(revision.content);
  if (restored.id !== normalizedId) {
    throw new Error(`Board card revision belongs to ${restored.id}.`);
  }

  return withMemoryDatabaseRuntimeRevisionStore((database, revisionSchema) => {
    const { before, after } = database.transaction(() => {
      const current = selectCard(database, normalizedId, {
        includeDeleted: true,
      });
      const next = normalizeCardForPersistence({
        ...restored,
        updatedAt: new Date().toISOString(),
      });
      const stored = insertOrReplaceCard(database, next);
      syncCardRevisionState(database, revisionSchema, stored, {
        ...context,
        meta: {
          actor: context?.meta?.actor,
          route: context?.meta?.route || `board.card.rollback#${revisionId}`,
          source: context?.meta?.source || 'rollback',
        },
      });
      return { before: current, after: stored };
    })();
    emitBoardCardEvent(
      {
        type: 'board.card_updated',
        actor: normalizeActor(context?.actor),
        cardId: after.id,
        diff: diffCards(before, after),
        at: after.updatedAt,
      },
      context,
    );
    return after;
  });
}
