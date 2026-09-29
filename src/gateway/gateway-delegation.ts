/**
 * Delegation — schedules `delegate` plans for a parent session.
 *
 * A waiting call (`/api/delegate`) returns the child reports as the parent's
 * tool result. A background batch runs after the turn and then wakes the
 * parent with a hidden results turn, unless that session was reset meanwhile.
 *
 * NOT A2A: peer-agent delegation across instances lives in `src/a2a/`.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { enqueueDelegation } from '../agent/delegation-manager.js';
import { isSilentReply } from '../agent/silent-reply.js';
import { resolveAgentForRequest } from '../agents/agent-registry.js';
import { PROACTIVE_DELEGATION_MAX_DEPTH } from '../config/config.js';
import { logger } from '../logger.js';
import {
  completeDelegationJob,
  createDelegationJob,
  enqueueProactiveMessage,
  failDelegationJob,
  getDelegationJob,
  markDelegationJobInProgress,
} from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import { appendSessionTranscript } from '../session/session-transcripts.js';
import type { ArtifactMetadata } from '../types/execution.js';
import type { DelegationSideEffect } from '../types/side-effects.js';
import { runDelegationTaskWithRetry } from './delegation-child-run.js';
import {
  formatDelegationCompletion,
  formatDelegationStatus,
  formatDelegationToolDetail,
} from './delegation-format.js';
import {
  type DelegationCompletionEntry,
  type DelegationStatusEntry,
  delegationSessionPrefix,
  extractDelegationDepth,
  interpolateChainPrompt,
  type NormalizedDelegationPlan,
  type NormalizedDelegationTask,
  normalizeDelegationEffect,
  renderDelegationTaskTitle,
} from './delegation-plan.js';
import { buildDelegationResultsMessage } from './delegation-results-message.js';
import type { ProactiveMessagePayload } from './fullauto-runtime.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';
import { notifyWebSession } from './web-notifications.js';

const MAX_QUEUED_DELEGATION_MESSAGES = 500;
const DELEGATION_STREAM_DELTA_FLUSH_CHARS = 96;

function queueDelegationProactiveMessage(params: {
  parentSessionId: string;
  channelId: string;
  text: string;
  artifactCount: number;
  source?: string;
}): void {
  const { queued, dropped } = enqueueProactiveMessage(
    params.channelId,
    params.text,
    params.source || 'delegate',
    MAX_QUEUED_DELEGATION_MESSAGES,
  );
  logger.info(
    {
      parentSessionId: params.parentSessionId,
      channelId: params.channelId,
      queued,
      dropped,
      artifactCount: params.artifactCount,
    },
    'Delegation proactive message queued',
  );
  if (params.artifactCount > 0) {
    logger.warn(
      {
        parentSessionId: params.parentSessionId,
        channelId: params.channelId,
        artifactCount: params.artifactCount,
      },
      'Queued delegation message does not persist attachments; only text was queued',
    );
  }
}

function createParentReplyStream(params: {
  parentSessionId: string;
  channelId: string;
}): {
  onTextDelta: (delta: string) => void;
  finish: () => void;
  started: () => boolean;
  text: () => string;
} {
  let hasStarted = false;
  let hasFinished = false;
  let buffer = '';
  let streamedText = '';

  const queue = (source: string, text: string): void => {
    queueDelegationProactiveMessage({
      parentSessionId: params.parentSessionId,
      channelId: params.channelId,
      text,
      artifactCount: 0,
      source,
    });
  };

  const ensureStarted = (): void => {
    if (hasStarted) return;
    hasStarted = true;
    queue('delegate:stream:start', '');
  };

  const flush = (): void => {
    if (!buffer) return;
    ensureStarted();
    queue('delegate:stream:delta', buffer);
    buffer = '';
  };

  return {
    onTextDelta: (delta: string) => {
      const text = String(delta || '');
      if (!text) return;
      streamedText += text;
      buffer += text;
      if (
        buffer.length >= DELEGATION_STREAM_DELTA_FLUSH_CHARS ||
        buffer.endsWith('\n')
      ) {
        flush();
      }
    },
    finish: () => {
      if (hasFinished) return;
      hasFinished = true;
      if (!hasStarted && !buffer) return;
      flush();
      queue('delegate:stream:end', '');
    },
    started: () => hasStarted,
    text: () => streamedText,
  };
}

async function publishDelegationLifecycleMessage(params: {
  parentSessionId: string;
  channelId: string;
  text: string;
  artifacts?: ArtifactMetadata[];
  onProactiveMessage?: (
    message: ProactiveMessagePayload,
  ) => void | Promise<void>;
}): Promise<void> {
  const text = params.text.trim();
  if (!text) return;
  const artifactCount = params.artifacts?.length || 0;

  if (params.onProactiveMessage) {
    try {
      await params.onProactiveMessage({
        text,
        artifacts: params.artifacts,
      });
      return;
    } catch (err) {
      logger.warn(
        {
          parentSessionId: params.parentSessionId,
          channelId: params.channelId,
          err,
        },
        'Delegation proactive callback failed; falling back to queue',
      );
    }
  }

  queueDelegationProactiveMessage({
    parentSessionId: params.parentSessionId,
    channelId: params.channelId,
    text,
    artifactCount,
  });
}

/** Stores the plain completion summary when the parent turn could not run. */
function storeDelegationFallback(params: {
  parentSessionId: string;
  channelId: string;
  agentId: string;
  text: string;
  artifacts?: ArtifactMetadata[];
}): void {
  const { parentSessionId, channelId, agentId, text, artifacts } = params;
  memoryService.storeMessage({
    sessionId: parentSessionId,
    userId: 'assistant',
    username: null,
    role: 'assistant',
    content: text,
    agentId,
    artifacts: artifacts?.length ? artifacts : null,
  });
  appendSessionTranscript(agentId, {
    sessionId: parentSessionId,
    channelId,
    role: 'assistant',
    userId: 'assistant',
    username: null,
    content: text,
  });
}

