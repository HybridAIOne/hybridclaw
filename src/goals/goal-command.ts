import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from '../gateway/gateway-types.js';
import { logger } from '../logger.js';
import type { Session } from '../types/session.js';
import { recordGoalAudit } from './goal-audit.js';
import {
  DEFAULT_GOAL_MAX_TURNS,
  type GoalSetterActor,
  resolveGoalThreadId,
  resumeThreadGoal,
  setThreadGoal,
  updateThreadGoalStatus,
} from './goal-manager.js';
import {
  clearScheduledGoalContinuation,
  type GoalContinuationContext,
  getGoalStatusForSession,
  scheduleGoalContinuation,
} from './goal-runtime.js';

export interface GoalCommandContext {
  session: Session;
  req: GatewayCommandRequest;
}

function plain(text: string): GatewayCommandResult {
  return { kind: 'plain', text };
}

function info(title: string, text: string): GatewayCommandResult {
  return { kind: 'info', title, text };
}

function error(title: string, text: string): GatewayCommandResult {
  return { kind: 'error', title, text };
}

function formatActor(req: GatewayCommandRequest): GoalSetterActor {
  const userId = req.userId?.trim();
  if (!userId) {
    logger.warn(
      { sessionId: req.sessionId, channelId: req.channelId },
      'Goal command invoked without user id',
    );
  }
  return {
    type: 'user',
    id: userId || 'unknown-user',
    ...(req.username?.trim() ? { name: req.username.trim() } : {}),
  };
}

function formatGoalStatus(session: Session): GatewayCommandResult {
  const goal = getGoalStatusForSession(session);
  if (!goal || goal.status === 'cleared') {
    return info('Goal Status', 'No standing goal is set for this thread.');
  }
  return info(
    'Goal Status',
    [
      `Status: ${goal.status}`,
      `Turns: ${goal.turnsUsed}/${goal.maxTurns}`,
      `Goal: ${goal.goalText}`,
      ...(goal.lastVerdict ? [`Last verdict: ${goal.lastVerdict}`] : []),
      ...(goal.lastReason ? [`Last reason: ${goal.lastReason}`] : []),
      ...(goal.pausedReason ? [`Paused reason: ${goal.pausedReason}`] : []),
    ].join('\n'),
  );
}

function parseGoalSetArgs(args: string[], isExplicitSet: boolean): string {
  return args
    .slice(isExplicitSet ? 2 : 1)
    .join(' ')
    .trim();
}

function buildContinuationContext(
  req: GatewayCommandRequest,
  session: Session,
): GoalContinuationContext {
  return {
    guildId: req.guildId,
    userId: req.userId?.trim() || 'goal-user',
    username: req.username ?? null,
    chatbotId: session.chatbot_id,
    model: session.model,
    enableRag: session.enable_rag === 1,
    onProactiveMessage: req.onProactiveMessage,
  };
}

export async function handleGoalCommand(
  context: GoalCommandContext,
): Promise<GatewayCommandResult> {
  const subcommand = (context.req.args[1] || '').trim().toLowerCase();
  const threadId = resolveGoalThreadId(context.session);
  const isControlSubcommand =
    subcommand === 'status' ||
    subcommand === 'info' ||
    subcommand === 'pause' ||
    subcommand === 'resume' ||
    subcommand === 'clear' ||
    subcommand === 'cancel';

  if (!isControlSubcommand) {
    const goalText = parseGoalSetArgs(context.req.args, subcommand === 'set');
    if (!goalText) {
      return error('Usage', 'Usage: `goal <text>` or `goal set <text>`');
    }
    const goal = setThreadGoal({
      threadId,
      goalText,
      maxTurns: DEFAULT_GOAL_MAX_TURNS,
      setterActor: formatActor(context.req),
      targetAgentId: context.session.agent_id,
    });
    recordGoalAudit({
      sessionId: context.session.id,
      type: 'goal.set',
      threadId,
      setterActor: goal.setterActor,
      targetAgentId: goal.targetAgentId,
      turnsUsed: goal.turnsUsed,
      maxTurns: goal.maxTurns,
    });
    scheduleGoalContinuation({
      session: context.session,
      initialPrompt: true,
      context: buildContinuationContext(context.req, context.session),
    });
    return plain(`Standing goal set for this thread (max ${goal.maxTurns}).`);
  }

  if (subcommand === 'status' || subcommand === 'info') {
    return formatGoalStatus(context.session);
  }

  if (subcommand === 'pause') {
    const goal = updateThreadGoalStatus({
      threadId,
      status: 'paused',
      reason: 'paused by user',
      verdict: 'paused',
    });
    if (!goal) return info('Goal Status', 'No standing goal is set.');
    clearScheduledGoalContinuation(context.session.id);
    recordGoalAudit({
      sessionId: context.session.id,
      type: 'goal.paused',
      threadId,
      setterActor: goal.setterActor,
      targetAgentId: goal.targetAgentId,
      turnsUsed: goal.turnsUsed,
      maxTurns: goal.maxTurns,
      reason: goal.pausedReason,
    });
    return plain('Standing goal paused.');
  }

  if (subcommand === 'resume') {
    const goal = resumeThreadGoal(threadId);
    if (!goal || goal.status !== 'active') {
      return info('Goal Status', 'No paused goal is available to resume.');
    }
    scheduleGoalContinuation({
      session: context.session,
      context: buildContinuationContext(context.req, context.session),
    });
    return plain(`Standing goal resumed (${goal.turnsUsed}/${goal.maxTurns}).`);
  }

  if (subcommand === 'clear' || subcommand === 'cancel') {
    const goal = updateThreadGoalStatus({
      threadId,
      status: 'cleared',
      reason: 'cleared by user',
      verdict: 'cleared',
      resetParseFailures: true,
    });
    if (!goal) return info('Goal Status', 'No standing goal is set.');
    clearScheduledGoalContinuation(context.session.id);
    recordGoalAudit({
      sessionId: context.session.id,
      type: 'goal.cleared',
      threadId,
      setterActor: goal.setterActor,
      targetAgentId: goal.targetAgentId,
      turnsUsed: goal.turnsUsed,
      maxTurns: goal.maxTurns,
      reason: 'cleared by user',
    });
    return plain('Standing goal cleared.');
  }

  return error(
    'Usage',
    'Usage: `goal <text>|set <text>|status|pause|resume|clear`',
  );
}
