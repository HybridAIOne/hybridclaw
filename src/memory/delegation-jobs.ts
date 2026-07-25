import type Database from 'better-sqlite3';
import {
  DELEGATION_JOBS_MAX_ROWS,
  DELEGATION_JOBS_RETENTION_DAYS,
} from '../config/config.js';
import type { ArtifactMetadata } from '../types/execution.js';
import { withMemoryDatabase } from './database.js';
import { queryOne } from './sqlite.js';

export type DelegationJobStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DelegationJobRow {
  public_id: string;
  internal_id: string;
  parent_session_id: string;
  channel_id: string;
  agent_id: string;
  model: string | null;
  status: DelegationJobStatus;
  task_count: number;
  ack_text: string | null;
  result_text: string | null;
  result_digest: string | null;
  artifacts_json: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const TERMINAL_DELEGATION_JOB_STATUSES = [
  'completed',
  'failed',
  'cancelled',
] as const;

function normalizeDelegationJobId(publicId: string): string {
  return String(publicId || '').trim();
}

function serializeArtifacts(
  artifacts?: ArtifactMetadata[] | null,
): string | null {
  if (!Array.isArray(artifacts)) return null;
  const normalized = artifacts
    .map((artifact) => ({
      path: String(artifact?.path || '').trim(),
      filename: String(artifact?.filename || '').trim(),
      mimeType: String(artifact?.mimeType || '').trim(),
    }))
    .filter(
      (artifact) =>
        artifact.path.length > 0 &&
        artifact.filename.length > 0 &&
        artifact.mimeType.length > 0,
    );
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

function prune(
  database: Database.Database,
  params?: {
    retentionDays?: number;
    maxRows?: number;
  },
): void {
  const retentionDays = Math.max(
    1,
    Math.floor(params?.retentionDays ?? DELEGATION_JOBS_RETENTION_DAYS),
  );
  const maxRows = Math.max(
    1,
    Math.floor(params?.maxRows ?? DELEGATION_JOBS_MAX_ROWS),
  );
  const terminalPlaceholders = TERMINAL_DELEGATION_JOB_STATUSES.map(
    () => '?',
  ).join(', ');

  database
    .prepare(
      `DELETE FROM delegation_jobs
       WHERE status IN (${terminalPlaceholders})
         AND created_at < datetime('now', ?)`,
    )
    .run(...TERMINAL_DELEGATION_JOB_STATUSES, `-${retentionDays} days`);

  database
    .prepare(
      `DELETE FROM delegation_jobs
       WHERE status IN (${terminalPlaceholders})
         AND public_id NOT IN (
           SELECT public_id
           FROM delegation_jobs
           WHERE status IN (${terminalPlaceholders})
           ORDER BY created_at DESC, public_id DESC
           LIMIT ?
         )`,
    )
    .run(
      ...TERMINAL_DELEGATION_JOB_STATUSES,
      ...TERMINAL_DELEGATION_JOB_STATUSES,
      maxRows,
    );
}

export function pruneDelegationJobs(params?: {
  retentionDays?: number;
  maxRows?: number;
}): void {
  withMemoryDatabase((database) => prune(database, params));
}

export function createDelegationJob(row: {
  publicId: string;
  internalId: string;
  parentSessionId: string;
  channelId: string;
  agentId: string;
  model?: string | null;
  taskCount: number;
  ackText?: string | null;
}): void {
  withMemoryDatabase((database) => {
    const publicId = normalizeDelegationJobId(row.publicId);
    const internalId = String(row.internalId || '').trim();
    const parentSessionId = String(row.parentSessionId || '').trim();
    const channelId = String(row.channelId || '').trim();
    const agentId = String(row.agentId || '').trim();
    if (
      !publicId ||
      !internalId ||
      !parentSessionId ||
      !channelId ||
      !agentId
    ) {
      throw new Error(
        'Delegation job requires public, internal, session, channel, and agent ids.',
      );
    }

    database
      .prepare(
        `INSERT INTO delegation_jobs (
           public_id,
           internal_id,
           parent_session_id,
           channel_id,
           agent_id,
           model,
           status,
           task_count,
           ack_text
         ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        publicId,
        internalId,
        parentSessionId,
        channelId,
        agentId,
        row.model?.trim() || null,
        Math.max(0, Math.floor(row.taskCount || 0)),
        row.ackText?.trim() || null,
      );
    prune(database);
  });
}

export function markDelegationJobInProgress(publicId: string): void {
  withMemoryDatabase((database) => {
    const normalized = normalizeDelegationJobId(publicId);
    if (!normalized) return;
    database
      .prepare(
        `UPDATE delegation_jobs
         SET status = 'in_progress',
             started_at = COALESCE(started_at, datetime('now'))
         WHERE public_id = ?
           AND status = 'queued'`,
      )
      .run(normalized);
  });
}

export function completeDelegationJob(
  publicId: string,
  result: {
    resultText?: string | null;
    resultDigest?: string | null;
    artifacts?: ArtifactMetadata[] | null;
  },
): void {
  withMemoryDatabase((database) => {
    const normalized = normalizeDelegationJobId(publicId);
    if (!normalized) return;
    database
      .prepare(
        `UPDATE delegation_jobs
         SET status = 'completed',
             result_text = ?,
             result_digest = ?,
             artifacts_json = ?,
             error = NULL,
             completed_at = datetime('now')
         WHERE public_id = ?
           AND status IN ('queued', 'in_progress')`,
      )
      .run(
        result.resultText?.trim() || null,
        result.resultDigest?.trim() || null,
        serializeArtifacts(result.artifacts),
        normalized,
      );
  });
}

export function failDelegationJob(publicId: string, error: string): void {
  withMemoryDatabase((database) => {
    const normalized = normalizeDelegationJobId(publicId);
    if (!normalized) return;
    const normalizedError = String(error || '').trim() || 'delegation_failed';
    database
      .prepare(
        `UPDATE delegation_jobs
         SET status = 'failed',
             error = ?,
             completed_at = datetime('now')
         WHERE public_id = ?
           AND status IN ('queued', 'in_progress')`,
      )
      .run(normalizedError, normalized);
  });
}

export function cancelDelegationJob(publicId: string): boolean {
  return withMemoryDatabase((database) => {
    const normalized = normalizeDelegationJobId(publicId);
    if (!normalized) return false;
    const result = database
      .prepare(
        `UPDATE delegation_jobs
         SET status = 'cancelled',
             completed_at = datetime('now')
         WHERE public_id = ?
           AND status = 'queued'`,
      )
      .run(normalized);
    return result.changes > 0;
  });
}

export function getDelegationJob(publicId: string): DelegationJobRow | null {
  return withMemoryDatabase((database) => {
    const normalized = normalizeDelegationJobId(publicId);
    if (!normalized) return null;
    return (
      queryOne<DelegationJobRow, [string]>(
        database,
        'SELECT * FROM delegation_jobs WHERE public_id = ?',
        normalized,
      ) || null
    );
  });
}

export function failStaleDelegationJobs(error: string): number {
  return withMemoryDatabase((database) => {
    const normalizedError = String(error || '').trim() || 'gateway_restart';
    const result = database
      .prepare(
        `UPDATE delegation_jobs
         SET status = 'failed',
             error = ?,
             completed_at = datetime('now')
         WHERE status IN ('queued', 'in_progress')`,
      )
      .run(normalizedError);
    return result.changes;
  });
}
