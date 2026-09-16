import { randomBytes } from 'node:crypto';

import type Database from 'better-sqlite3';

import {
  FEEDBACK_DRAFT_RETENTION_DAYS,
  type FeedbackDraftFailureMode,
  type FeedbackDraftStatus,
  type FeedbackDraftTaskCategory,
  type FeedbackDraftTrigger,
  type FeedbackDraftType,
} from '../../container/shared/feedback-drafts.js';
import { withMemoryDatabase } from './database.js';
import { resolveSessionIdCompat } from './sessions.js';
import { queryAll, queryOne } from './sqlite.js';

export interface FeedbackDraftRecord {
  id: string;
  session_id: string;
  agent_id: string | null;
  channel_id: string | null;
  run_id: string | null;
  model: string | null;
  provider: string | null;
  gateway_version: string | null;
  trigger: FeedbackDraftTrigger;
  type: FeedbackDraftType;
  title: string;
  details: string;
  area: string | null;
  failure_mode: FeedbackDraftFailureMode | null;
  task_category: FeedbackDraftTaskCategory | null;
  status: FeedbackDraftStatus;
  viewed_at: string | null;
  submitted_by: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface InsertFeedbackDraftInput {
  sessionId: string;
  agentId?: string | null;
  channelId?: string | null;
  runId?: string | null;
  model?: string | null;
  provider?: string | null;
  gatewayVersion?: string | null;
  trigger: FeedbackDraftTrigger;
  type: FeedbackDraftType;
  title: string;
  details: string;
  area?: string | null;
  failureMode?: FeedbackDraftFailureMode | null;
  taskCategory?: FeedbackDraftTaskCategory | null;
  now?: Date;
}

function getDatabase(): Database.Database {
  return withMemoryDatabase((database) => database);
}

function nullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function createFeedbackDraftId(): string {
  return `fbd_${randomBytes(5).toString('hex')}`;
}

export function insertFeedbackDraft(
  input: InsertFeedbackDraftInput,
): FeedbackDraftRecord {
  const now = input.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + FEEDBACK_DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const id = createFeedbackDraftId();
  const row = getDatabase()
    .prepare(
      `INSERT INTO feedback_drafts (
         id, session_id, agent_id, channel_id, run_id, model, provider,
         gateway_version, trigger, type, title, details, area, failure_mode,
         task_category, status, created_at, updated_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
       RETURNING *`,
    )
    .get(
      id,
      resolveSessionIdCompat(input.sessionId),
      nullableText(input.agentId),
      nullableText(input.channelId),
      nullableText(input.runId),
      nullableText(input.model),
      nullableText(input.provider),
      nullableText(input.gatewayVersion),
      input.trigger,
      input.type,
      input.title,
      input.details,
      nullableText(input.area),
      input.failureMode ?? null,
      input.taskCategory ?? null,
      now.toISOString(),
      now.toISOString(),
      expiresAt.toISOString(),
    ) as FeedbackDraftRecord | undefined;
  if (!row) throw new Error('Failed to persist feedback draft.');
  return row;
}

export function getFeedbackDraft(id: string): FeedbackDraftRecord | null {
  const trimmed = id.trim();
  if (!trimmed) return null;
  return (
    queryOne<FeedbackDraftRecord>(
      getDatabase(),
      'SELECT * FROM feedback_drafts WHERE id = ?',
      trimmed,
    ) ?? null
  );
}

export function findQueuedFeedbackDraftByTitle(input: {
  sessionId: string;
  title: string;
}): FeedbackDraftRecord | null {
  return (
    queryOne<FeedbackDraftRecord>(
      getDatabase(),
      `SELECT * FROM feedback_drafts
       WHERE session_id = ? AND status = 'queued' AND title = ? COLLATE NOCASE
       ORDER BY created_at DESC
       LIMIT 1`,
      resolveSessionIdCompat(input.sessionId),
      input.title.trim(),
    ) ?? null
  );
}

export function listFeedbackDrafts(input: {
  sessionId?: string | null;
  status?: FeedbackDraftStatus | null;
  limit?: number;
}): FeedbackDraftRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.sessionId?.trim()) {
    clauses.push('session_id = ?');
    params.push(resolveSessionIdCompat(input.sessionId));
  }
  if (input.status) {
    clauses.push('status = ?');
    params.push(input.status);
  }
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
  params.push(limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return queryAll<FeedbackDraftRecord>(
    getDatabase(),
    `SELECT * FROM feedback_drafts ${where}
     ORDER BY created_at DESC
     LIMIT ?`,
    ...params,
  );
}

export function countQueuedFeedbackDrafts(sessionId: string): number {
  const row = queryOne<{ count: number }>(
    getDatabase(),
    `SELECT COUNT(*) AS count FROM feedback_drafts
     WHERE session_id = ? AND status = 'queued'`,
    resolveSessionIdCompat(sessionId),
  );
  return row?.count ?? 0;
}

export function markFeedbackDraftViewed(
  id: string,
): FeedbackDraftRecord | null {
  const row = getDatabase()
    .prepare(
      `UPDATE feedback_drafts
       SET viewed_at = COALESCE(viewed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?
       RETURNING *`,
    )
    .get(id.trim()) as FeedbackDraftRecord | undefined;
  return row ?? null;
}

export function updateFeedbackDraftStatus(input: {
  id: string;
  status: Exclude<FeedbackDraftStatus, 'queued'>;
  submittedBy?: string | null;
}): FeedbackDraftRecord | null {
  const row = getDatabase()
    .prepare(
      `UPDATE feedback_drafts
       SET status = ?,
           submitted_by = COALESCE(?, submitted_by),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'queued'
       RETURNING *`,
    )
    .get(input.status, nullableText(input.submittedBy), input.id.trim()) as
    | FeedbackDraftRecord
    | undefined;
  return row ?? null;
}

/** Flip queued drafts past their retention window to `expired`. */
export function expireFeedbackDrafts(now: Date = new Date()): number {
  const result = getDatabase()
    .prepare(
      `UPDATE feedback_drafts
       SET status = 'expired',
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE status = 'queued' AND expires_at <= ?`,
    )
    .run(now.toISOString());
  return result.changes;
}
