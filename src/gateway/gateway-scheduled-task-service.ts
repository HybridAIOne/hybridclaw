import { CronExpressionParser } from 'cron-parser';
import { resolveAgentForRequest } from '../agents/agent-registry.js';
import { HYBRIDAI_CHATBOT_ID, HYBRIDAI_MODEL } from '../config/config.js';
import {
  DEFAULT_ONE_SHOT_MAX_RETRIES,
  getRuntimeConfig,
  parseSchedulerBoardStatus,
  type RuntimeConfig,
  type SchedulerBoardStatus,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { logger } from '../logger.js';
import {
  deleteTask,
  getAllTasks,
  getSessionById,
  pauseTask,
  resumeTask,
  updateSessionAgent,
} from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import { modelRequiresChatbotId } from '../providers/factory.js';
import { runIsolatedScheduledTask } from '../scheduler/scheduled-task-runner.js';
import {
  getScheduledTaskNextRunAt,
  getSchedulerStatus,
  parseSchedulerTimestampMs,
  pauseConfigJob,
  rearmScheduler,
  resetConfigJobRuntime,
  resumeConfigJob,
} from '../scheduler/scheduler.js';
import type { SessionResetPolicy } from '../session/session-reset.js';
import type { ProactiveMessagePayload } from './fullauto-runtime.js';
import {
  prepareSessionAutoReset,
  resolveGatewayChatbotId,
  resolveSessionAutoResetPolicy,
} from './gateway-service.js';
import type {
  GatewayAdminSchedulerJob,
  GatewayAdminSchedulerResponse,
} from './gateway-types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRunOnceScheduleKind(
  kind: RuntimeConfig['scheduler']['jobs'][number]['schedule']['kind'],
): boolean {
  return kind === 'at' || kind === 'one_shot';
}

function parseAdminSchedulerJob(
  value: unknown,
): RuntimeConfig['scheduler']['jobs'][number] {
  if (!isRecord(value)) {
    throw new Error('Expected object `job`.');
  }

  const id = String(value.id || '').trim();
  if (!id) {
    throw new Error('Scheduler job requires a non-empty `id`.');
  }

  const name = String(value.name || '').trim();
  const description = String(value.description || '').trim();
  const agentId = String(value.agentId || '').trim();
  const boardStatus = parseSchedulerBoardStatus(value.boardStatus);
  const rawSchedule = isRecord(value.schedule) ? value.schedule : {};
  const rawAction = isRecord(value.action) ? value.action : {};
  const rawDelivery = isRecord(value.delivery) ? value.delivery : {};

  const scheduleKind = String(rawSchedule.kind || 'cron')
    .trim()
    .toLowerCase();
  if (
    scheduleKind !== 'cron' &&
    scheduleKind !== 'every' &&
    scheduleKind !== 'at' &&
    scheduleKind !== 'one_shot'
  ) {
    throw new Error(
      'Scheduler schedule kind must be `cron`, `every`, `at`, or `one_shot`.',
    );
  }

  let at: string | null = null;
  let everyMs: number | null = null;
  let expr: string | null = null;
  let maxRetries: number | null = null;
  if (scheduleKind === 'at') {
    at = String(rawSchedule.at || '').trim();
    const parsedAt = new Date(at);
    if (!at || Number.isNaN(parsedAt.getTime())) {
      throw new Error('`schedule.at` must be a valid ISO timestamp.');
    }
    at = parsedAt.toISOString();
  } else if (scheduleKind === 'every') {
    const parsedEveryMs =
      typeof rawSchedule.everyMs === 'number'
        ? rawSchedule.everyMs
        : Number.parseInt(String(rawSchedule.everyMs || ''), 10);
    if (!Number.isFinite(parsedEveryMs) || parsedEveryMs < 10_000) {
      throw new Error('`schedule.everyMs` must be at least 10000.');
    }
    everyMs = Math.floor(parsedEveryMs);
  } else if (scheduleKind === 'one_shot') {
    const parsedMaxRetries =
      typeof value.maxRetries === 'number'
        ? value.maxRetries
        : Number.parseInt(String(value.maxRetries || ''), 10);
    if (
      Number.isFinite(parsedMaxRetries) &&
      Math.floor(parsedMaxRetries) >= 0 &&
      Math.floor(parsedMaxRetries) <= 100
    ) {
      maxRetries = Math.floor(parsedMaxRetries);
    } else if (String(value.maxRetries || '').trim()) {
      throw new Error('`maxRetries` must be an integer between 0 and 100.');
    } else {
      maxRetries = DEFAULT_ONE_SHOT_MAX_RETRIES;
    }
  } else {
    expr = String(rawSchedule.expr || '').trim();
    if (!expr) {
      throw new Error('`schedule.expr` is required for cron jobs.');
    }
    try {
      CronExpressionParser.parse(expr);
    } catch {
      throw new Error(`\`${expr}\` is not a valid cron expression.`);
    }
  }

  const actionKind = String(rawAction.kind || 'agent_turn')
    .trim()
    .toLowerCase();
  if (actionKind !== 'agent_turn' && actionKind !== 'system_event') {
    throw new Error(
      'Scheduler action kind must be `agent_turn` or `system_event`.',
    );
  }
  const actionMessage = String(rawAction.message || '').trim() || description;
  if (!actionMessage) {
    throw new Error('`action.message` or `description` is required.');
  }

  const deliveryKind = String(rawDelivery.kind || 'channel')
    .trim()
    .toLowerCase();
  if (
    deliveryKind !== 'channel' &&
    deliveryKind !== 'last-channel' &&
    deliveryKind !== 'webhook'
  ) {
    throw new Error(
      'Scheduler delivery kind must be `channel`, `last-channel`, or `webhook`.',
    );
  }
  const deliveryTo = String(rawDelivery.to || '').trim();
  const webhookUrl = String(rawDelivery.webhookUrl || '').trim();
  if (deliveryKind === 'channel' && !deliveryTo) {
    throw new Error('`delivery.to` is required for channel deliveries.');
  }
  if (deliveryKind === 'webhook' && !webhookUrl) {
    throw new Error(
      '`delivery.webhookUrl` is required for webhook deliveries.',
    );
  }

  return {
    id,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(agentId ? { agentId } : {}),
    ...(boardStatus || scheduleKind === 'one_shot'
      ? { boardStatus: boardStatus || 'backlog' }
      : {}),
    ...(maxRetries != null ? { maxRetries } : {}),
    schedule: {
      kind: scheduleKind,
      at,
      everyMs,
      expr,
      tz: String(rawSchedule.tz || '').trim(),
    },
    action: {
      kind: actionKind,
      message: actionMessage,
    },
    delivery: {
      kind: deliveryKind,
      channel: String(rawDelivery.channel || 'discord').trim() || 'discord',
      to: deliveryTo,
      webhookUrl,
    },
    enabled: value.enabled !== false,
  };
}

