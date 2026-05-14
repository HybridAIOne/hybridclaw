import {
  type PostTurnEvent,
  subscribePostTurnEvents,
} from '../agent/post-turn-events.js';
import { hasPendingApproval } from '../gateway/fullauto-runtime.js';
import type {
  GatewayChatRequest,
  GatewayChatResult,
} from '../gateway/gateway-types.js';
import { logger } from '../logger.js';
import type { Session } from '../types/session.js';
import { recordGoalAudit } from './goal-audit.js';
import { judgeGoalCompletion } from './goal-judge.js';
import {
  GOAL_PARSE_FAILURE_PAUSE_THRESHOLD,
  getActiveThreadGoal,
  getThreadGoal,
  recordThreadGoalTurn,
  resolveGoalThreadId,
  updateThreadGoalStatus,
} from './goal-manager.js';

export const GOAL_CONTINUATION_SOURCE = 'goal-continuation';
const MAX_GOAL_JUDGE_RESPONSE_CHARS = 8_000;

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
    initialPrompt: boolean;
    pendingAfterRun: boolean;
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

export function buildGoalContinuationPrompt(
  goalText: string,
  progress?: { turnsUsed: number; maxTurns: number },
): string {
  const lines = [
    '[Continuing toward your standing goal]',
    `Goal: ${goalText}`,
    '',
  ];
  if (progress) {
    const turnsUsed = Math.max(0, Math.floor(progress.turnsUsed));
    const maxTurns = Math.max(1, Math.floor(progress.maxTurns));
    lines.push(
      `Progress: ${turnsUsed} supervised turn(s) have already been used for this goal.`,
      `This is supervised step ${turnsUsed + 1} of at most ${maxTurns}.`,
      'Use this progress snapshot as authoritative; do not infer goal progress from earlier chat.',
      'Do not repeat completed steps. If the goal is an ordered sequence, produce the next item for this step.',
      '',
    );
  }
  lines.push(
    'Continue working toward this goal. Take the next concrete step. If you',
    'believe the goal is complete, state so explicitly and stop. If you are',
    'blocked, say so clearly and stop.',
  );
  return lines.join('\n');
}

export function buildGoalInitialPrompt(
  goalText: string,
  progress?: { maxTurns: number },
): string {
  const lines = ['[Starting standing goal]', `Goal: ${goalText}`, ''];
  if (progress) {
    lines.push(
      `This is supervised step 1 of at most ${Math.max(1, Math.floor(progress.maxTurns))}.`,
    );
  } else {
    lines.push('This is supervised step 1.');
  }
  lines.push(
    'Use this as a fresh goal start; do not infer goal progress from earlier chat.',
    'If the goal is an ordered sequence, produce only the first item for this step.',
    '',
    'Start working toward this goal. Take the first concrete step. If you',
    'believe the goal is complete, state so explicitly and stop. If you are',
    'blocked, say so clearly and stop.',
  );
  return lines.join('\n');
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

export function finishGoalContinuationRun(sessionId: string): void {
  const state = goalContinuationBySession.get(sessionId);
  if (!state) return;
  state.running = false;
  if (!state.pendingAfterRun) return;
  state.pendingAfterRun = false;
  runScheduledGoalContinuation(sessionId, state);
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
  goalContinuationBySession.delete(sessionId);
}

function runScheduledGoalContinuation(
  sessionId: string,
  state: {
    initialPrompt: boolean;
    pendingAfterRun: boolean;
    running: boolean;
    context: GoalContinuationContext;
  },
): void {
  if (goalContinuationBySession.get(sessionId) !== state) return;
  if (state.running) {
    state.pendingAfterRun = true;
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
}

export function scheduleGoalContinuation(params: {
  session: Session;
  context: GoalContinuationContext;
  initialPrompt?: boolean;
}): void {
  const threadId = resolveGoalThreadId(params.session);
  const goal = getActiveThreadGoal(threadId);
  if (!goal) return;
  const existing = goalContinuationBySession.get(params.session.id);
  if (existing?.running) {
    existing.initialPrompt = params.initialPrompt === true;
    existing.pendingAfterRun = true;
    existing.context = params.context;
    return;
  }
  const state = {
    initialPrompt: params.initialPrompt === true,
    pendingAfterRun: false,
    running: false,
    context: params.context,
  };
  goalContinuationBySession.set(params.session.id, state);
  runScheduledGoalContinuation(params.session.id, state);
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
  // R5.3 has not shipped a hard-stop emitter yet. Call this from that signal
  // once it exists so standing goals pause before scheduling another turn.
  pauseActiveGoalForSession({
    session,
    reason: 'agent budget hard-stop',
    verdict: 'agent_budget_hard_stop',
  });
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
    | 'abortSignal'
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

  if (params.req.abortSignal?.aborted) {
    pauseActiveGoalForSession({
      session: params.session,
      reason: 'user-interrupted',
      verdict: 'interrupted',
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

  const assistantResponse = String(params.result.result || '')
    .trim()
    .slice(0, MAX_GOAL_JUDGE_RESPONSE_CHARS);
  if (!assistantResponse) return;

  const verdict = await judgeGoalCompletion({
    sessionId: params.session.id,
    agentId: goal.targetAgentId || params.session.agent_id,
    threadId,
    goalText: goal.goalText,
    assistantResponse,
    fallbackModel: params.req.model ?? params.session.model,
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
