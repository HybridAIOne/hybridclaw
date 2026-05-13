import {
  type PostTurnEvent,
  subscribePostTurnEvents,
} from '../agent/post-turn-events.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import type {
  GatewayChatRequest,
  GatewayChatResult,
} from '../gateway/gateway-types.js';
import { logger } from '../logger.js';
import type { Session } from '../types/session.js';
import { judgeGoalCompletion } from './goal-judge.js';
import {
  DEFAULT_GOAL_MAX_TURNS,
  GOAL_PARSE_FAILURE_PAUSE_THRESHOLD,
  getActiveThreadGoal,
  getThreadGoal,
  recordThreadGoalTurn,
  resolveGoalThreadId,
  updateThreadGoalStatus,
} from './goal-manager.js';

export const GOAL_CONTINUATION_SOURCE = 'goal-continuation';

export interface GoalContinuationContext {
  guildId: string | null;
  userId: string;
  username: string | null;
  chatbotId?: string | null;
  model?: string | null;
  enableRag?: boolean;
  onProactiveMessage?: GatewayChatRequest['onProactiveMessage'];
}

const goalContinuationBySession = new Map<
  string,
  {
    timer: ReturnType<typeof setTimeout> | null;
    initialPrompt: boolean;
    running: boolean;
    context: GoalContinuationContext;
  }
>();

let runGoalContinuationHandler: ((sessionId: string) => Promise<void>) | null =
  null;
let goalPostTurnSubscriberRegistered = false;

export function setGoalContinuationRunHandler(
  handler: (sessionId: string) => Promise<void>,
): void {
  runGoalContinuationHandler = handler;
}

export function isGoalContinuationSource(source: string | undefined): boolean {
  return source === GOAL_CONTINUATION_SOURCE;
}

export function buildGoalContinuationPrompt(goalText: string): string {
  return [
    '[Continuing toward your standing goal]',
    `Goal: ${goalText}`,
    '',
    'Continue working toward this goal. Take the next concrete step. If you',
    'believe the goal is complete, state so explicitly and stop. If you are',
    'blocked, say so clearly and stop.',
  ].join('\n');
}

export function buildGoalInitialPrompt(goalText: string): string {
  return goalText;
}

export function getGoalContinuationContext(
  sessionId: string,
): GoalContinuationContext | null {
  return goalContinuationBySession.get(sessionId)?.context ?? null;
}

export function isGoalInitialPromptScheduled(sessionId: string): boolean {
  return goalContinuationBySession.get(sessionId)?.initialPrompt === true;
}

export function setGoalContinuationRunning(
  sessionId: string,
  running: boolean,
): void {
  const state = goalContinuationBySession.get(sessionId);
  if (state) state.running = running;
}

export function isGoalContinuationRunning(sessionId: string): boolean {
  return goalContinuationBySession.get(sessionId)?.running === true;
}

export function registerGoalPostTurnSubscriber(): void {
  if (goalPostTurnSubscriberRegistered) return;
  goalPostTurnSubscriberRegistered = true;
  subscribePostTurnEvents(async (event: PostTurnEvent) => {
    await maybeContinueGoalAfterTurn({
      session: event.session,
      req: event.req,
      channelType: event.channelType,
      result: event.result,
    });
  });
}

