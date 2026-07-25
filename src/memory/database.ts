import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DB_PATH } from '../config/config.js';
import type { RuntimeSchedulerJob } from '../config/runtime-config.js';
import { runtimeConfigRevisionStorePath } from '../config/runtime-config-revisions.js';
import { logger } from '../logger.js';
import { DEFAULT_RESOURCE_HYGIENE_SCHEDULER_JOB } from '../scheduler/system-jobs.js';
import type { ScheduledTask } from '../types/scheduler.js';
import {
  type InitDatabaseOptions,
  runMigrations,
  tableExists,
} from './schema/migrations.js';
import { queryAll, queryOne } from './sqlite.js';

let db: Database.Database;
let databaseInitialized = false;

export function initDatabase(opts?: InitDatabaseOptions): void {
  const quiet = opts?.quiet === true;
  const dbPath = path.resolve(opts?.dbPath || DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // SQLite foreign-key enforcement is connection-scoped, so enable it before
  // running migrations or accepting writes on this writable connection.
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrations(db, opts);
  migrateLegacyTasksToJobsTable();
  ensureDefaultSchedulerJobs();
  databaseInitialized = true;
  if (!quiet) logger.info({ path: dbPath }, 'Database initialized');
}

export function isDatabaseInitialized(): boolean {
  return databaseInitialized;
}

function ensureDatabaseReady(): void {
  if (databaseInitialized) return;
  initDatabase({ quiet: true });
}

export function withMemoryDatabase<T>(
  fn: (database: Database.Database) => T,
): T {
  ensureDatabaseReady();
  return fn(db);
}

export function withInitializedMemoryDatabase<T>(
  fn: (database: Database.Database) => T,
): T {
  if (!databaseInitialized) {
    throw new Error('Database is not initialized');
  }
  return fn(db);
}

export function withMemoryDatabaseRuntimeRevisionStore<T>(
  fn: (database: Database.Database, revisionSchemaName: string) => T,
): T {
  ensureDatabaseReady();
  return withRuntimeRevisionDatabaseAttached(() =>
    fn(db, RUNTIME_REVISION_ATTACHMENT),
  );
}

const RUNTIME_REVISION_ATTACHMENT = 'runtime_revisions';

function withRuntimeRevisionDatabaseAttached<T>(fn: () => T): T {
  const revisionDbPath = runtimeConfigRevisionStorePath();
  fs.mkdirSync(path.dirname(revisionDbPath), { recursive: true });
  db.prepare(`ATTACH DATABASE ? AS ${RUNTIME_REVISION_ATTACHMENT}`).run(
    revisionDbPath,
  );
  try {
    return fn();
  } finally {
    db.exec(`DETACH DATABASE ${RUNTIME_REVISION_ATTACHMENT}`);
  }
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

function nextSchedulerJobSortOrder(): number {
  const row = queryOne<{ next_order: number | null }>(
    db,
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM jobs WHERE kind = 'scheduler_job'",
  );
  return Math.max(0, Math.floor(row?.next_order ?? 0));
}

function schedulerJobExists(jobId: string): boolean {
  const row = queryOne<{ id: string }, [string]>(
    db,
    "SELECT id FROM jobs WHERE kind = 'scheduler_job' AND id = ?",
    jobId,
  );
  return Boolean(row);
}

function upsertDefaultSchedulerJob(job: RuntimeSchedulerJob): void {
  const jobId = job.id.trim();
  if (!jobId) return;
  const values = schedulerJobToDbValues({ ...job, id: jobId });
  db.prepare(
    `INSERT INTO jobs
      (id, kind, name, description, agent_id, board_status, max_retries, schedule, action, delivery, enabled, sort_order, created_at, updated_at)
     VALUES (?, 'scheduler_job', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(id) DO NOTHING`,
  ).run(
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
    nextSchedulerJobSortOrder(),
  );
}

function ensureDefaultSchedulerJobs(): void {
  const defaults = [
    DEFAULT_RESOURCE_HYGIENE_SCHEDULER_JOB as RuntimeSchedulerJob,
  ];
  for (const job of defaults) {
    if (schedulerJobExists(job.id)) continue;
    upsertDefaultSchedulerJob(job);
  }
}

function migrateLegacyTasksToJobsTable(): void {
  if (!tableExists(db, 'tasks')) return;
  const legacyTasks = queryAll<ScheduledTask>(
    db,
    'SELECT * FROM tasks ORDER BY id ASC',
  );
  if (legacyTasks.length === 0) return;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO jobs
      (id, kind, legacy_task_id, session_id, channel_id, schedule, action, delivery,
       enabled, last_run, last_status, consecutive_errors, sort_order, created_at, updated_at)
     VALUES (?, 'scheduled_task', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  );
  const transaction = db.transaction((tasks: ScheduledTask[]) => {
    for (const task of tasks) {
      const schedule: RuntimeSchedulerJob['schedule'] = task.run_at
        ? { kind: 'at', at: task.run_at, everyMs: null, expr: null, tz: '' }
        : task.every_ms
          ? {
              kind: 'every',
              at: null,
              everyMs: task.every_ms,
              expr: null,
              tz: '',
            }
          : {
              kind: 'cron',
              at: null,
              everyMs: null,
              expr: task.cron_expr || '',
              tz: '',
            };
      insert.run(
        `task:${task.id}`,
        task.id,
        task.session_id,
        task.channel_id,
        JSON.stringify(schedule),
        JSON.stringify({ kind: 'agent_turn', message: task.prompt }),
        JSON.stringify({
          kind: 'channel',
          channel: 'session',
          to: task.channel_id,
          webhookUrl: '',
        }),
        task.enabled,
        task.last_run,
        task.last_status === 'success' || task.last_status === 'error'
          ? task.last_status
          : null,
        Math.max(0, Math.floor(task.consecutive_errors || 0)),
        0,
        task.created_at,
      );
    }
  });
  transaction(legacyTasks);
}