interface DelegationRunContext {
  parentSessionId: string;
  childDepth: number;
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  abortSignal?: AbortSignal;
}

interface DelegationChildContext {
  sessionPrefix: string;
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  model: string;
}

// Children are not stored sessions; a waiting `delegate` call from inside one
// resolves its parent context here. One entry per run: a parent may have
// several runs in flight.
const activeChildContexts = new Set<DelegationChildContext>();

function buildStatusEntries(
  plans: NormalizedDelegationPlan[],
): DelegationStatusEntry[][] {
  return plans.map((plan) =>
    plan.tasks.map((task, index) => ({
      title: renderDelegationTaskTitle(
        plan.mode,
        task,
        index,
        plan.tasks.length,
      ),
      model: task.model,
      status: 'queued',
      toolUses: 0,
    })),
  );
}

function resolveBatchLabel(
  plans: NormalizedDelegationPlan[],
): string | undefined {
  if (plans.length === 1) return plans[0]?.label;
  return (
    plans
      .map((plan) => plan.label)
      .filter(Boolean)
      .join(', ') || undefined
  );
}

async function runDelegationPlans(params: {
  plans: NormalizedDelegationPlan[];
  context: DelegationRunContext;
  statusEntriesByPlan: DelegationStatusEntry[][];
  publishStatus?: () => Promise<void>;
}): Promise<DelegationCompletionEntry[]> {
  const { plans, context, statusEntriesByPlan } = params;
  const publishStatus = params.publishStatus ?? (async () => {});

  const runTask = async (taskParams: {
    plan: NormalizedDelegationPlan;
    task: NormalizedDelegationTask;
    statusEntry: DelegationStatusEntry;
    prompt?: string;
  }): Promise<DelegationCompletionEntry> => {
    const { plan, task, statusEntry, prompt } = taskParams;
    statusEntry.status = 'running';
    await publishStatus();
    const run = await runDelegationTaskWithRetry({
      ...context,
      mode: plan.mode,
      task: prompt ? { ...task, prompt } : task,
      onToolProgress: (event) => {
        if (event.phase === 'finish') {
          statusEntry.toolUses += 1;
          statusEntry.lastTool = statusEntry.currentTool ?? event.toolName;
          statusEntry.lastToolDetail = statusEntry.currentToolDetail;
          statusEntry.currentTool = undefined;
          statusEntry.currentToolDetail = undefined;
          void publishStatus();
          return;
        }
        statusEntry.currentTool = event.toolName;
        statusEntry.currentToolDetail = formatDelegationToolDetail(event);
        void publishStatus();
      },
    });
    statusEntry.status = run.status;
    statusEntry.currentTool = undefined;
    statusEntry.currentToolDetail = undefined;
    statusEntry.lastTool = undefined;
    statusEntry.lastToolDetail = undefined;
    statusEntry.toolUses = Math.max(statusEntry.toolUses, run.toolsUsed.length);
    statusEntry.tokenCount = run.tokenCount;
    await publishStatus();
    return { title: statusEntry.title, run };
  };

  const runPlan = async (
    plan: NormalizedDelegationPlan,
    planIndex: number,
  ): Promise<DelegationCompletionEntry[]> => {
    const planStatusEntries = statusEntriesByPlan[planIndex] || [];
    if (plan.mode === 'parallel') {
      return Promise.all(
        plan.tasks.map(async (task, index) =>
          runTask({ plan, task, statusEntry: planStatusEntries[index] }),
        ),
      );
    }

    if (plan.mode === 'chain') {
      const planEntries: DelegationCompletionEntry[] = [];
      let previousResult = '';
      for (let i = 0; i < plan.tasks.length; i++) {
        const task = plan.tasks[i];
        const entry = await runTask({
          plan,
          task,
          statusEntry: planStatusEntries[i],
          prompt: interpolateChainPrompt(task.prompt, previousResult),
        });
        planEntries.push(entry);
        if (entry.run.status !== 'completed') break;
        previousResult = entry.run.result || '';
      }
      return planEntries;
    }

    return [
      await runTask({
        plan,
        task: plan.tasks[0],
        statusEntry: planStatusEntries[0],
      }),
    ];
  };

  const planEntries = await Promise.all(
    plans.map(async (plan, planIndex) => runPlan(plan, planIndex)),
  );
  return planEntries.flat();
}