function compareGatewayAdminSchedulerJobs(
  left: GatewayAdminSchedulerJob,
  right: GatewayAdminSchedulerJob,
): number {
  if (left.nextRunAt && right.nextRunAt) {
    const delta =
      new Date(left.nextRunAt).getTime() - new Date(right.nextRunAt).getTime();
    if (delta !== 0) return delta;
  } else if (left.nextRunAt) {
    return -1;
  } else if (right.nextRunAt) {
    return 1;
  }

  if (left.createdAt && right.createdAt) {
    const delta =
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    if (delta !== 0) return delta;
  } else if (left.createdAt) {
    return -1;
  } else if (right.createdAt) {
    return 1;
  }

  return left.name.localeCompare(right.name);
}

export function getGatewayAdminScheduler(): GatewayAdminSchedulerResponse {
  const runtimeConfig = getRuntimeConfig();
  const statuses = new Map(
    getSchedulerStatus().map((job) => [job.id, job] as const),
  );
  const nowMs = Date.now();

  return {
    jobs: [
      ...runtimeConfig.scheduler.jobs.map((job) => {
        const runtime = statuses.get(job.id);
        const session = getSessionById(`scheduler:${job.id}`);
        return {
          id: job.id,
          source: 'config',
          name:
            (typeof job.name === 'string' && job.name.trim()) ||
            runtime?.name ||
            job.id,
          description:
            (typeof job.description === 'string' && job.description.trim()) ||
            runtime?.description ||
            null,
          agentId: job.agentId ?? null,
          boardStatus: job.boardStatus ?? null,
          maxRetries:
            typeof job.maxRetries === 'number' ? job.maxRetries : null,
          enabled: job.enabled,
          schedule: job.schedule,
          action: job.action,
          delivery: job.delivery,
          lastRun: runtime?.lastRun || null,
          lastStatus: runtime?.lastStatus || null,
          nextRunAt: runtime?.nextRunAt || null,
          disabled: runtime?.disabled || false,
          consecutiveErrors: runtime?.consecutiveErrors || 0,
          createdAt: null,
          sessionId: session?.id || null,
          channelId:
            job.delivery.kind === 'channel'
              ? job.delivery.to
              : job.delivery.kind === 'last-channel'
                ? 'last-channel'
                : null,
          taskId: null,
        } satisfies GatewayAdminSchedulerJob;
      }),
      ...getAllTasks()
        .map((task) => {
          const normalizedPrompt = task.prompt.replace(/\s+/g, ' ').trim();
          const createdAtMs = parseSchedulerTimestampMs(task.created_at);
          const lastStatus =
            task.last_status === 'success' || task.last_status === 'error'
              ? task.last_status
              : null;

          return {
            id: `task:${task.id}`,
            source: 'task',
            name:
              normalizedPrompt.length > 72
                ? `${normalizedPrompt.slice(0, 69).trimEnd()}...`
                : normalizedPrompt || `Task #${task.id}`,
            description: `#${task.id}`,
            agentId: null,
            boardStatus: null,
            maxRetries: null,
            enabled: Boolean(task.enabled),
            schedule: task.run_at
              ? {
                  kind: 'at',
                  at: task.run_at,
                  everyMs: null,
                  expr: null,
                  tz: '',
                }
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
                    expr: task.cron_expr || null,
                    tz: '',
                  },
            action: {
              kind: 'agent_turn',
              message: task.prompt,
            },
            delivery: {
              kind: 'channel',
              channel: 'session',
              to: task.channel_id,
              webhookUrl: '',
            },
            lastRun: task.last_run,
            lastStatus,
            nextRunAt: getScheduledTaskNextRunAt(task, nowMs),
            disabled: !task.enabled,
            consecutiveErrors: Math.max(0, task.consecutive_errors || 0),
            createdAt:
              createdAtMs == null
                ? task.created_at || null
                : new Date(createdAtMs).toISOString(),
            sessionId: task.session_id,
            channelId: task.channel_id,
            taskId: task.id,
          } satisfies GatewayAdminSchedulerJob;
        })
        .sort(compareGatewayAdminSchedulerJobs),
    ],
  };
}

