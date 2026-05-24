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
import {
  emitRuntimeEvent,
  type RuntimeEventPayload,
  subscribeRuntimeEvents,
} from '../skills/skill-run-events.js';

export const BOARD_CARD_COLUMNS = [
  'triage',
  'todo',
  'in_progress',
  'in_review',
  'done',
] as const;

const BOARD_CARD_STATE_VERSION = 1;
const BOARD_EDGE_STATE_VERSION = 1;
const BOARD_CARD_ASSET_PREFIX = 'board/cards';
const BOARD_EDGE_ASSET_PREFIX = 'board/edges';
const SOURCE_PREFIXES = ['autopilot', 'a2a', 'workflow'] as const;
const SOURCE_ID_RE = /^(?!.*\.\.)[a-zA-Z0-9_.-]+$/;
const BOARD_CARD_SELECT_COLUMNS =
  'id, title, body, owner_type, owner_id, "column", status, source, parent, created_at, updated_at, deleted_at';
const BOARD_EDGE_SELECT_COLUMNS =
  'id, from_card_id, to_card_id, kind, created_at, created_by';
const BOARD_EDGE_KINDS = ['blocks', 'blocked_by', 'related'] as const;
const STORED_BOARD_EDGE_KINDS = ['blocks', 'related'] as const;

export type BoardCardColumn = (typeof BOARD_CARD_COLUMNS)[number];
export type BoardCardEdgeKind = (typeof BOARD_EDGE_KINDS)[number];
type StoredBoardCardEdgeKind = (typeof STORED_BOARD_EDGE_KINDS)[number];

export type BoardCardOwner =
  | { userId: string; agentId?: never }
  | { agentId: string; userId?: never };

export type BoardCardActor = BoardCardOwner | { system: string };

export type BoardCardSource =
  | 'manual'
  | `autopilot/${string}`
  | `a2a/${string}`
  | `workflow/${string}`;
export type BoardCardSourcePrefix = (typeof SOURCE_PREFIXES)[number];

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

