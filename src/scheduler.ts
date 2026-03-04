/**
 * Scheduler — timer-based, arms for exact next-fire time.
 *
 * Runs both legacy DB-backed tasks and config-backed scheduler.jobs.
 */

import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, getConfigSnapshot } from './config.js';
import {
  deleteTask,
  getAllEnabledTasks,
  markTaskFailure,
  markTaskSuccess,
  updateTaskLastRun,
} from './db.js';
import { logger } from './logger.js';
import type { RuntimeSchedulerJob } from './runtime-config.js';
import type { ScheduledTask } from './types.js';

const MAX_TIMER_DELAY_MS = 300_000; // 5 min safety net for clock drift
const MAX_CONSECUTIVE_FAILURES = 5;
const CONFIG_ONESHOT_RETRY_MS = 60_000;
const SCHEDULER_STATE_VERSION = 1;
const SCHEDULER_STATE_PATH = path.join(DATA_DIR, 'scheduler-jobs-state.json');

export interface SchedulerDispatchRequest {
  source: 'db-task' | 'config-job';
  taskId?: number;
  jobId?: string;
  sessionId: string;
  channelId: string;
  prompt: string;
  actionKind: 'agent_turn' | 'system_event';
  delivery:
    | { kind: 'channel'; channelId: string }
    | { kind: 'last-channel' }
    | { kind: 'webhook'; webhookUrl: string };
}

type TaskRunner = (request: SchedulerDispatchRequest) => Promise<void>;

interface ConfigJobMeta {
  lastRun: string | null;
  lastStatus: 'success' | 'error' | null;
  consecutiveErrors: number;
  disabled: boolean;
  oneShotCompleted: boolean;
}