export function upsertGatewayAdminSchedulerJob(input: {
  job: unknown;
}): GatewayAdminSchedulerResponse {
  const job = parseAdminSchedulerJob(input.job);
  const previousJob =
    getRuntimeConfig().scheduler.jobs.find((entry) => entry.id === job.id) ||
    null;

  updateRuntimeConfig((draft) => {
    const existingIndex = draft.scheduler.jobs.findIndex(
      (entry) => entry.id === job.id,
    );
    if (existingIndex >= 0) {
      draft.scheduler.jobs[existingIndex] = job;
      return;
    }
    draft.scheduler.jobs.push(job);
  });

  if (
    previousJob &&
    isRunOnceScheduleKind(job.schedule.kind) &&
    job.boardStatus === 'backlog' &&
    (previousJob.boardStatus !== 'backlog' ||
      previousJob.schedule.kind !== job.schedule.kind)
  ) {
    resetConfigJobRuntime(job.id);
  }
  if (job.enabled) {
    resumeConfigJob(job.id);
  }
  rearmScheduler();
  return getGatewayAdminScheduler();
}

export function removeGatewayAdminSchedulerJob(
  jobId: string,
  source: 'config' | 'task' = 'config',
): GatewayAdminSchedulerResponse {
  if (source === 'task') {
    const taskId = Number.parseInt(jobId, 10);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      throw new Error('Expected numeric scheduler `taskId`.');
    }
    deleteTask(taskId);
    rearmScheduler();
    return getGatewayAdminScheduler();
  }

  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) {
    throw new Error('Expected non-empty scheduler `jobId`.');
  }

  updateRuntimeConfig((draft) => {
    draft.scheduler.jobs = draft.scheduler.jobs.filter(
      (job) => job.id !== normalizedJobId,
    );
  });
  rearmScheduler();
  return getGatewayAdminScheduler();
}

export function setGatewayAdminSchedulerJobPaused(params: {
  jobId: string;
  paused: boolean;
  source?: 'config' | 'task';
}): GatewayAdminSchedulerResponse {
  if (params.source === 'task') {
    const taskId = Number.parseInt(params.jobId, 10);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      throw new Error('Expected numeric scheduler `taskId`.');
    }
    if (params.paused) {
      pauseTask(taskId);
    } else {
      resumeTask(taskId);
    }
    rearmScheduler();
    return getGatewayAdminScheduler();
  }

  const normalizedJobId = params.jobId.trim();
  if (!normalizedJobId) {
    throw new Error('Expected non-empty scheduler `jobId`.');
  }

  const ok = params.paused
    ? pauseConfigJob(normalizedJobId)
    : resumeConfigJob(normalizedJobId);
  if (!ok) {
    throw new Error(`Scheduler job \`${normalizedJobId}\` was not found.`);
  }
  return getGatewayAdminScheduler();
}