export interface Edge {
  id: string;
  fromCardId: string;
  toCardId: string;
  kind: BoardCardEdgeKind;
  createdAt: string;
  createdBy: BoardCardActor;
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
  Pick<Card, 'title' | 'body' | 'owner' | 'column' | 'status' | 'source'> & {
    parent: string | null;
  }
>;

export interface ListCardsFilter {
  column?: BoardCardColumn;
  owner?: BoardCardOwner;
  source?: BoardCardSource;
  sourcePrefix?: BoardCardSourcePrefix;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
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

export interface BoardEdgeMutationEvent extends AuditEventPayload {
  type: 'board.edge_added' | 'board.edge_removed';
  actor: BoardCardActor;
  edgeId: string;
  fromCardId: string;
  toCardId: string;
  kind: BoardCardEdgeKind;
  at: string;
}

interface BoardCardRow {
  id: string;
  title: string;
  body: string;
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

interface BoardEdgeRow {
  id: string;
  from_card_id: string;
  to_card_id: string;
  kind: string;
  created_at: string;
  created_by: string;
}

interface PersistedBoardCardState {
  version: typeof BOARD_CARD_STATE_VERSION;
  card: Card;
}

interface StoredBoardCardEdge {
  id: string;
  fromCardId: string;
  toCardId: string;
  kind: StoredBoardCardEdgeKind;
  createdAt: string;
  createdBy: BoardCardActor;
}

interface PersistedBoardEdgeState {
  version: typeof BOARD_EDGE_STATE_VERSION;
  edge: StoredBoardCardEdge;
}

export type BoardCardSubscriber = (event: BoardCardMutationEvent) => unknown;

function isBoardCardMutationEvent(
  event: RuntimeEventPayload,
): event is BoardCardMutationEvent {
  return (
    event.type === 'board.card_created' ||
    event.type === 'board.card_updated' ||
    event.type === 'board.card_deleted'
  );
}

export function subscribeBoardCardEvents(
  subscriber: BoardCardSubscriber,
): () => void {
  return subscribeRuntimeEvents((event) => {
    if (!isBoardCardMutationEvent(event)) return;
    subscriber(event);
  });
}

function boardCardAssetPath(id: string): string {
  return path.join(BOARD_CARD_ASSET_PREFIX, `${encodeURIComponent(id)}.json`);
}

function boardEdgeAssetPath(id: string): string {
  return path.join(BOARD_EDGE_ASSET_PREFIX, `${encodeURIComponent(id)}.json`);
}

function normalizeNonEmptyString(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function normalizeOptionalString(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string.`);
  }
  return value.trim() || null;
}

function normalizeOptionalNonNegativeInteger(
  value: unknown,
  field: string,
): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

function normalizeColumn(value: unknown): BoardCardColumn {
  const normalized = normalizeNonEmptyString(value, 'column');
  if (BOARD_CARD_COLUMNS.includes(normalized as BoardCardColumn)) {
    return normalized as BoardCardColumn;
  }
  throw new Error(`Unsupported board card column: ${normalized}`);
}

function normalizeEdgeKind(value: unknown): BoardCardEdgeKind {
  const normalized = normalizeNonEmptyString(value, 'kind');
  if (BOARD_EDGE_KINDS.includes(normalized as BoardCardEdgeKind)) {
    return normalized as BoardCardEdgeKind;
  }
  throw new Error(`Unsupported board card edge kind: ${normalized}`);
}

function normalizeStoredEdgeKind(value: unknown): StoredBoardCardEdgeKind {
  const normalized = normalizeNonEmptyString(value, 'kind');
  if (STORED_BOARD_EDGE_KINDS.includes(normalized as StoredBoardCardEdgeKind)) {
    return normalized as StoredBoardCardEdgeKind;
  }
  throw new Error(`Unsupported persisted board card edge kind: ${normalized}`);
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

function serializeActor(actor: BoardCardActor): string {
  return JSON.stringify(normalizeActor(actor));
}

function parseActor(raw: string): BoardCardActor {
  const parsed = parseJsonObject(raw, 'Board edge actor');
  return normalizeActor(parsed as BoardCardActor);
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${label} JSON is invalid: ${
        error instanceof Error ? error.message : 'unknown parse error'
      }`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object.`);
  }
  return parsed as Record<string, unknown>;
}

function normalizeSource(source: unknown): BoardCardSource {
  const normalized = normalizeNonEmptyString(source, 'source');
  if (normalized === 'manual') return normalized;
  const separatorIndex = normalized.indexOf('/');
  const prefix =
    separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : normalized;
  const rest = separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : '';
  if (
    SOURCE_PREFIXES.includes(prefix as (typeof SOURCE_PREFIXES)[number]) &&
    rest?.trim() &&
    SOURCE_ID_RE.test(rest.trim())
  ) {
    return normalized as BoardCardSource;
  }
  throw new Error(`Unsupported board card source: ${normalized}`);
}

function parseOwner(
  row: Pick<BoardCardRow, 'owner_type' | 'owner_id'>,
): BoardCardOwner {
  if (row.owner_type === 'user') {
    return normalizeOwner({ userId: row.owner_id }).owner;
  }
  if (row.owner_type === 'agent') {
    return normalizeOwner({ agentId: row.owner_id }).owner;
  }
  throw new Error(
    `Unsupported persisted board card owner type: ${row.owner_type}`,
  );
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

function mapStoredEdgeRow(row: BoardEdgeRow): StoredBoardCardEdge {
  return normalizeStoredEdgeForPersistence({
    id: row.id,
    fromCardId: row.from_card_id,
    toCardId: row.to_card_id,
    kind: normalizeStoredEdgeKind(row.kind),
    createdAt: row.created_at,
    createdBy: parseActor(row.created_by),
  });
}

function orientStoredEdgeForCard(
  edge: StoredBoardCardEdge,
  cardId: string,
): Edge {
  if (edge.kind === 'related') {
    if (edge.fromCardId === cardId) {
      return { ...edge, kind: 'related' };
    }
    if (edge.toCardId === cardId) {
      return {
        ...edge,
        fromCardId: edge.toCardId,
        toCardId: edge.fromCardId,
        kind: 'related',
      };
    }
    throw new Error(
      `Board card edge ${edge.id} is not connected to ${cardId}.`,
    );
  }

  if (edge.toCardId === cardId) {
    return {
      ...edge,
      fromCardId: edge.toCardId,
      toCardId: edge.fromCardId,
      kind: 'blocked_by',
    };
  }
  return { ...edge, kind: 'blocks' };
}

function orientStoredEdgeForInput(
  edge: StoredBoardCardEdge,
  fromCardId: string,
  toCardId: string,
  kind: BoardCardEdgeKind,
): Edge {
  return {
    id: edge.id,
    fromCardId,
    toCardId,
    kind,
    createdAt: edge.createdAt,
    createdBy: edge.createdBy,
  };
}

function serializeCardState(card: Card): string {
  return JSON.stringify({
    version: BOARD_CARD_STATE_VERSION,
    card,
  } satisfies PersistedBoardCardState);
}

function serializeEdgeState(edge: StoredBoardCardEdge): string {
  return JSON.stringify({
    version: BOARD_EDGE_STATE_VERSION,
    edge,
  } satisfies PersistedBoardEdgeState);
}

function parseCardState(raw: string): Card {
  const parsed = parseJsonObject(raw, 'Board card revision');
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

function parseEdgeState(raw: string): StoredBoardCardEdge {
  const parsed = parseJsonObject(raw, 'Board edge revision');
  const state = parsed as Partial<PersistedBoardEdgeState>;
  if (state.version !== BOARD_EDGE_STATE_VERSION) {
    throw new Error(
      `Board edge revision version must be ${BOARD_EDGE_STATE_VERSION}.`,
    );
  }
  if (!state.edge || typeof state.edge !== 'object') {
    throw new Error('Board edge revision edge is required.');
  }
  return normalizeStoredEdgeForPersistence(state.edge as StoredBoardCardEdge);
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

function normalizeStoredEdgeForPersistence(
  edge: StoredBoardCardEdge,
): StoredBoardCardEdge {
  const fromCardId = normalizeNonEmptyString(edge.fromCardId, 'fromCardId');
  const toCardId = normalizeNonEmptyString(edge.toCardId, 'toCardId');
  if (fromCardId === toCardId) {
    throw new Error('Board card edge cannot point to the same card.');
  }
  return {
    id: normalizeNonEmptyString(edge.id, 'id'),
    fromCardId,
    toCardId,
    kind: normalizeStoredEdgeKind(edge.kind),
    createdAt: normalizeNonEmptyString(edge.createdAt, 'createdAt'),
    createdBy: normalizeActor(edge.createdBy),
  };
}

function canonicalizeEdgeInput(
  fromCardId: string,
  toCardId: string,
  kind: BoardCardEdgeKind,
): Pick<StoredBoardCardEdge, 'fromCardId' | 'toCardId' | 'kind'> {
  if (fromCardId === toCardId) {
    throw new Error('Board card edge cannot point to the same card.');
  }
  if (kind === 'blocked_by') {
    return {
      fromCardId: toCardId,
      toCardId: fromCardId,
      kind: 'blocks',
    };
  }
  if (kind === 'related') {
    const [first, second] =
      fromCardId < toCardId ? [fromCardId, toCardId] : [toCardId, fromCardId];
    return { fromCardId: first, toCardId: second, kind };
  }
  return { fromCardId, toCardId, kind };
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
    const equal =
      field === 'owner'
        ? JSON.stringify(beforeValue) === JSON.stringify(afterValue)
        : beforeValue === afterValue;
    if (equal) continue;
    diff[field] = { before: beforeValue, after: afterValue };
  }
  return diff;
}

function emitBoardCardEvent(
  event: BoardCardMutationEvent,
  context?: BoardCardMutationContext,
): void {
  emitRuntimeEvent(event);
  recordAuditEvent({
    sessionId: context?.sessionId?.trim() || 'board',
    runId: context?.runId?.trim() || makeAuditRunId('board-card'),
    event,
  });
}

function emitBoardEdgeEvent(
  event: BoardEdgeMutationEvent,
  context?: BoardCardMutationContext,
): void {
  emitRuntimeEvent(event);
  recordAuditEvent({
    sessionId: context?.sessionId?.trim() || 'board',
    runId: context?.runId?.trim() || makeAuditRunId('board-edge'),
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

function syncEdgeRevisionState(
  database: Database.Database,
  revisionSchemaName: string,
  edge: StoredBoardCardEdge,
  context: BoardCardMutationContext | undefined,
  opts?: { exists?: boolean; timestamp?: string },
): void {
  syncRuntimeAssetRevisionStateInOpenDatabase(
    database,
    'board_edge',
    boardEdgeAssetPath(edge.id),
    {
      actor: formatActorForRevision(context?.actor),
      route: context?.meta?.route || 'board.edge-store',
      source: context?.meta?.source || edge.kind,
    },
    opts?.exists === false
      ? { exists: false, content: null }
      : {
          exists: true,
          content: serializeEdgeState(edge),
        },
    opts?.timestamp || edge.createdAt,
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
  return normalized;
}

function selectCard(
  database: Database.Database,
  id: string,
  opts?: { includeDeleted?: boolean },
): Card | null {
  const row = database
    .prepare<[string], BoardCardRow>(
      `SELECT ${BOARD_CARD_SELECT_COLUMNS}
       FROM board_cards
       WHERE id = ?
       ${opts?.includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
    )
    .get(id);
  if (!row) return null;
  return mapCardRow(row);
}

function selectActiveCardIds(
  database: Database.Database,
  ids: [string, string],
): Set<string> {
  return new Set(
    database
      .prepare<[string, string], { id: string }>(
        `SELECT id
         FROM board_cards
         WHERE id IN (?, ?)
           AND deleted_at IS NULL`,
      )
      .all(ids[0], ids[1])
      .map((row) => row.id),
  );
}

function selectStoredEdge(
  database: Database.Database,
  id: string,
): StoredBoardCardEdge | null {
  const row = database
    .prepare<[string], BoardEdgeRow>(
      `SELECT ${BOARD_EDGE_SELECT_COLUMNS}
       FROM board_card_edges
       WHERE id = ?`,
    )
    .get(id);
  if (!row) return null;
  return mapStoredEdgeRow(row);
}

function selectStoredEdgeByLogicalKey(
  database: Database.Database,
  edge: Pick<StoredBoardCardEdge, 'fromCardId' | 'toCardId' | 'kind'>,
): StoredBoardCardEdge | null {
  if (edge.kind === 'blocks') {
    const row = database
      .prepare<[string, string], BoardEdgeRow>(
        `SELECT ${BOARD_EDGE_SELECT_COLUMNS}
         FROM board_card_edges
         WHERE from_card_id = ?
           AND to_card_id = ?
           AND kind = 'blocks'
         LIMIT 1`,
      )
      .get(edge.fromCardId, edge.toCardId);
    if (!row) return null;
    return mapStoredEdgeRow(row);
  }

  const row = database
    .prepare<[string, string, string], BoardEdgeRow>(
      `SELECT ${BOARD_EDGE_SELECT_COLUMNS}
       FROM board_card_edges
       WHERE from_card_id = ?
         AND to_card_id = ?
         AND kind = ?`,
    )
    .get(edge.fromCardId, edge.toCardId, edge.kind);
  if (!row) return null;
  return mapStoredEdgeRow(row);
}

function selectStoredEdgesForCard(
  database: Database.Database,
  cardId: string,
  kind: BoardCardEdgeKind | null,
): StoredBoardCardEdge[] {
  if (kind === 'blocks') {
    return database
      .prepare<[string], BoardEdgeRow>(
        `SELECT ${BOARD_EDGE_SELECT_COLUMNS}
         FROM board_card_edges
         WHERE from_card_id = ?
           AND kind = 'blocks'
         ORDER BY created_at ASC, id ASC`,
      )
      .all(cardId)
      .map(mapStoredEdgeRow);
  }

  if (kind === 'blocked_by') {
    return database
      .prepare<[string], BoardEdgeRow>(
        `SELECT ${BOARD_EDGE_SELECT_COLUMNS}
         FROM board_card_edges
         WHERE to_card_id = ?
           AND kind = 'blocks'
         ORDER BY created_at ASC, id ASC`,
      )
      .all(cardId)
      .map(mapStoredEdgeRow);
  }

  if (kind === 'related') {
    return database
      .prepare<[string, string], BoardEdgeRow>(
        `SELECT ${BOARD_EDGE_SELECT_COLUMNS}
         FROM (
           SELECT ${BOARD_EDGE_SELECT_COLUMNS}
           FROM board_card_edges
           WHERE from_card_id = ?
             AND kind = 'related'
           UNION ALL
           SELECT ${BOARD_EDGE_SELECT_COLUMNS}
           FROM board_card_edges
           WHERE to_card_id = ?
             AND kind = 'related'
         )
         ORDER BY created_at ASC, id ASC`,
      )
      .all(cardId, cardId)
      .map(mapStoredEdgeRow);
  }

  return database
    .prepare<[string, string], BoardEdgeRow>(
      `SELECT ${BOARD_EDGE_SELECT_COLUMNS}
       FROM (
         SELECT ${BOARD_EDGE_SELECT_COLUMNS}
         FROM board_card_edges
         WHERE from_card_id = ?
         UNION ALL
         SELECT ${BOARD_EDGE_SELECT_COLUMNS}
         FROM board_card_edges
         WHERE to_card_id = ?
       )
       ORDER BY created_at ASC, id ASC`,
    )
    .all(cardId, cardId)
    .map(mapStoredEdgeRow);
}

function insertOrReplaceStoredEdge(
  database: Database.Database,
  edge: StoredBoardCardEdge,
): StoredBoardCardEdge {
  const normalized = normalizeStoredEdgeForPersistence(edge);
  database
    .prepare(
      `INSERT INTO board_card_edges (
         id, from_card_id, to_card_id, kind, created_at, created_by
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         from_card_id = excluded.from_card_id,
         to_card_id = excluded.to_card_id,
         kind = excluded.kind,
         created_at = excluded.created_at,
         created_by = excluded.created_by`,
    )
    .run(
      normalized.id,
      normalized.fromCardId,
      normalized.toCardId,
      normalized.kind,
      normalized.createdAt,
      serializeActor(normalized.createdBy),
    );
  return normalized;
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

export function addEdge(
  fromCardId: string,
  toCardId: string,
  kind: BoardCardEdgeKind,
  context?: BoardCardMutationContext,
): Edge {
  const normalizedFrom = normalizeNonEmptyString(fromCardId, 'fromCardId');
  const normalizedTo = normalizeNonEmptyString(toCardId, 'toCardId');
  const normalizedKind = normalizeEdgeKind(kind);
  const canonical = canonicalizeEdgeInput(
    normalizedFrom,
    normalizedTo,
    normalizedKind,
  );
  const timestamp = new Date().toISOString();
  const actor = normalizeActor(context?.actor);

  return withMemoryDatabaseRuntimeRevisionStore((database, revisionSchema) => {
    const stored = database.transaction(() => {
      if (selectStoredEdgeByLogicalKey(database, canonical)) {
        throw new Error(
          `Board card edge already exists: ${normalizedFrom} ${normalizedKind} ${normalizedTo}`,
        );
      }
      const activeCardIds = selectActiveCardIds(database, [
        normalizedFrom,
        normalizedTo,
      ]);
      if (!activeCardIds.has(normalizedFrom)) {
        throw new Error(`Board card not found: ${normalizedFrom}`);
      }
      if (!activeCardIds.has(normalizedTo)) {
        throw new Error(`Board card not found: ${normalizedTo}`);
      }
      const edge = insertOrReplaceStoredEdge(database, {
        id: randomUUID(),
        ...canonical,
        createdAt: timestamp,
        createdBy: actor,
      });
      syncEdgeRevisionState(database, revisionSchema, edge, context);
      return edge;
    })();
    const edge = orientStoredEdgeForInput(
      stored,
      normalizedFrom,
      normalizedTo,
      normalizedKind,
    );
    emitBoardEdgeEvent(
      {
        type: 'board.edge_added',
        actor,
        edgeId: edge.id,
        fromCardId: edge.fromCardId,
        toCardId: edge.toCardId,
        kind: edge.kind,
        at: edge.createdAt,
      },
      context,
    );
    return edge;
  });
}

export function removeEdge(
  id: string,
  context?: BoardCardMutationContext,
): Edge {
  const normalizedId = normalizeNonEmptyString(id, 'id');
  const timestamp = new Date().toISOString();
  return withMemoryDatabaseRuntimeRevisionStore((database, revisionSchema) => {
    const removed = database.transaction(() => {
      const current = selectStoredEdge(database, normalizedId);
      if (!current)
        throw new Error(`Board card edge not found: ${normalizedId}`);
      database
        .prepare(`DELETE FROM board_card_edges WHERE id = ?`)
        .run(normalizedId);
      syncEdgeRevisionState(database, revisionSchema, current, context, {
        exists: false,
        timestamp,
      });
      return current;
    })();
    const edge = orientStoredEdgeForCard(removed, removed.fromCardId);
    emitBoardEdgeEvent(
      {
        type: 'board.edge_removed',
        actor: normalizeActor(context?.actor),
        edgeId: edge.id,
        fromCardId: edge.fromCardId,
        toCardId: edge.toCardId,
        kind: edge.kind,
        at: timestamp,
      },
      context,
    );
    return edge;
  });
}

export function listEdges(cardId: string, kind?: BoardCardEdgeKind): Edge[] {
  const normalizedId = normalizeNonEmptyString(cardId, 'cardId');
  const normalizedKind = kind ? normalizeEdgeKind(kind) : null;
  return withMemoryDatabase((database) => {
    return selectStoredEdgesForCard(database, normalizedId, normalizedKind).map(
      (edge) => orientStoredEdgeForCard(edge, normalizedId),
    );
  });
}

export function isBlocked(cardId: string): boolean {
  const normalizedId = normalizeNonEmptyString(cardId, 'cardId');
  return withMemoryDatabase((database) => {
    const row = database
      .prepare<[string], { id: string }>(
        `SELECT edge.id
         FROM board_card_edges edge
         JOIN board_cards blocker
           ON blocker.id = edge.from_card_id
         WHERE edge.kind = 'blocks'
           AND edge.to_card_id = ?
           AND blocker.deleted_at IS NULL
           AND blocker."column" <> 'done'
         LIMIT 1`,
      )
      .get(normalizedId);
    return Boolean(row);
  });
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
    if (filter.source) {
      clauses.push('source = ?');
      values.push(normalizeSource(filter.source));
    }
    if (filter.sourcePrefix) {
      clauses.push('source >= ? AND source < ?');
      values.push(`${filter.sourcePrefix}/`, `${filter.sourcePrefix}/\uffff`);
    }
    const limit = normalizeOptionalNonNegativeInteger(filter.limit, 'limit');
    const offset = normalizeOptionalNonNegativeInteger(filter.offset, 'offset');
    if (limit !== null) {
      values.push(limit);
      if (offset !== null) values.push(offset);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return database
      .prepare<unknown[], BoardCardRow>(
        `SELECT ${BOARD_CARD_SELECT_COLUMNS}
         FROM board_cards
         ${where}
         ORDER BY created_at ASC, id ASC
         ${limit !== null ? `LIMIT ?${offset !== null ? ' OFFSET ?' : ''}` : ''}`,
      )
      .all(...values)
      .map(mapCardRow);
  });
}

export function listActiveCardAgentOwnerIds(): string[] {
  return withMemoryDatabase((database) =>
    database
      .prepare<[], { owner_id: string }>(
        `SELECT DISTINCT owner_id
         FROM board_cards
         WHERE deleted_at IS NULL
           AND owner_type = 'agent'
           AND "column" <> 'done'
         ORDER BY owner_id ASC`,
      )
      .all()
      .map((row) => row.owner_id),
  );
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
      const now = new Date().toISOString();
      const deleted = normalizeCardForPersistence({
        ...current,
        updatedAt: now,
        deletedAt: now,
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

export function listEdgeRevisions(id: string) {
  return listRuntimeAssetRevisions(
    'board_edge',
    boardEdgeAssetPath(normalizeNonEmptyString(id, 'id')),
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
  if (restored.deletedAt) {
    throw new Error(`Board card revision ${revisionId} is a deleted snapshot.`);
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

export function restoreEdgeRevision(
  id: string,
  revisionId: number,
  context?: BoardCardMutationContext,
): Edge {
  const normalizedId = normalizeNonEmptyString(id, 'id');
  const revision = getRuntimeAssetRevision(
    'board_edge',
    boardEdgeAssetPath(normalizedId),
    revisionId,
  );
  if (!revision) {
    throw new Error(
      `Board edge revision ${revisionId} was not found for ${normalizedId}.`,
    );
  }
  const restored = parseEdgeState(revision.content);
  if (restored.id !== normalizedId) {
    throw new Error(`Board edge revision belongs to ${restored.id}.`);
  }

  return withMemoryDatabaseRuntimeRevisionStore((database, revisionSchema) => {
    const stored = database.transaction(() => {
      if (!selectCard(database, restored.fromCardId)) {
        throw new Error(`Board card not found: ${restored.fromCardId}`);
      }
      if (!selectCard(database, restored.toCardId)) {
        throw new Error(`Board card not found: ${restored.toCardId}`);
      }
      const edge = insertOrReplaceStoredEdge(database, restored);
      syncEdgeRevisionState(database, revisionSchema, edge, {
        ...context,
        meta: {
          actor: context?.meta?.actor,
          route: context?.meta?.route || `board.edge.rollback#${revisionId}`,
          source: context?.meta?.source || 'rollback',
        },
      });
      return edge;
    })();
    const edge = orientStoredEdgeForCard(stored, stored.fromCardId);
    emitBoardEdgeEvent(
      {
        type: 'board.edge_added',
        actor: normalizeActor(context?.actor),
        edgeId: edge.id,
        fromCardId: edge.fromCardId,
        toCardId: edge.toCardId,
        kind: edge.kind,
        at: new Date().toISOString(),
      },
      context,
    );
    return edge;
  });
}