interface SchedulerStateFile {
  version: number;
  updatedAt: string;
  configJobs: Record<string, ConfigJobMeta>;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let taskRunner: TaskRunner | null = null;
let ticking = false;
const schedulerState: SchedulerStateFile = loadSchedulerState();

// --- Prompt framing ---

function formatFireTime(): string {
  return new Date().toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function wrapCronPrompt(jobLabel: string, message: string): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `[cron:${jobLabel}] ${message}\nCurrent time: ${formatFireTime()} (${tz})\n\nReturn your response as plain text; it will be delivered automatically. If the task explicitly calls for messaging a specific external recipient, note who/where it should go instead of sending it yourself.`;
}

function defaultConfigJobMeta(): ConfigJobMeta {
  return {
    lastRun: null,
    lastStatus: null,
    consecutiveErrors: 0,
    disabled: false,
    oneShotCompleted: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeConfigJobMeta(value: unknown): ConfigJobMeta {
  if (!isRecord(value)) return defaultConfigJobMeta();
  const lastRun =
    typeof value.lastRun === 'string' && value.lastRun.trim()
      ? value.lastRun.trim()
      : null;
  const lastStatus =
    value.lastStatus === 'success' || value.lastStatus === 'error'
      ? value.lastStatus
      : null;
  const consecutiveErrors =
    typeof value.consecutiveErrors === 'number' &&
    Number.isFinite(value.consecutiveErrors)
      ? Math.max(0, Math.floor(value.consecutiveErrors))
      : 0;
  return {
    lastRun,
    lastStatus,
    consecutiveErrors,
    disabled: Boolean(value.disabled),
    oneShotCompleted: Boolean(value.oneShotCompleted),
  };
}

function loadSchedulerState(): SchedulerStateFile {
  try {
    if (!fs.existsSync(SCHEDULER_STATE_PATH)) {
      return {
        version: SCHEDULER_STATE_VERSION,
        updatedAt: new Date(0).toISOString(),
        configJobs: {},
      };
    }
    const raw = fs.readFileSync(SCHEDULER_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error('state file root must be object');
    const rawJobs = isRecord(parsed.configJobs) ? parsed.configJobs : {};
    const configJobs: Record<string, ConfigJobMeta> = {};
    for (const [id, meta] of Object.entries(rawJobs)) {
      const key = id.trim();
      if (!key) continue;
      configJobs[key] = normalizeConfigJobMeta(meta);
    }
    return {
      version: SCHEDULER_STATE_VERSION,
      updatedAt:
        typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim()
          ? parsed.updatedAt
          : new Date(0).toISOString(),
      configJobs,
    };
  } catch (error) {
    logger.warn(
      { error },
      'Failed to load scheduler state file; starting with defaults',
    );
    return {
      version: SCHEDULER_STATE_VERSION,
      updatedAt: new Date(0).toISOString(),
      configJobs: {},
    };
  }
}

function persistSchedulerState(): void {
  try {
    fs.mkdirSync(path.dirname(SCHEDULER_STATE_PATH), { recursive: true });
    schedulerState.updatedAt = new Date().toISOString();
    const payload = `${JSON.stringify(schedulerState, null, 2)}\n`;
    const tmpPath = `${SCHEDULER_STATE_PATH}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, payload, 'utf-8');
    fs.renameSync(tmpPath, SCHEDULER_STATE_PATH);
  } catch (error) {
    logger.warn({ error }, 'Failed to persist scheduler state file');
  }
}

function getConfigJobMeta(jobId: string): ConfigJobMeta {
  const existing = schedulerState.configJobs[jobId];
  if (existing) return existing;
  const created = defaultConfigJobMeta();
  schedulerState.configJobs[jobId] = created;
  return created;
}

function pruneConfigJobMeta(activeJobs: RuntimeSchedulerJob[]): void {
  const activeIds = new Set(activeJobs.map((job) => job.id));
  let changed = false;
  for (const id of Object.keys(schedulerState.configJobs)) {
    if (activeIds.has(id)) continue;
    delete schedulerState.configJobs[id];
    changed = true;
  }
  if (changed) persistSchedulerState();
}

function parseCronExpression(
  expr: string,
  tz: string | undefined,
): ReturnType<typeof CronExpressionParser.parse> {
  const trimmedTz = tz?.trim();
  if (trimmedTz) {
    return CronExpressionParser.parse(expr, { tz: trimmedTz });
  }
  return CronExpressionParser.parse(expr);
}

function nextFireMsForDbTask(
  task: ScheduledTask,
  nowMs: number,
): number | null {
  if (task.run_at) {
    if (task.last_run) return null;
    const ms = new Date(task.run_at).getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (task.every_ms) {
    const lastRunMs = task.last_run ? new Date(task.last_run).getTime() : 0;
    return lastRunMs > 0 ? lastRunMs + task.every_ms : nowMs;
  }

  if (!task.cron_expr) return null;

  try {
    const ms = CronExpressionParser.parse(task.cron_expr)
      .next()
      .toDate()
      .getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function nextFireMsForConfigJob(
  job: RuntimeSchedulerJob,
  nowMs: number,
): number | null {
  if (!job.enabled) return null;
  const meta = getConfigJobMeta(job.id);
  if (meta.disabled) return null;

  if (job.schedule.kind === 'at') {
    if (meta.oneShotCompleted) return null;
    if (!job.schedule.at) return null;
    const atMs = new Date(job.schedule.at).getTime();
    if (!Number.isFinite(atMs)) return null;
    const lastRunMs = meta.lastRun ? new Date(meta.lastRun).getTime() : 0;
    if (atMs > nowMs) return atMs;
    if (lastRunMs <= 0) return atMs;
    return lastRunMs + CONFIG_ONESHOT_RETRY_MS;
  }

  if (job.schedule.kind === 'every') {
    if (!job.schedule.everyMs) return null;
    const lastRunMs = meta.lastRun ? new Date(meta.lastRun).getTime() : 0;
    return lastRunMs > 0 ? lastRunMs + job.schedule.everyMs : nowMs;
  }

  if (!job.schedule.expr) return null;
  try {
    const ms = parseCronExpression(
      job.schedule.expr,
      job.schedule.tz || undefined,
    )
      .next()
      .toDate()
      .getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function computeNextFireMs(nowMs = Date.now()): number | null {
  const dbTasks = getAllEnabledTasks();
  const cfgJobs = getConfigSnapshot().scheduler.jobs.filter(
    (job) => job.enabled,
  );
  pruneConfigJobMeta(cfgJobs);

  let earliest: number | null = null;

  for (const task of dbTasks) {
    const fireMs = nextFireMsForDbTask(task, nowMs);
    if (fireMs === null) continue;
    if (earliest === null || fireMs < earliest) earliest = fireMs;
  }

  for (const job of cfgJobs) {
    const fireMs = nextFireMsForConfigJob(job, nowMs);
    if (fireMs === null) continue;
    if (earliest === null || fireMs < earliest) earliest = fireMs;
  }

  return earliest;
}

function arm(): void {
  if (timer) clearTimeout(timer);
  timer = null;

  const nextFireMs = computeNextFireMs();
  if (nextFireMs === null) return;

  const delay = Math.max(nextFireMs - Date.now(), 0);
  const clamped = Math.min(delay, MAX_TIMER_DELAY_MS);

  logger.debug(
    { delayMs: clamped, nextFire: new Date(nextFireMs).toISOString() },
    'Scheduler armed',
  );

  timer = setTimeout(() => {
    void tick().catch((err) => {
      logger.error({ err }, 'Scheduler tick failed');
      arm();
    });
  }, clamped);
}

async function dispatchDbTask(task: ScheduledTask): Promise<void> {
  if (!taskRunner) return;
  const prompt = wrapCronPrompt(`#${task.id}`, task.prompt);
  await taskRunner({
    source: 'db-task',
    taskId: task.id,
    sessionId: task.session_id,
    channelId: task.channel_id,
    prompt,
    actionKind: 'agent_turn',
    delivery: {
      kind: 'channel',
      channelId: task.channel_id,
    },
  });
}

async function dispatchConfigJob(job: RuntimeSchedulerJob): Promise<void> {
  if (!taskRunner) return;
  const contextChannelId =
    job.delivery.kind === 'channel' ? job.delivery.to : 'scheduler';
  const prompt =
    job.action.kind === 'agent_turn'
      ? wrapCronPrompt(job.id, job.action.message)
      : job.action.message;
  await taskRunner({
    source: 'config-job',
    jobId: job.id,
    sessionId: `scheduler:${job.id}`,
    channelId: contextChannelId,
    prompt,
    actionKind: job.action.kind,
    delivery:
      job.delivery.kind === 'channel'
        ? { kind: 'channel', channelId: job.delivery.to }
        : job.delivery.kind === 'last-channel'
          ? { kind: 'last-channel' }
          : { kind: 'webhook', webhookUrl: job.delivery.webhookUrl },
  });
}

function markConfigJobSuccess(jobId: string, markOneShotDone = false): void {
  const meta = getConfigJobMeta(jobId);
  meta.lastStatus = 'success';
  meta.consecutiveErrors = 0;
  if (markOneShotDone) meta.oneShotCompleted = true;
  persistSchedulerState();
}

function markConfigJobFailure(jobId: string): {
  disabled: boolean;
  consecutiveErrors: number;
} {
  const meta = getConfigJobMeta(jobId);
  meta.lastStatus = 'error';
  meta.consecutiveErrors = Math.max(0, meta.consecutiveErrors) + 1;
  if (meta.consecutiveErrors >= MAX_CONSECUTIVE_FAILURES) {
    meta.disabled = true;
  }
  persistSchedulerState();
  return {
    disabled: meta.disabled,
    consecutiveErrors: meta.consecutiveErrors,
  };
}

async function tick(): Promise<void> {
  if (ticking) {
    arm();
    return;
  }
  ticking = true;

  try {
    const dbTasks = getAllEnabledTasks();
    const cfgJobs = getConfigSnapshot().scheduler.jobs;
    pruneConfigJobMeta(cfgJobs);

    const now = new Date();
    const nowMs = now.getTime();

    for (const task of dbTasks) {
      try {
        if (task.run_at) {
          const runAt = new Date(task.run_at);
          if (runAt.getTime() <= nowMs && !task.last_run) {
            logger.info(
              { taskId: task.id, runAt: task.run_at, prompt: task.prompt },
              'One-shot task firing',
            );
            updateTaskLastRun(task.id);
            dispatchDbTask(task)
              .then(() => {
                markTaskSuccess(task.id);
                deleteTask(task.id);
              })
              .catch((err) => {
                const failure = markTaskFailure(
                  task.id,
                  MAX_CONSECUTIVE_FAILURES,
                );
                logger.error(
                  { taskId: task.id, err },
                  'One-shot task failed (task preserved)',
                );
                if (failure.disabled) {
                  logger.warn(
                    {
                      taskId: task.id,
                      consecutiveErrors: failure.consecutiveErrors,
                    },
                    'Scheduled task auto-disabled after repeated failures',
                  );
                }
              });
          }
          continue;
        }

        if (task.every_ms) {
          const lastRunMs = task.last_run
            ? new Date(task.last_run).getTime()
            : 0;
          const dueAt = lastRunMs > 0 ? lastRunMs + task.every_ms : 0;
          if (dueAt <= nowMs) {
            logger.info(
              { taskId: task.id, everyMs: task.every_ms, prompt: task.prompt },
              'Interval task firing',
            );
            updateTaskLastRun(task.id);
            dispatchDbTask(task)
              .then(() => {
                markTaskSuccess(task.id);
              })
              .catch((err) => {
                const failure = markTaskFailure(
                  task.id,
                  MAX_CONSECUTIVE_FAILURES,
                );
                logger.error({ taskId: task.id, err }, 'Interval task failed');
                if (failure.disabled) {
                  logger.warn(
                    {
                      taskId: task.id,
                      consecutiveErrors: failure.consecutiveErrors,
                    },
                    'Scheduled task auto-disabled after repeated failures',
                  );
                }
              });
          }
          continue;
        }

        if (!task.cron_expr) continue;
        const cron = CronExpressionParser.parse(task.cron_expr);
        const prev = cron.prev();
        const lastRun = task.last_run ? new Date(task.last_run) : new Date(0);

        if (prev.toDate() > lastRun) {
          logger.info(
            { taskId: task.id, cron: task.cron_expr, prompt: task.prompt },
            'Cron task firing',
          );
          updateTaskLastRun(task.id);
          dispatchDbTask(task)
            .then(() => {
              markTaskSuccess(task.id);
            })
            .catch((err) => {
              const failure = markTaskFailure(
                task.id,
                MAX_CONSECUTIVE_FAILURES,
              );
              logger.error({ taskId: task.id, err }, 'Cron task failed');
              if (failure.disabled) {
                logger.warn(
                  {
                    taskId: task.id,
                    consecutiveErrors: failure.consecutiveErrors,
                  },
                  'Scheduled task auto-disabled after repeated failures',
                );
              }
            });
        }
      } catch (err) {
        logger.error(
          { taskId: task.id, cron: task.cron_expr, err },
          'Scheduler error for DB task',
        );
      }
    }

    for (const job of cfgJobs) {
      if (!job.enabled) continue;
      const meta = getConfigJobMeta(job.id);
      if (meta.disabled) continue;

      try {
        if (job.schedule.kind === 'at') {
          if (meta.oneShotCompleted || !job.schedule.at) continue;
          const runAtMs = new Date(job.schedule.at).getTime();
          if (!Number.isFinite(runAtMs) || runAtMs > nowMs) continue;
          const lastRunMs = meta.lastRun ? new Date(meta.lastRun).getTime() : 0;
          if (lastRunMs > 0 && nowMs - lastRunMs < CONFIG_ONESHOT_RETRY_MS)
            continue;
          meta.lastRun = now.toISOString();
          persistSchedulerState();
          logger.info(
            { jobId: job.id, runAt: job.schedule.at },
            'Config one-shot job firing',
          );
          dispatchConfigJob(job)
            .then(() => {
              markConfigJobSuccess(job.id, true);
            })
            .catch((err) => {
              const failure = markConfigJobFailure(job.id);
              logger.error(
                { jobId: job.id, err },
                'Config one-shot job failed',
              );
              if (failure.disabled) {
                logger.warn(
                  {
                    jobId: job.id,
                    consecutiveErrors: failure.consecutiveErrors,
                  },
                  'Config scheduler job auto-disabled after repeated failures',
                );
              }
            });
          continue;
        }

        if (job.schedule.kind === 'every') {
          const everyMs = job.schedule.everyMs;
          if (!everyMs) continue;
          const lastRunMs = meta.lastRun ? new Date(meta.lastRun).getTime() : 0;
          const dueAt = lastRunMs > 0 ? lastRunMs + everyMs : 0;
          if (dueAt > nowMs) continue;
          meta.lastRun = now.toISOString();
          persistSchedulerState();
          logger.info({ jobId: job.id, everyMs }, 'Config interval job firing');
          dispatchConfigJob(job)
            .then(() => {
              markConfigJobSuccess(job.id, false);
            })
            .catch((err) => {
              const failure = markConfigJobFailure(job.id);
              logger.error(
                { jobId: job.id, err },
                'Config interval job failed',
              );
              if (failure.disabled) {
                logger.warn(
                  {
                    jobId: job.id,
                    consecutiveErrors: failure.consecutiveErrors,
                  },
                  'Config scheduler job auto-disabled after repeated failures',
                );
              }
            });
          continue;
        }

        if (!job.schedule.expr) continue;
        const cron = parseCronExpression(
          job.schedule.expr,
          job.schedule.tz || undefined,
        );
        const prev = cron.prev().toDate();
        const lastRun = meta.lastRun ? new Date(meta.lastRun) : new Date(0);
        if (prev <= lastRun) continue;

        meta.lastRun = now.toISOString();
        persistSchedulerState();
        logger.info(
          { jobId: job.id, expr: job.schedule.expr, tz: job.schedule.tz },
          'Config cron job firing',
        );
        dispatchConfigJob(job)
          .then(() => {
            markConfigJobSuccess(job.id, false);
          })
          .catch((err) => {
            const failure = markConfigJobFailure(job.id);
            logger.error({ jobId: job.id, err }, 'Config cron job failed');
            if (failure.disabled) {
              logger.warn(
                { jobId: job.id, consecutiveErrors: failure.consecutiveErrors },
                'Config scheduler job auto-disabled after repeated failures',
              );
            }
          });
      } catch (err) {
        logger.error({ jobId: job.id, err }, 'Scheduler error for config job');
      }
    }
  } finally {
    ticking = false;
    arm();
  }
}

// --- Public API ---

export function startScheduler(runner: TaskRunner): void {
  logger.info('Scheduler started');
  taskRunner = runner;
  arm();
}

/**
 * Re-arm the scheduler timer. Call after creating/deleting tasks or updating config scheduler jobs.
 */
export function rearmScheduler(): void {
  if (taskRunner) arm();
}

export function stopScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  taskRunner = null;
  logger.info('Scheduler stopped');
}
