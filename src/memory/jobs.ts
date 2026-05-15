import type Database from 'better-sqlite3';
import type { RuntimeSchedulerJob } from '../config/runtime-config.js';
import type { ScheduledTask } from '../types/scheduler.js';
import { resolveSessionIdCompat, withMemoryDatabase } from './db.js';

export interface StoredSchedulerJob extends RuntimeSchedulerJob {
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type StoredJobKind = 'scheduler_job' | 'scheduled_task';
export type StoredJob = StoredSchedulerJob | ScheduledTask;

export interface GetAllJobsQuery {
  kind?: StoredJobKind;
  sessionId?: string;
  enabledOnly?: boolean;
}

export interface CreateJobInput {
  kind: 'scheduled_task';
  sessionId: string;
  channelId: string;
  cronExpr: string;
  prompt: string;
  runAt?: string;
  everyMs?: number;
}

interface JobRow {
  id: string;
  kind: string;
  legacy_task_id: number | null;
  session_id: string | null;
  channel_id: string | null;
  name: string | null;
  description: string | null;
  agent_id: string | null;
  board_status: string | null;
  max_retries: number | null;
  schedule: string;
  action: string;
  delivery: string;
  enabled: number;
  last_run: string | null;
  last_status: string | null;
  consecutive_errors: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function queryOne<Row>(
  database: Database.Database,
  sql: string,
  ...params: unknown[]
): Row | null {
  return database.prepare<unknown[], Row>(sql).get(...params) ?? null;
}

function queryAll<Row>(
  database: Database.Database,
  sql: string,
  ...params: unknown[]
): Row[] {
  return database.prepare<unknown[], Row>(sql).all(...params);
}

function parseJobJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function schedulerJobFromRow(row: JobRow): StoredSchedulerJob {
  return {
    id: row.id,
    ...(row.name ? { name: row.name } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.board_status
      ? { boardStatus: row.board_status as RuntimeSchedulerJob['boardStatus'] }
      : {}),
    ...(row.max_retries != null ? { maxRetries: row.max_retries } : {}),
    schedule: parseJobJson<RuntimeSchedulerJob['schedule']>(row.schedule, {
      kind: 'cron',
      at: null,
      everyMs: null,
      expr: '',
      tz: '',
    }),
    action: parseJobJson<RuntimeSchedulerJob['action']>(row.action, {
      kind: 'agent_turn',
      message: '',
    }),
    delivery: parseJobJson<RuntimeSchedulerJob['delivery']>(row.delivery, {
      kind: 'channel',
      channel: '',
      to: '',
      webhookUrl: '',
    }),
    enabled: row.enabled !== 0,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function schedulerJobToDbValues(job: RuntimeSchedulerJob): {
  name: string | null;
  description: string | null;
  agentId: string | null;
  boardStatus: string | null;
  maxRetries: number | null;
  schedule: string;
  action: string;
  delivery: string;
  enabled: number;
} {
  return {
    name: job.name?.trim() || null,
    description: job.description?.trim() || null,
    agentId: job.agentId?.trim() || null,
    boardStatus: job.boardStatus || null,
    maxRetries:
      typeof job.maxRetries === 'number' && Number.isFinite(job.maxRetries)
        ? Math.floor(job.maxRetries)
        : null,
    schedule: JSON.stringify(job.schedule),
    action: JSON.stringify(job.action),
    delivery: JSON.stringify(job.delivery),
    enabled: job.enabled ? 1 : 0,
  };
}

function scheduledJobFromRow(row: JobRow): ScheduledTask {
  const schedule = parseJobJson<RuntimeSchedulerJob['schedule']>(row.schedule, {
    kind: 'cron',
    at: null,
    everyMs: null,
    expr: '',
    tz: '',
  });
  const action = parseJobJson<RuntimeSchedulerJob['action']>(row.action, {
    kind: 'agent_turn',
    message: '',
  });
  return {
    id: row.legacy_task_id ?? 0,
    session_id: row.session_id || '',
    channel_id: row.channel_id || '',
    cron_expr: schedule.kind === 'cron' ? schedule.expr || '' : '',
    run_at: schedule.kind === 'at' ? schedule.at : null,
    every_ms: schedule.kind === 'every' ? schedule.everyMs : null,
    prompt: action.message,
    enabled: row.enabled,
    last_run: row.last_run,
    last_status:
      row.last_status === 'success' || row.last_status === 'error'
        ? row.last_status
        : null,
    consecutive_errors: Math.max(0, Math.floor(row.consecutive_errors || 0)),
    created_at: row.created_at,
  };
}

function rowSelectClause(): string {
  return `SELECT id, kind, legacy_task_id, session_id, channel_id, name, description,
                 agent_id, board_status, max_retries, schedule, action, delivery,
                 enabled, last_run, last_status, consecutive_errors, sort_order,
                 created_at, updated_at
          FROM jobs`;
}

function normalizeJobId(jobId: string | number): string {
  if (typeof jobId === 'number') {
    const legacyId = Math.floor(jobId);
    return Number.isFinite(legacyId) && legacyId > 0 ? `task:${legacyId}` : '';
  }
  return jobId.trim();
}

function nextSchedulerJobSortOrder(database: Database.Database): number {
  const row = queryOne<{ next_order: number | null }>(
    database,
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM jobs WHERE kind = 'scheduler_job'",
  );
  return Math.max(0, Math.floor(row?.next_order ?? 0));
}

function nextLegacyJobId(database: Database.Database): number {
  const row = queryOne<{ next_id: number | null }>(
    database,
    "SELECT COALESCE(MAX(legacy_task_id), 0) + 1 AS next_id FROM jobs WHERE kind = 'scheduled_task'",
  );
  return Math.max(1, Math.floor(row?.next_id ?? 1));
}

function listStoredSchedulerJobs(
  database: Database.Database,
): StoredSchedulerJob[] {
  return queryAll<JobRow>(
    database,
    `${rowSelectClause()}
     WHERE kind = 'scheduler_job'
     ORDER BY sort_order ASC, created_at ASC, id ASC`,
  ).map(schedulerJobFromRow);
}

function listStoredScheduledTasks(
  database: Database.Database,
  query: GetAllJobsQuery = {},
): ScheduledTask[] {
  const whereClauses = ["kind = 'scheduled_task'"];
  const args: unknown[] = [];
  if (query.sessionId) {
    whereClauses.push('session_id = ?');
    args.push(resolveSessionIdCompat(query.sessionId));
  }
  if (query.enabledOnly) {
    whereClauses.push('enabled = 1');
  }
  return queryAll<JobRow>(
    database,
    `${rowSelectClause()}
     WHERE ${whereClauses.join(' AND ')}
     ORDER BY created_at DESC`,
    ...args,
  ).map(scheduledJobFromRow);
}

export function createJob(input: CreateJobInput): number {
  return withMemoryDatabase((database) => {
    const jobId = nextLegacyJobId(database);
    const schedule: RuntimeSchedulerJob['schedule'] = input.runAt
      ? { kind: 'at', at: input.runAt, everyMs: null, expr: null, tz: '' }
      : input.everyMs
        ? {
            kind: 'every',
            at: null,
            everyMs: input.everyMs,
            expr: null,
            tz: '',
          }
        : {
            kind: 'cron',
            at: null,
            everyMs: null,
            expr: input.cronExpr,
            tz: '',
          };
    database
      .prepare(
        `INSERT INTO jobs
          (id, kind, legacy_task_id, session_id, channel_id, schedule, action, delivery, enabled, sort_order, created_at, updated_at)
         VALUES (?, 'scheduled_task', ?, ?, ?, ?, ?, ?, 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      )
      .run(
        `task:${jobId}`,
        jobId,
        resolveSessionIdCompat(input.sessionId),
        input.channelId,
        JSON.stringify(schedule),
        JSON.stringify({ kind: 'agent_turn', message: input.prompt }),
        JSON.stringify({
          kind: 'channel',
          channel: 'session',
          to: input.channelId,
          webhookUrl: '',
        }),
        0,
      );
    return jobId;
  });
}

export function getJob(
  jobId: string | number,
  query: { kind: 'scheduler_job' },
): StoredSchedulerJob | null;
export function getJob(
  jobId: string | number,
  query: { kind: 'scheduled_task' },
): ScheduledTask | null;
export function getJob(jobId: string | number): StoredJob | null;
export function getJob(
  jobId: string | number,
  query?: { kind: StoredJobKind },
): StoredJob | null {
  return withMemoryDatabase((database) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) return null;
    const row = queryOne<JobRow>(
      database,
      `${rowSelectClause()} WHERE id = ?`,
      normalizedJobId,
    );
    if (!row) return null;
    if (query?.kind && row.kind !== query.kind) return null;
    return row.kind === 'scheduled_task'
      ? scheduledJobFromRow(row)
      : schedulerJobFromRow(row);
  });
}

export function getAllJobs(
  query: GetAllJobsQuery & { kind: 'scheduler_job' },
): StoredSchedulerJob[];
export function getAllJobs(
  query: GetAllJobsQuery & { kind: 'scheduled_task' },
): ScheduledTask[];
export function getAllJobs(query?: GetAllJobsQuery): StoredJob[];
export function getAllJobs(query: GetAllJobsQuery = {}): StoredJob[] {
  return withMemoryDatabase((database) => {
    if (query.kind === 'scheduler_job') {
      return listStoredSchedulerJobs(database);
    }
    if (query.kind === 'scheduled_task') {
      return listStoredScheduledTasks(database, query);
    }
    return [
      ...listStoredSchedulerJobs(database),
      ...listStoredScheduledTasks(database),
    ];
  });
}

export function upsertJob(job: RuntimeSchedulerJob): StoredSchedulerJob {
  return withMemoryDatabase((database) => {
    const jobId = job.id.trim();
    if (!jobId) throw new Error('Scheduler job requires a non-empty id.');
    const values = schedulerJobToDbValues({ ...job, id: jobId });
    const existing = queryOne<{ sort_order: number }>(
      database,
      "SELECT sort_order FROM jobs WHERE kind = 'scheduler_job' AND id = ?",
      jobId,
    );
    const sortOrder =
      existing?.sort_order ?? nextSchedulerJobSortOrder(database);
    database
      .prepare(
        `INSERT INTO jobs
          (id, kind, name, description, agent_id, board_status, max_retries, schedule, action, delivery, enabled, sort_order, created_at, updated_at)
         VALUES (?, 'scheduler_job', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           agent_id = excluded.agent_id,
           board_status = excluded.board_status,
           max_retries = excluded.max_retries,
           schedule = excluded.schedule,
           action = excluded.action,
           delivery = excluded.delivery,
           enabled = excluded.enabled,
           sort_order = jobs.sort_order,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(
        jobId,
        values.name,
        values.description,
        values.agentId,
        values.boardStatus,
        values.maxRetries,
        values.schedule,
        values.action,
        values.delivery,
        values.enabled,
        sortOrder,
      );
    return getJob(jobId) as StoredSchedulerJob;
  });
}

export function updateJob(job: RuntimeSchedulerJob): StoredSchedulerJob {
  if (!getJob(job.id, { kind: 'scheduler_job' })) {
    throw new Error(`Scheduler job \`${job.id}\` was not found.`);
  }
  return upsertJob(job);
}

export function replaceJobs(jobs: RuntimeSchedulerJob[]): void {
  withMemoryDatabase((database) => {
    const transaction = database.transaction(
      (nextJobs: RuntimeSchedulerJob[]) => {
        database.prepare("DELETE FROM jobs WHERE kind = 'scheduler_job'").run();
        const insert = database.prepare(
          `INSERT INTO jobs
          (id, kind, name, description, agent_id, board_status, max_retries, schedule, action, delivery, enabled, sort_order, created_at, updated_at)
         VALUES (?, 'scheduler_job', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        );
        nextJobs.forEach((job, index) => {
          const jobId = job.id.trim();
          if (!jobId) return;
          const values = schedulerJobToDbValues({ ...job, id: jobId });
          insert.run(
            jobId,
            values.name,
            values.description,
            values.agentId,
            values.boardStatus,
            values.maxRetries,
            values.schedule,
            values.action,
            values.delivery,
            values.enabled,
            index,
          );
        });
      },
    );
    transaction(jobs);
  });
}

export function reorderJob(jobId: string, beforeJobId?: string | null): void {
  withMemoryDatabase((database) => {
    const normalizedJobId = jobId.trim();
    if (!normalizedJobId) return;
    const normalizedBeforeJobId = beforeJobId?.trim() || null;
    const jobs = listStoredSchedulerJobs(database);
    const fromIndex = jobs.findIndex((job) => job.id === normalizedJobId);
    if (fromIndex < 0) return;
    const [job] = jobs.splice(fromIndex, 1);
    let insertIndex = jobs.length;
    if (normalizedBeforeJobId && normalizedBeforeJobId !== normalizedJobId) {
      const beforeIndex = jobs.findIndex(
        (candidate) => candidate.id === normalizedBeforeJobId,
      );
      if (beforeIndex >= 0) insertIndex = beforeIndex;
    }
    jobs.splice(insertIndex, 0, job);

    const updateOrder = database.prepare(
      "UPDATE jobs SET sort_order = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE kind = 'scheduler_job' AND id = ?",
    );
    const transaction = database.transaction(
      (orderedJobs: StoredSchedulerJob[]) => {
        for (const [index, orderedJob] of orderedJobs.entries()) {
          updateOrder.run(index, orderedJob.id);
        }
      },
    );
    transaction(jobs);
  });
}

export function deleteJob(jobId: string | number): void {
  withMemoryDatabase((database) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) return;
    database.prepare('DELETE FROM jobs WHERE id = ?').run(normalizedJobId);
  });
}

export function setJobEnabled(jobId: string | number, enabled: boolean): void {
  withMemoryDatabase((database) => {
    database
      .prepare(
        "UPDATE jobs SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(enabled ? 1 : 0, normalizeJobId(jobId));
  });
}

export function markJobRunStarted(jobId: string | number): void {
  withMemoryDatabase((database) => {
    database
      .prepare(
        "UPDATE jobs SET last_run = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(normalizeJobId(jobId));
  });
}

export function markJobSuccess(jobId: string | number): void {
  withMemoryDatabase((database) => {
    database
      .prepare(
        "UPDATE jobs SET last_status = ?, consecutive_errors = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run('success', normalizeJobId(jobId));
  });
}

export function markJobFailure(
  jobId: string | number,
  maxConsecutiveErrors = 5,
): { disabled: boolean; consecutiveErrors: number } {
  return withMemoryDatabase((database) => {
    const normalizedJobId = normalizeJobId(jobId);
    const row = queryOne<{ consecutive_errors: number }>(
      database,
      'SELECT consecutive_errors FROM jobs WHERE id = ?',
      normalizedJobId,
    );
    if (!row) {
      return { disabled: false, consecutiveErrors: 0 };
    }

    const nextCount = Math.max(0, Math.floor(row.consecutive_errors || 0)) + 1;
    const shouldDisable =
      nextCount >= Math.max(1, Math.floor(maxConsecutiveErrors));
    database
      .prepare(
        "UPDATE jobs SET last_status = ?, consecutive_errors = ?, enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run('error', nextCount, shouldDisable ? 0 : 1, normalizedJobId);
    return {
      disabled: shouldDisable,
      consecutiveErrors: nextCount,
    };
  });
}