export function clearScheduledGoalContinuation(sessionId: string): void {
  const state = goalContinuationBySession.get(sessionId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  goalContinuationBySession.delete(sessionId);
}

function armGoalContinuationTimer(
  sessionId: string,
  state: {
    timer: ReturnType<typeof setTimeout> | null;
    initialPrompt: boolean;
    running: boolean;
    context: GoalContinuationContext;
  },
  delayMs: number,
): void {
  state.timer = setTimeout(() => {
    state.timer = null;
    if (goalContinuationBySession.get(sessionId) !== state) return;
    if (state.running) {
      armGoalContinuationTimer(sessionId, state, 10);
      return;
    }
    if (!runGoalContinuationHandler) {
      logger.error(
        { sessionId },
        'Goal continuation runner has not been configured',
      );
      return;
    }
    void runGoalContinuationHandler(sessionId);
  }, delayMs);
  if (typeof state.timer.unref === 'function') state.timer.unref();
}

export function scheduleGoalContinuation(params: {
  session: Session;
  context: GoalContinuationContext;
  delayMs?: number;
  initialPrompt?: boolean;
}): void {
  const threadId = resolveGoalThreadId(params.session);
  const goal = getActiveThreadGoal(threadId);
  if (!goal) return;
  const delayMs = Math.max(0, Math.floor(params.delayMs ?? 0));
  const existing = goalContinuationBySession.get(params.session.id);
  if (existing?.timer) clearTimeout(existing.timer);
  const state = {
    timer: null as ReturnType<typeof setTimeout> | null,
    initialPrompt: params.initialPrompt === true,
    running: existing?.running === true,
    context: params.context,
  };
  goalContinuationBySession.set(params.session.id, state);
  armGoalContinuationTimer(params.session.id, state, delayMs);
}

function recordGoalAudit(params: {
  sessionId: string;
  type: 'goal.continued' | 'goal.paused' | 'goal.completed' | 'goal.cleared';
  threadId: string;
  targetAgentId: string | null;
  setterActor: unknown;
  turnsUsed: number;
  maxTurns: number;
  reason?: string | null;
}): void {
  recordAuditEvent({
    sessionId: params.sessionId,
    runId: makeAuditRunId('goal'),
    event: {
      type: params.type,
      thread_id: params.threadId,
      setter_actor: params.setterActor,
      target_agent_id: params.targetAgentId,
      turns_used: params.turnsUsed,
      max_turns: params.maxTurns,
      ...(params.reason ? { reason: params.reason } : {}),
    },
  });
}

export function pauseActiveGoalForSession(params: {
  session: Session;
  reason: string;
  verdict?: string;
}): void {
  const threadId = resolveGoalThreadId(params.session);
  const goal = getActiveThreadGoal(threadId);
  if (!goal) return;
  const updated = updateThreadGoalStatus({
    threadId,
    status: 'paused',
    reason: params.reason,
    verdict: params.verdict || 'paused',
  });
  clearScheduledGoalContinuation(params.session.id);
  recordGoalAudit({
    sessionId: params.session.id,
    type: 'goal.paused',
    threadId,
    targetAgentId: updated?.targetAgentId ?? goal.targetAgentId,
    setterActor: updated?.setterActor ?? goal.setterActor,
    turnsUsed: updated?.turnsUsed ?? goal.turnsUsed,
    maxTurns: updated?.maxTurns ?? goal.maxTurns,
    reason: params.reason,
  });
}

export function pauseGoalForAgentBudgetHardStop(session: Session): void {
  pauseActiveGoalForSession({
    session,
    reason: 'agent budget hard-stop',
    verdict: 'agent_budget_hard_stop',
  });
}

export function resolveDefaultGoalMaxTurns(): number {
  return DEFAULT_GOAL_MAX_TURNS;
}

function hasPendingApproval(result: GatewayChatResult): boolean {
  return (result.toolExecutions || []).some(
    (execution) => execution.approvalDecision === 'required',
  );
}

export async function maybeContinueGoalAfterTurn(params: {
  session: Session;
  req: Pick<
    GatewayChatRequest,
    | 'source'
    | 'guildId'
    | 'userId'
    | 'username'
    | 'chatbotId'
    | 'model'
    | 'enableRag'
    | 'onProactiveMessage'
  >;
  channelType?: string | null;
  result: GatewayChatResult;
}): Promise<void> {
  const threadId = resolveGoalThreadId(params.session);
  const goal = getActiveThreadGoal(threadId);
  if (!goal) return;
  if (params.req.source === 'fullauto') return;

  if (!isGoalContinuationSource(params.req.source)) {
    if (
      params.channelType === 'scheduler' ||
      params.channelType === 'heartbeat'
    ) {
      return;
    }
    pauseActiveGoalForSession({
      session: params.session,
      reason: 'user-message',
      verdict: 'preempted',
    });
    return;
  }

  if (hasPendingApproval(params.result)) {
    pauseActiveGoalForSession({
      session: params.session,
      reason: 'pending approval',
      verdict: 'paused',
    });
    return;
  }

  if (params.result.status === 'error') {
    pauseActiveGoalForSession({
      session: params.session,
      reason: params.result.error || 'gateway error',
      verdict: 'error',
    });
    return;
  }

  const assistantResponse = String(params.result.result || '').trim();
  if (!assistantResponse) return;

  const verdict = await judgeGoalCompletion({
    sessionId: params.session.id,
    agentId: goal.targetAgentId || params.session.agent_id,
    threadId,
    goalText: goal.goalText,
    assistantResponse,
  });
  const updated = recordThreadGoalTurn({
    threadId,
    verdict: verdict.parseFailure
      ? 'parse_failure'
      : verdict.done
        ? 'done'
        : 'active',
    reason: verdict.reason,
    parseFailure: verdict.parseFailure,
  });
  if (!updated || updated.status !== 'active') return;

  if (
    verdict.parseFailure &&
    updated.consecutiveParseFailures >= GOAL_PARSE_FAILURE_PAUSE_THRESHOLD
  ) {
    const paused = updateThreadGoalStatus({
      threadId,
      status: 'paused',
      reason: `goal judge parse failed ${updated.consecutiveParseFailures} times`,
      verdict: 'parse_failure',
    });
    recordGoalAudit({
      sessionId: params.session.id,
      type: 'goal.paused',
      threadId,
      targetAgentId: paused?.targetAgentId ?? updated.targetAgentId,
      setterActor: paused?.setterActor ?? updated.setterActor,
      turnsUsed: paused?.turnsUsed ?? updated.turnsUsed,
      maxTurns: paused?.maxTurns ?? updated.maxTurns,
      reason: paused?.pausedReason,
    });
    clearScheduledGoalContinuation(params.session.id);
    return;
  }

  if (!verdict.parseFailure && verdict.done) {
    const done = updateThreadGoalStatus({
      threadId,
      status: 'done',
      reason: verdict.reason,
      verdict: 'done',
      resetParseFailures: true,
    });
    recordGoalAudit({
      sessionId: params.session.id,
      type: 'goal.completed',
      threadId,
      targetAgentId: done?.targetAgentId ?? updated.targetAgentId,
      setterActor: done?.setterActor ?? updated.setterActor,
      turnsUsed: done?.turnsUsed ?? updated.turnsUsed,
      maxTurns: done?.maxTurns ?? updated.maxTurns,
      reason: verdict.reason,
    });
    clearScheduledGoalContinuation(params.session.id);
    return;
  }

  if (updated.turnsUsed >= updated.maxTurns) {
    const paused = updateThreadGoalStatus({
      threadId,
      status: 'paused',
      reason: 'turn budget reached',
      verdict: 'turn_budget',
      resetParseFailures: true,
    });
    recordGoalAudit({
      sessionId: params.session.id,
      type: 'goal.paused',
      threadId,
      targetAgentId: paused?.targetAgentId ?? updated.targetAgentId,
      setterActor: paused?.setterActor ?? updated.setterActor,
      turnsUsed: paused?.turnsUsed ?? updated.turnsUsed,
      maxTurns: paused?.maxTurns ?? updated.maxTurns,
      reason: paused?.pausedReason,
    });
    clearScheduledGoalContinuation(params.session.id);
    return;
  }

  scheduleGoalContinuation({
    session: params.session,
    context: {
      guildId: params.req.guildId,
      userId: params.req.userId,
      username: params.req.username ?? null,
      chatbotId: params.req.chatbotId ?? params.session.chatbot_id,
      model: params.req.model ?? params.session.model,
      enableRag: params.req.enableRag ?? params.session.enable_rag === 1,
      onProactiveMessage: params.req.onProactiveMessage,
    },
  });
  recordGoalAudit({
    sessionId: params.session.id,
    type: 'goal.continued',
    threadId,
    targetAgentId: updated.targetAgentId,
    setterActor: updated.setterActor,
    turnsUsed: updated.turnsUsed,
    maxTurns: updated.maxTurns,
    reason: verdict.reason,
  });
}

export function getGoalStatusForSession(
  session: Session,
): ReturnType<typeof getThreadGoal> {
  return getThreadGoal(resolveGoalThreadId(session));
}