export function moveGatewayAdminSchedulerJob(params: {
  jobId: string;
  beforeJobId?: string | null;
  boardStatus?: SchedulerBoardStatus | null;
}): GatewayAdminSchedulerResponse {
  const normalizedJobId = params.jobId.trim();
  if (!normalizedJobId) {
    throw new Error('Expected non-empty scheduler `jobId`.');
  }
  const normalizedBeforeJobId = String(params.beforeJobId || '').trim() || null;
  const existingJob =
    getRuntimeConfig().scheduler.jobs.find(
      (job) => job.id === normalizedJobId,
    ) || null;
  if (!existingJob) {
    throw new Error(`Scheduler job \`${normalizedJobId}\` was not found.`);
  }

  updateRuntimeConfig((draft) => {
    const fromIndex = draft.scheduler.jobs.findIndex(
      (job) => job.id === normalizedJobId,
    );
    if (fromIndex < 0) return;
    const [job] = draft.scheduler.jobs.splice(fromIndex, 1);
    if ('boardStatus' in params) {
      if (params.boardStatus === null) {
        delete job.boardStatus;
      } else {
        job.boardStatus = params.boardStatus;
      }
    }
    let insertIndex = draft.scheduler.jobs.length;
    if (normalizedBeforeJobId && normalizedBeforeJobId !== normalizedJobId) {
      const beforeIndex = draft.scheduler.jobs.findIndex(
        (candidate) => candidate.id === normalizedBeforeJobId,
      );
      if (beforeIndex >= 0) {
        insertIndex = beforeIndex;
      }
    }
    draft.scheduler.jobs.splice(insertIndex, 0, job);
  });

  if (
    params.boardStatus === 'backlog' &&
    isRunOnceScheduleKind(existingJob.schedule.kind) &&
    existingJob.boardStatus !== 'backlog'
  ) {
    resetConfigJobRuntime(normalizedJobId);
  }
  rearmScheduler();
  return getGatewayAdminScheduler();
}

export async function runGatewayScheduledTask(
  origSessionId: string,
  channelId: string,
  prompt: string,
  taskId: number,
  onResult: (result: ProactiveMessagePayload) => Promise<void>,
  onError: (error: unknown) => void,
  runKey?: string,
  preferredAgentId?: string,
): Promise<void> {
  let currentSessionId = origSessionId;
  const sessionResetPolicy = {
    ...resolveSessionAutoResetPolicy(channelId),
    mode: 'none',
  } satisfies SessionResetPolicy;
  const expiryEvaluation = await prepareSessionAutoReset({
    sessionId: currentSessionId,
    channelId,
    policy: sessionResetPolicy,
  });
  const autoResetSession = memoryService.resetSessionIfExpired(
    currentSessionId,
    {
      policy: sessionResetPolicy,
      expiryEvaluation,
    },
  );
  if (autoResetSession) {
    currentSessionId = autoResetSession.id;
  }
  const session = memoryService.getOrCreateSession(
    currentSessionId,
    null,
    channelId,
    preferredAgentId,
  );
  if (preferredAgentId && session.agent_id !== preferredAgentId) {
    updateSessionAgent(session.id, preferredAgentId);
  }
  const {
    agentId,
    chatbotId: requestedChatbotId,
    model,
  } = resolveAgentForRequest({
    session,
    agentId: preferredAgentId,
  });
  const chatbotResolution = await resolveGatewayChatbotId({
    model,
    chatbotId: requestedChatbotId,
    sessionId: currentSessionId,
    channelId,
    agentId,
    trigger: 'scheduler',
    taskId,
  });
  const chatbotId = chatbotResolution.chatbotId;
  if (modelRequiresChatbotId(model) && !chatbotId) {
    logger.warn(
      {
        sessionId: currentSessionId,
        channelId,
        taskId,
        model,
        sessionModel: session.model ?? null,
        sessionChatbotId: session.chatbot_id ?? null,
        defaultModel: HYBRIDAI_MODEL,
        defaultChatbotConfigured: Boolean(HYBRIDAI_CHATBOT_ID),
        fallbackSource: chatbotResolution.source,
        resolutionError: chatbotResolution.error ?? null,
      },
      'Scheduled task skipped due to missing chatbot configuration',
    );
    return;
  }

  await runIsolatedScheduledTask({
    taskId,
    prompt,
    channelId,
    chatbotId,
    model,
    agentId,
    sessionId: session.id,
    sessionKey: runKey,
    mainSessionKey: session.main_session_key,
    onResult,
    onError,
  });
}
