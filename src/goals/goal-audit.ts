import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';

export type GoalAuditType =
  | 'goal.set'
  | 'goal.continued'
  | 'goal.paused'
  | 'goal.completed'
  | 'goal.cleared';

export function recordGoalAudit(params: {
  sessionId: string;
  type: GoalAuditType;
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