async function withActiveChildContext<T>(
  context: DelegationRunContext,
  plans: NormalizedDelegationPlan[],
  run: () => Promise<T>,
): Promise<T> {
  const entry: DelegationChildContext = {
    sessionPrefix: delegationSessionPrefix(
      context.parentSessionId,
      context.childDepth,
    ),
    channelId: context.channelId,
    chatbotId: context.chatbotId,
    enableRag: context.enableRag,
    agentId: context.agentId,
    model: plans[0]?.tasks[0]?.model || '',
  };
  activeChildContexts.add(entry);
  try {
    return await run();
  } finally {
    activeChildContexts.delete(entry);
  }
}

/** Runs the parent turn that receives finished delegate results. */
export type DelegationParentTurnRunner = (params: {
  content: string;
  onTextDelta?: (delta: string) => void;
}) => Promise<{
  status: 'success' | 'error';
  result: string | null;
  artifacts?: ArtifactMetadata[];
}>;

export function enqueueDelegationBatchFromSideEffects(params: {
  plans: NormalizedDelegationPlan[];
  parentSessionId: string;
  channelId: string;
  chatbotId: string;
  enableRag: boolean;
  agentId: string;
  parentModel?: string;
  onProactiveMessage?: (
    message: ProactiveMessagePayload,
  ) => void | Promise<void>;
  parentDepth: number;
  runParentTurn: DelegationParentTurnRunner;
  publicId?: string;
  ackText?: string;
}): { publicId: string } | null {
  const {
    plans,
    parentSessionId,
    channelId,
    chatbotId,
    enableRag,
    agentId,
    parentModel,
    onProactiveMessage,
    parentDepth,
    runParentTurn,
    publicId: requestedPublicId,
    ackText,
  } = params;
  const activePlans = plans.filter((plan) => plan.tasks.length > 0);
  if (activePlans.length === 0) return null;
  const childDepth = parentDepth + 1;
  if (childDepth > PROACTIVE_DELEGATION_MAX_DEPTH) {
    logger.info(
      { parentSessionId, childDepth, maxDepth: PROACTIVE_DELEGATION_MAX_DEPTH },
      'Delegation skipped — depth limit reached',
    );
    return null;
  }

  const statusEntriesByPlan = buildStatusEntries(activePlans);
  const statusEntries = statusEntriesByPlan.flat();
  const batchLabel = resolveBatchLabel(activePlans);

  const jobId = `${parentSessionId}:${Date.now()}:${randomUUID()}`;
  const publicId =
    requestedPublicId?.trim() ||
    `dlg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  try {
    createDelegationJob({
      publicId,
      internalId: jobId,
      parentSessionId,
      channelId,
      agentId,
      model: parentModel || null,
      taskCount: statusEntries.length,
      ackText: ackText || null,
    });
  } catch (err) {
    logger.error(
      {
        err,
        parentSessionId,
        channelId,
        publicId,
        internalId: jobId,
      },
      'Failed to create delegation job row',
    );
    return null;
  }

  const context: DelegationRunContext = {
    parentSessionId,
    childDepth,
    channelId,
    chatbotId,
    enableRag,
    agentId,
  };

  const accepted = enqueueDelegation({
    id: jobId,
    run: async () => {
      if (getDelegationJob(publicId)?.status === 'cancelled') return;
      markDelegationJobInProgress(publicId);
      const startedAt = Date.now();
      try {
        const statusText = (): string =>
          formatDelegationStatus({
            label: batchLabel,
            entries: statusEntries,
            parentModel,
          });
        const publishStatusText = (text: string): Promise<void> =>
          publishDelegationLifecycleMessage({
            parentSessionId,
            channelId,
            text,
            onProactiveMessage,
          });
        await publishStatusText(statusText());

        let statusPublishChain = Promise.resolve();
        const publishStatus = (): Promise<void> => {
          const text = statusText();
          statusPublishChain = statusPublishChain
            .catch(() => undefined)
            .then(() => publishStatusText(text));
          return statusPublishChain;
        };

        const entries = await withActiveChildContext(context, activePlans, () =>
          runDelegationPlans({
            plans: activePlans,
            context,
            statusEntriesByPlan,
            publishStatus,
          }),
        );

        if (entries.length === 0) {
          logger.warn(
            { parentSessionId, planCount: activePlans.length },
            'Delegation produced no entries',
          );
          failDelegationJob(publicId, 'no_delegation_entries');
          return;
        }

        const completion = formatDelegationCompletion({
          mode:
            activePlans.length === 1
              ? activePlans[0]?.mode || 'single'
              : 'parallel',
          label: batchLabel,
          entries,
          totalDurationMs: Date.now() - startedAt,
        });

        // A reset rotates the conversation; results belong to the old one.
        const parentSession = memoryService.getSessionById(parentSessionId);
        if (
          !parentSession ||
          parentSession.is_current === 0 ||
          getDelegationJob(publicId)?.status === 'cancelled'
        ) {
          failDelegationJob(publicId, 'parent_session_gone');
          return;
        }

        const replyStream =
          channelId === 'tui'
            ? createParentReplyStream({ parentSessionId, channelId })
            : null;
        let reply: Awaited<ReturnType<DelegationParentTurnRunner>> | null =
          null;
        try {
          reply = await runParentTurn({
            content: buildDelegationResultsMessage(completion.forLLM),
            onTextDelta: replyStream?.onTextDelta,
          });
        } catch (err) {
          logger.warn(
            { parentSessionId, channelId, err },
            'Delegation parent turn failed; using completion summary',
          );
        } finally {
          replyStream?.finish();
        }

        const replyText =
          reply?.status === 'success' ? reply.result?.trim() || '' : '';
        if (!replyText) {
          storeDelegationFallback({
            parentSessionId,
            channelId,
            agentId,
            text: completion.forUser,
            artifacts: completion.artifacts,
          });
        }
        const resultText = replyText || completion.forUser;
        const artifacts = replyText
          ? reply?.artifacts || completion.artifacts
          : completion.artifacts;
        if (
          !replyText ||
          (!isSilentReply(replyText) && !replyStream?.started())
        ) {
          if (channelId === 'web') {
            notifyWebSession(parentSessionId, 'turn', publicId);
          } else {
            await publishDelegationLifecycleMessage({
              parentSessionId,
              channelId,
              text: resultText,
              artifacts,
              onProactiveMessage,
            });
          }
        }
        completeDelegationJob(publicId, {
          resultText,
          resultDigest: completion.forLLM,
          artifacts,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failDelegationJob(publicId, message);
        logger.error(
          { err, parentSessionId, channelId, publicId, internalId: jobId },
          'Delegation batch failed',
        );
      } finally {
        const row = getDelegationJob(publicId);
        if (row?.status === 'queued' || row?.status === 'in_progress') {
          failDelegationJob(publicId, 'unknown_termination');
        }
      }
    },
  });
  if (!accepted) {
    failDelegationJob(publicId, 'delegation_disabled');
    return null;
  }
  return { publicId };
}

function resolveWaitingParentContext(
  sessionId: string,
): Omit<DelegationChildContext, 'sessionPrefix'> | null {
  const session = memoryService.getSessionById(sessionId);
  if (session) {
    const runtime = resolveAgentForRequest({ session });
    return {
      channelId: session.channel_id,
      chatbotId: runtime.chatbotId,
      enableRag: session.enable_rag !== 0,
      agentId: runtime.agentId,
      model: runtime.model,
    };
  }
  for (const context of activeChildContexts) {
    if (sessionId.startsWith(context.sessionPrefix)) return context;
  }
  return null;
}

/** Runs a `delegate` call to completion and returns what the parent reads. */
export async function runDelegationNow(params: {
  sessionId: string;
  effect: DelegationSideEffect;
  abortSignal?: AbortSignal;
}): Promise<{ result: string } | { error: string; status: number }> {
  const { sessionId, effect, abortSignal } = params;
  const parent = resolveWaitingParentContext(sessionId);
  if (!parent) return { error: 'Unknown delegating session.', status: 404 };
  const normalized = normalizeDelegationEffect(effect, parent.model);
  if (!normalized.plan) {
    return { error: normalized.error || 'Invalid delegation.', status: 400 };
  }
  const childDepth = extractDelegationDepth(sessionId) + 1;
  if (childDepth > PROACTIVE_DELEGATION_MAX_DEPTH) {
    return {
      error: `Delegation nesting depth limit (${PROACTIVE_DELEGATION_MAX_DEPTH}) reached.`,
      status: 400,
    };
  }
  const plans = [normalized.plan];
  const context: DelegationRunContext = {
    parentSessionId: sessionId,
    childDepth,
    channelId: parent.channelId,
    chatbotId: parent.chatbotId,
    enableRag: parent.enableRag,
    agentId: parent.agentId,
    abortSignal,
  };
  const startedAt = Date.now();
  const entries = await withActiveChildContext(context, plans, () =>
    runDelegationPlans({
      plans,
      context,
      statusEntriesByPlan: buildStatusEntries(plans),
    }),
  );
  return {
    result: formatDelegationCompletion({
      mode: normalized.plan.mode,
      label: normalized.plan.label,
      entries,
      totalDurationMs: Date.now() - startedAt,
    }).forLLM,
  };
}

export async function handleApiDelegate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    sessionId?: unknown;
    effect?: unknown;
  };
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (
    !sessionId ||
    !body.effect ||
    typeof body.effect !== 'object' ||
    Array.isArray(body.effect)
  ) {
    sendJson(res, 400, { error: 'Missing `sessionId` or `effect`.' });
    return;
  }
  // The parent turn was stopped or its worker died: stop the children too.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  const outcome = await runDelegationNow({
    sessionId,
    effect: body.effect as DelegationSideEffect,
    abortSignal: abort.signal,
  });
  if ('error' in outcome) {
    sendJson(res, outcome.status, { error: outcome.error });
    return;
  }
  sendJson(res, 200, { ok: true, result: outcome.result });
}
