import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from '../gateway/gateway-types.js';
import type { Session } from '../types/session.js';
import {
  type GoalSetterActor,
  resolveGoalThreadId,
  resumeThreadGoal,
  setThreadGoal,
  updateThreadGoalStatus,
} from './goal-manager.js';
import {
  clearScheduledGoalContinuation,
  getGoalStatusForSession,
  resolveDefaultGoalMaxTurns,
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
  return {
    type: 'user',
    id: req.userId?.trim() || 'unknown-user',
    ...(req.username?.trim() ? { name: req.username.trim() } : {}),
  };
}

function recordGoalCommandAudit(params: {
  session: Session;
  type: 'goal.set' | 'goal.paused' | 'goal.completed' | 'goal.cleared';
  threadId: string;
  setterActor: unknown;
  targetAgentId: string | null;
  turnsUsed: number;
  maxTurns: number;
  reason?: string | null;
}): void {
  recordAuditEvent({
    sessionId: params.session.id,
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

function parseGoalSetArgs(args: string[]): string {
  const subcommand = (args[1] || '').trim().toLowerCase();
  if (!subcommand || subcommand === 'set') {
    return args
      .slice(subcommand === 'set' ? 2 : 1)
      .join(' ')
      .trim();
  }
  return args.slice(1).join(' ').trim();
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

  if (!subcommand || subcommand === 'set' || !isControlSubcommand) {
    const goalText = parseGoalSetArgs(context.req.args);
    if (!goalText) {
      return error('Usage', 'Usage: `goal <text>` or `goal set <text>`');
    }
    const goal = setThreadGoal({
      threadId,
      goalText,
      maxTurns: resolveDefaultGoalMaxTurns(),
      setterActor: formatActor(context.req),
      targetAgentId: context.session.agent_id,
    });
    recordGoalCommandAudit({
      session: context.session,
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
      context: {
        guildId: context.req.guildId,
        userId: context.req.userId?.trim() || 'goal-user',
        username: context.req.username ?? null,
        chatbotId: context.session.chatbot_id,
        model: context.session.model,
        enableRag: context.session.enable_rag === 1,
        onProactiveMessage: context.req.onProactiveMessage,
      },
    });
    return plain(
      `Standing goal set for this thread (${goal.turnsUsed}/${goal.maxTurns}).`,
    );
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
    recordGoalCommandAudit({
      session: context.session,
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
      context: {
        guildId: context.req.guildId,
        userId: context.req.userId?.trim() || 'goal-user',
        username: context.req.username ?? null,
        chatbotId: context.session.chatbot_id,
        model: context.session.model,
        enableRag: context.session.enable_rag === 1,
        onProactiveMessage: context.req.onProactiveMessage,
      },
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
    recordGoalCommandAudit({
      session: context.session,
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
